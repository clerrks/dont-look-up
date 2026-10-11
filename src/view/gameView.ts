import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CITIES } from '../data/cities';
import { asteroidAt, earthAt, orbitPath, phaseFor, type Elements, type OrbitPhase } from '../sim/orbit';
import type { Corridor, Effects, Scenario } from '../sim/model';
import { latLonToVec3, makeLandMask, paintEarth } from './geo';
import { audio } from '../audio';
import { Burst, FireTail, Ribbon, Streak, Trail, ease, glowSprite, glowTexture, randomCone } from './fx';
import { rockTemplate, shipTemplate, type ShipKey } from './models';
import { framePath, groundPointOf, type PathFrame } from './path';

export interface MapLabel {
  id: string;
  text: string;
  lat: number;
  lon: number;
  tone: 'risk' | 'plan' | 'safe';
}

export interface MissionView {
  id: string;
  kind: 'kinetic' | 'tractor' | 'nuke' | 'probe';
  tier?: 'light' | 'standard' | 'heavy';
  p: number;
  arrived: boolean;
  /** the id of the impactor whose debris will destroy this tractor */
  doomedBy?: string;
  /** how far this strike moves the asteroid's path, in Earth radii in the impact plane */
  shift?: { xi: number; zeta: number };
}

export interface PickInfo {
  id: string;
  kind: 'asteroid' | 'kinetic' | 'tractor' | 'nuke' | 'probe';
  x: number;
  y: number;
}

const hoverKind = (k: string) => k === 'tractor' || k === 'probe';

export interface OutcomeOpts {
  hit: boolean;
  site: { lat: number; lon: number } | null;
  effects: Effects;
  missRe: number;
  missKm: number;
  sc: Scenario;
  title: string;
  subtitle: string;
  base: { xi: number; zeta: number; tau: number };
  final: { xi: number; zeta: number; tau: number };
  deflected: boolean;
  fragmented: boolean;
  /** places inside the damage zones; level 0 = total destruction, 1 = severe blast, 2 = damage */
  cities?: { lat: number; lon: number; level: number }[];
}

const COL = {
  bg: 0x05070f,
  ocean: ['#07101f', '#0d1b33'] as [string, string],
  land: '#243d62',
  coast: '#7aa5cf',
  grid: 'rgba(140,180,225,0.13)',
  sun: 0xffd9a0,
  earthDot: 0x7fd6ff,
  asteroid: 0xffb347,
  zoneA: 0xff4d3a,
  zoneB: 0xff8a3d,
  zoneC: 0xffc15c,
};

const UP = new THREE.Vector3(0, 1, 0);

const POINT_VERT = /* glsl */ `
  attribute float aAlpha;
  varying float vA;
  uniform float uScale;
  void main() {
    vA = aAlpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aAlpha < 0.01 ? 0.0 : uScale * (1.6 + 2.6 * aAlpha) / -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;
const POINT_FRAG = /* glsl */ `
  varying float vA;
  uniform float uGain;
  uniform vec3 uCool;
  uniform vec3 uHot;
  void main() {
    if (vA < 0.01) discard;
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    if (d > 0.5) discard;
    float soft = smoothstep(0.5, 0.05, d);
    vec3 col = mix(uCool, uHot, smoothstep(0.55, 1.0, vA));
    gl_FragColor = vec4(col, soft * (0.18 + 0.62 * vA) * uGain);
  }
`;

const N_SAMPLES = 4200;

/** A point cloud whose points glide to their new places instead of jumping. */
class Cloud {
  readonly geo = new THREE.BufferGeometry();
  readonly pts: THREE.Points;
  private tPos = new Float32Array(N_SAMPLES * 3);
  private tAl = new Float32Array(N_SAMPLES);
  private moving = false;
  private radius: number;

  constructor(mat: THREE.ShaderMaterial, radius: number) {
    this.radius = radius;
    this.geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N_SAMPLES * 3), 3));
    this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(N_SAMPLES), 1));
    this.pts = new THREE.Points(this.geo, mat);
    this.pts.frustumCulled = false;
  }

  set(c: Corridor | null, instant = false) {
    const pos = this.geo.getAttribute('position') as THREE.BufferAttribute;
    const al = this.geo.getAttribute('aAlpha') as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    if (!c) this.tAl.fill(0);
    else {
      for (let i = 0; i < N_SAMPLES; i++) {
        latLonToVec3(c.lat[i], c.lon[i], this.radius, v);
        this.tPos[i * 3] = v.x; this.tPos[i * 3 + 1] = v.y; this.tPos[i * 3 + 2] = v.z;
        this.tAl[i] = c.alpha[i];
      }
      const gain = Math.max(0.4, Math.min(1.1, 1800 / Math.max(1, this.tAl.reduce((n, a) => n + (a > 0 ? 1 : 0), 0))));
      (this.pts.material as THREE.ShaderMaterial).uniforms.uGain.value = gain;
    }
    if (instant) {
      (pos.array as Float32Array).set(this.tPos); (al.array as Float32Array).set(this.tAl);
      pos.needsUpdate = true; al.needsUpdate = true; this.moving = false;
    } else this.moving = true;
    this.geo.setDrawRange(0, N_SAMPLES);
  }

  update(dt: number) {
    if (!this.moving) return;
    const pos = this.geo.getAttribute('position') as THREE.BufferAttribute;
    const al = this.geo.getAttribute('aAlpha') as THREE.BufferAttribute;
    const pa = pos.array as Float32Array, aa = al.array as Float32Array;
    const k = 1 - Math.exp(-dt * 9);
    let moved = 0;
    for (let i = 0; i < N_SAMPLES; i++) {
      const a0 = aa[i], a1 = this.tAl[i];
      // a point that is not visible yet appears where it belongs; one that is visible glides
      if (a0 < 0.02 && a1 > 0) { pa[i * 3] = this.tPos[i * 3]; pa[i * 3 + 1] = this.tPos[i * 3 + 1]; pa[i * 3 + 2] = this.tPos[i * 3 + 2]; }
      else if (a1 > 0 || a0 > 0.02) {
        for (let j = 0; j < 3; j++) { const d = this.tPos[i * 3 + j] - pa[i * 3 + j]; pa[i * 3 + j] += d * k; moved += Math.abs(d); }
      }
      const da = a1 - a0; aa[i] = a0 + da * k; moved += Math.abs(da);
    }
    pos.needsUpdate = true; al.needsUpdate = true;
    if (moved < 0.02) { (pos.array as Float32Array).set(this.tPos); (al.array as Float32Array).set(this.tAl); this.moving = false; }
  }
}

interface ShipObj {
  holder: THREE.Group;
  body: THREE.Group;
  outline: THREE.Object3D | null;
  trail: Trail;
  beam: THREE.Line | null;
  kind: 'kinetic' | 'tractor' | 'nuke' | 'probe';
  struck: boolean;
  cut: boolean;
  gone: boolean;
  size: number;
}

export class GameView {
  readonly canvas: HTMLCanvasElement;
  readonly isLand: (lat: number, lon: number) => boolean;
  /** hover / click on the asteroid or a spacecraft while the clock is stopped */
  onHover: ((info: PickInfo | null) => void) | null = null;
  onPick: ((info: PickInfo) => void) | null = null;
  private renderer: THREE.WebGLRenderer;
  private host: HTMLElement;
  private labelHost: HTMLElement;
  private mode: 'earth' | 'orbit' = 'earth';
  private raf = 0;
  private disposed = false;
  private reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  private sc!: Scenario;

  // earth scene
  private eScene = new THREE.Scene();
  private eCam: THREE.PerspectiveCamera;
  private eCtl: OrbitControls;
  private earth: THREE.Mesh;
  private corridorCloud: Cloud;
  private corridor: THREE.Points;
  private fx = new THREE.Group();
  private rock = new THREE.Group();
  private rockBody = new THREE.Group();
  private rockOutline: THREE.Object3D | null = null;
  private rockGlow: THREE.Sprite;
  private rockTail = new FireTail(220);
  // where the asteroid has actually been, drawn as a solid line behind it
  private hist: THREE.Vector3[] = [];
  private histLine: Streak;
  private histGlow: Streak;
  private histDirty = false;
  private histBuiltAt = 0;
  private pathCenter = { xi: 0, zeta: 0, tau: 0 };
  private pathLine: Ribbon;
  private oldLine: Ribbon;
  private newLine: Ribbon;
  private ribbons = new Set<Ribbon>();
  private frags = new THREE.Group();
  private fragOffsets: THREE.Vector3[] = [];
  private fragmented = false;
  private labels: { el: HTMLElement; vec: THREE.Vector3; data: MapLabel }[] = [];
  private labels3: { el: HTMLElement; vec: THREE.Vector3; surface: boolean }[] = [];
  private idle = 0;
  private idleClock = 0;
  private spin = true;
  private focusAnim: { from: THREE.Vector3; to: THREE.Vector3; t: number } | null = null;

  // the asteroid's path: sky direction R and sideways offset O, eased toward the latest best estimate
  private pathR = new THREE.Vector3(0, 0, 1);
  private pathO = new THREE.Vector3();
  private pathTR = new THREE.Vector3(0, 0, 1);
  private pathTO = new THREE.Vector3();
  private pathFrame: PathFrame | null = null;
  private bias = new THREE.Vector3();
  private biasTarget = new THREE.Vector3();
  private biasOwners = new Set<string>();
  private biasVecs = new Map<string, THREE.Vector3>();
  private motion = 0; // how fast game time is running, in years per second
  private rockSize = 0.05;
  /** only the first couple of strikes get a cutscene; the rest of a big volley just lands */
  private strikeCuts = 0;
  private rockS = 1.95;
  private rockJolt = 0;

  private ships = new Map<string, ShipObj>();
  private missionData: MissionView[] = [];
  private anims: ((dt: number) => boolean)[] = [];
  private follow = false;
  private followed = false;
  private camAnim: { fromPos: THREE.Vector3; toPos: THREE.Vector3; fromTar: THREE.Vector3; toTar: THREE.Vector3; t: number; dur: number; live?: boolean; onDone?: () => void } | null = null;
  private camScript: { fn: (dt: number) => boolean; ownsRock: boolean } | null = null;
  private shake = 0;
  private minD = 1.5;
  private maxD = 7;
  private leadFrac = 1;
  private busyCut = false;
  private gameOver = false;
  private cinematics = true;
  private baseFov = 38;
  private cine!: { root: HTMLElement; cap: HTMLElement; count: HTMLElement; flash: HTMLElement; title: HTMLElement };
  private cutShip: ShipObj | null = null;

  // picking
  private interactive = false;
  private hoverId: string | null = null;
  private raycaster = new THREE.Raycaster();
  private hoverGlow: THREE.Sprite;
  private downAt: { x: number; y: number } | null = null;

  // orbit scene
  private oScene = new THREE.Scene();
  private oCam: THREE.PerspectiveCamera;
  private oCtl: OrbitControls;
  private oEarth!: THREE.Mesh;
  private oRock!: THREE.Mesh;
  private oPhase: OrbitPhase | null = null;
  private oElements: Elements | null = null;
  private oObjects = new THREE.Group();

  constructor(host: HTMLElement, labelHost: HTMLElement) {
    this.host = host;
    this.labelHost = labelHost;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(COL.bg, 1);
    this.canvas = this.renderer.domElement;
    this.canvas.className = 'view-canvas';
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', 'Interactive 3D view. Drag to rotate, scroll or pinch to zoom.');
    host.appendChild(this.canvas);
    this.buildCineOverlay();

    this.isLand = makeLandMask();

    // ---- earth scene
    this.eCam = new THREE.PerspectiveCamera(38, 1, 0.02, 400);
    this.eCam.position.set(0.4, 1.3, 3.5);
    this.eScene.add(new THREE.AmbientLight(0xaabbdd, 1.15));
    const key = new THREE.DirectionalLight(0xdfeaff, 1.6);
    key.position.set(-3, 2.5, 3);
    this.eScene.add(key);
    const tex = new THREE.CanvasTexture(paintEarth(4096, 2048, { ocean: COL.ocean, land: COL.land, coast: COL.coast, grid: COL.grid }));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    this.earth = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 64), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, metalness: 0 }));
    this.eScene.add(this.earth);
    this.eScene.add(this.makeAtmosphere());
    this.eScene.add(this.makeStars());
    this.addCityDots();

    this.corridorCloud = new Cloud(
      new THREE.ShaderMaterial({
        vertexShader: POINT_VERT, fragmentShader: POINT_FRAG, transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: { uScale: { value: 6 }, uGain: { value: 1 }, uCool: { value: new THREE.Color(1.0, 0.62, 0.18) }, uHot: { value: new THREE.Color(1.0, 0.93, 0.78) } },
      }), 1.004);
    this.corridor = this.corridorCloud.pts;
    this.eScene.add(this.corridor);
    this.eScene.add(this.fx);

    // the asteroid: a placeholder lump until the model from the pack arrives
    this.rockBody.add(this.placeholderRock());
    this.rock.add(this.rockBody);
    this.rock.add(this.hitProxy(0.78));
    this.rock.userData.pickId = 'asteroid';
    this.rock.scale.setScalar(this.rockSize);
    this.eScene.add(this.rock, this.frags);
    this.rockGlow = glowSprite(0xff8a3d, 0.2, 0.0);
    this.hoverGlow = glowSprite(0xffd24a, 0.3, 0.0);
    this.eScene.add(this.rockGlow, this.rockTail.points, this.hoverGlow);
    this.histGlow = new Streak(COL.asteroid, 7, 0.22);
    this.histLine = new Streak(0xffd48a, 2.4, 0.95);
    this.eScene.add(this.histGlow, this.histLine);
    const mkLine = (color: number, opacity: number, width: number, dash: number, gap: number) => { const r = new Ribbon(color, opacity, width, dash, gap); this.ribbons.add(r); return r; };
    this.pathLine = mkLine(COL.asteroid, 0.7, 2.2, 0.1, 0.08);
    this.oldLine = mkLine(0xff5a4a, 0.95, 3, 0.14, 0.09);
    this.newLine = mkLine(0x66f0b0, 0.95, 3, 0.14, 0.09);
    this.oldLine.visible = false; this.newLine.visible = false;
    this.eScene.add(this.pathLine, this.oldLine, this.newLine);

    this.eCtl = new OrbitControls(this.eCam, this.canvas);
    this.eCtl.enableDamping = true;
    this.eCtl.dampingFactor = 0.08;
    this.eCtl.minDistance = 1.5;
    this.eCtl.maxDistance = 7;
    this.eCtl.enablePan = false;
    this.eCtl.rotateSpeed = 0.55;
    this.eCtl.zoomSpeed = 0.7;
    this.eCtl.addEventListener('start', () => { this.spin = false; this.idle = 0; this.focusAnim = null; });
    this.eCtl.addEventListener('end', () => { this.idle = 0; });

    this.canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.canvas.addEventListener('pointerleave', () => this.setHover(null, 0, 0));
    this.canvas.addEventListener('pointerdown', (e) => { this.downAt = { x: e.clientX, y: e.clientY }; });
    this.canvas.addEventListener('pointerup', (e) => this.onPointerUp(e));

    // ---- orbit scene
    this.oCam = new THREE.PerspectiveCamera(40, 1, 0.01, 200);
    this.oCam.position.set(0, 2.4, 3.2);
    this.oCtl = new OrbitControls(this.oCam, this.canvas);
    this.oCtl.enableDamping = true;
    this.oCtl.dampingFactor = 0.08;
    this.oCtl.enablePan = false;
    this.oCtl.minDistance = 0.8;
    this.oCtl.maxDistance = 14;
    this.oCtl.rotateSpeed = 0.6;
    this.oCtl.enabled = false;
    this.buildOrbitStatic();
    this.oScene.add(this.oObjects);

    const ro = new ResizeObserver(() => this.resize());
    ro.observe(host);
    this.resize();
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  // ------------------------------------------------------------ builders

  private hitProxy(radius: number): THREE.Mesh {
    const m = new THREE.Mesh(new THREE.SphereGeometry(radius, 10, 8), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
    m.userData.proxy = true;
    return m;
  }

  private buildCineOverlay() {
    const root = document.createElement('div');
    root.className = 'cine';
    root.setAttribute('aria-hidden', 'true');
    root.innerHTML = '<div class="bar top"></div><div class="bar bottom"></div><div class="cine-count"></div><div class="cine-cap"></div><div class="cine-title"></div><div class="cine-flash"></div>';
    this.host.appendChild(root);
    this.cine = {
      root,
      cap: root.querySelector('.cine-cap')!,
      count: root.querySelector('.cine-count')!,
      flash: root.querySelector('.cine-flash')!,
      title: root.querySelector('.cine-title')!,
    };
  }

  private makeAtmosphere(): THREE.Mesh {
    const m = new THREE.ShaderMaterial({
      transparent: true, side: THREE.BackSide, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `varying vec3 vN; varying vec3 vV; void main(){ vN = normalize(normalMatrix*normal); vec4 mv = modelViewMatrix*vec4(position,1.0); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }`,
      fragmentShader: `varying vec3 vN; varying vec3 vV; void main(){ gl_FragColor = vec4(0.30,0.58,1.0,1.0) * pow(clamp(-dot(vN, vV) * 2.1, 0.0, 1.0), 2.4) * 0.55; }`,
    });
    return new THREE.Mesh(new THREE.SphereGeometry(1.14, 64, 48), m);
  }

  private makeStars(): THREE.Points {
    const n = 1600;
    const pos = new Float32Array(n * 3);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < n; i++) {
      const u = rnd() * 2 - 1, th = rnd() * Math.PI * 2, s = Math.sqrt(1 - u * u);
      const r = 90 + rnd() * 40;
      pos.set([r * s * Math.cos(th), r * u, r * s * Math.sin(th)], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    return new THREE.Points(g, new THREE.PointsMaterial({ color: 0x9fb4d8, size: 0.22, sizeAttenuation: true, transparent: true, opacity: 0.75, depthWrite: false }));
  }

  private addCityDots() {
    const pos = new Float32Array(CITIES.length * 3);
    CITIES.forEach((c, i) => latLonToVec3(c.lat, c.lon, 1.002).toArray(pos, i * 3));
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.eScene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0x9fe3ff, size: 0.014, sizeAttenuation: true, transparent: true, opacity: 0.85, depthWrite: false })));
  }

  private placeholderRock(): THREE.Mesh {
    const geo = new THREE.IcosahedronGeometry(0.5, 1);
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const v = new THREE.Vector3().fromBufferAttribute(p, i);
      v.multiplyScalar(1 + 0.2 * Math.sin(v.x * 7 + 1.3) * Math.cos(v.y * 6));
      p.setXYZ(i, v.x, v.y, v.z);
    }
    geo.computeVertexNormals();
    return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x9a8268, roughness: 1, flatShading: true, emissive: 0x24160a, emissiveIntensity: 0.7 }));
  }

  private buildOrbitStatic() {
    const sun = new THREE.Mesh(new THREE.SphereGeometry(0.07, 32, 24), new THREE.MeshBasicMaterial({ color: COL.sun }));
    this.oScene.add(sun);
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 32, 24),
      new THREE.MeshBasicMaterial({ color: 0xffb257, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.oScene.add(halo);
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 180; i++) { const a = (i / 180) * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a), 0, -Math.sin(a))); }
    this.oScene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x4f86ad, transparent: true, opacity: 0.6 })));
    this.oEarth = new THREE.Mesh(new THREE.SphereGeometry(0.035, 24, 16), new THREE.MeshBasicMaterial({ color: COL.earthDot }));
    this.oScene.add(this.oEarth);
    this.oRock = new THREE.Mesh(new THREE.SphereGeometry(0.026, 16, 12), new THREE.MeshBasicMaterial({ color: COL.asteroid }));
    this.oScene.add(this.oRock);
  }

  // ------------------------------------------------------------ public API

  setScenario(sc: Scenario) {
    this.sc = sc;
    this.leadFrac = 1;
    this.gameOver = false;
    this.busyCut = false;
    this.camScript = null;
    this.cutShip = null;
    this.shake = 0;
    this.interactive = false;
    this.hoverId = null;
    this.fragmented = false;
    this.frags.clear();
    this.fragOffsets = [];
    this.follow = false; this.followed = false; this.camAnim = null; this.minD = 1.5; this.maxD = 7;
    this.eCtl.enabled = true;
    this.eCtl.minDistance = this.minD; this.eCtl.maxDistance = this.maxD;
    this.eCam.fov = this.baseFov; this.eCam.updateProjectionMatrix();
    this.bias.set(0, 0, 0); this.biasTarget.set(0, 0, 0); this.biasOwners.clear(); this.biasVecs.clear();
    this.rockS = 1.95; this.motion = 0;
    this.rockJolt = 0;
    this.hist = []; this.histDirty = true;
    this.strikeCuts = 0;
    this.pathCenter = { xi: sc.est0.xi, zeta: sc.est0.zeta, tau: sc.est0.tau };
    this.clearFx();
    this.clearShips();
    this.cineOff();
    this.corridor.visible = true;
    this.rock.visible = true;
    this.pathLine.visible = true;
    this.oldLine.visible = false; this.newLine.visible = false;
    // the asteroid's path starts from the first best estimate
    const f = framePath(sc, sc.est0.xi, sc.est0.zeta, sc.est0.tau);
    this.pathFrame = f;
    this.pathR.copy(f.R); this.pathO.copy(f.O); this.pathTR.copy(f.R); this.pathTO.copy(f.O);
    // pick a rock from the pack
    void rockTemplate(sc.seed).then((tpl) => {
      this.rockBody.clear();
      const m = this.instance(tpl);
      m.rotation.set((sc.seed % 11) * 0.5, (sc.seed % 13) * 0.45, 0);
      this.rockBody.add(m);
      this.rockOutline = null;
    }).catch(() => undefined);
    this.frameShot(4.1, true);
    this.oElements = sc.orbit ?? null;
    this.oObjects.clear();
    if (sc.orbit) {
      this.oPhase = phaseFor(sc.orbit, sc.leadYears);
      const pts = orbitPath(sc.orbit).map(([x, y, z]) => new THREE.Vector3(x, z, -y));
      this.oObjects.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: COL.asteroid, transparent: true, opacity: 0.85 })));
      const q = sc.orbit.a * (1 + sc.orbit.e);
      const dist = Math.max(2.4, Math.min(9, q * 1.9));
      this.oCam.position.set(0, dist * 0.7, dist);
      this.oCtl.target.set(0, 0, 0);
    } else {
      this.oPhase = null;
    }
    this.oRock.visible = !!sc.orbit;
    this.setTime(0, sc);
    this.spin = false;
  }

  /** A fresh copy of a model with its own materials, so tints and highlights stay on one object. */
  private instance(tpl: THREE.Group): THREE.Group {
    const g = tpl.clone(true);
    g.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.material = (m.material as THREE.Material).clone();
    });
    return g;
  }

  setMode(m: 'earth' | 'orbit') {
    this.mode = m;
    this.eCtl.enabled = m === 'earth' && !this.camScript;
    this.oCtl.enabled = m === 'orbit';
    for (const l of this.labels) l.el.style.display = m === 'earth' ? '' : 'none';
    if (m !== 'earth') this.setHover(null, 0, 0);
  }
  getMode() { return this.mode; }

  setTime(t: number, sc: Scenario) {
    this.leadFrac = Math.max(0, 1 - t / sc.leadYears);
    if (this.oPhase && this.oElements) {
      const [ax, ay, az] = asteroidAt(this.oElements, this.oPhase, t);
      this.oRock.position.set(ax, az, -ay);
      const [ex, ey, ez] = earthAt(this.oPhase, t);
      this.oEarth.position.set(ex, ez, -ey);
    }
  }

  /** The cloud of landing spots, and with it the straight path the asteroid is on. */
  setCorridor(c: Corridor, instant = false) {
    this.corridorCloud.set(c, instant);
    const st = c.state.center;
    this.pathCenter = { xi: st.xi, zeta: st.zeta, tau: st.tau };
    const f = framePath(this.sc, st.xi, st.zeta, st.tau);
    this.pathFrame = f;
    this.pathTR.copy(f.R); this.pathTO.copy(f.O);
    if (instant) { this.pathR.copy(f.R); this.pathO.copy(f.O); }
  }

  /** How fast game time is running (years per second). The fire trail only shows while it is moving. */
  setMotion(rate: number) { this.motion = rate; }

  setInteractive(on: boolean) {
    this.interactive = on;
    if (!on) this.setHover(null, 0, 0);
  }

  setLabels(labels: MapLabel[]) {
    const keep = new Map(this.labels.map((l) => [l.data.id, l]));
    const next: typeof this.labels = [];
    for (const d of labels) {
      let l = keep.get(d.id);
      if (l) keep.delete(d.id);
      else {
        const el = document.createElement('div');
        el.className = 'map-label';
        this.labelHost.appendChild(el);
        l = { el, vec: new THREE.Vector3(), data: d };
      }
      l.data = d;
      l.el.textContent = d.text;
      l.el.dataset.tone = d.tone;
      latLonToVec3(d.lat, d.lon, 1.01, l.vec);
      next.push(l);
    }
    for (const l of keep.values()) l.el.remove();
    this.labels = next;
  }

  private addLabel3(vec: THREE.Vector3, text: string, cls = '', surface = false) {
    const el = document.createElement('div');
    el.className = `map-label big ${cls}`;
    el.textContent = text;
    this.labelHost.appendChild(el);
    this.labels3.push({ el, vec: vec.clone(), surface });
  }

  private clearLabels3() {
    for (const l of this.labels3) l.el.remove();
    this.labels3 = [];
  }

  /**
   * Put the camera where the whole approach reads at a glance: the planet with the dots under the path,
   * and the rock coming in from the side along its line.
   */
  frameShot(dist = 4.1, instant = false) {
    if (this.gameOver || this.camScript || !this.pathFrame) return;
    const f = this.pathFrame;
    const aim = groundPointOf(f, this.pathTO) ?? f.R.clone();
    const side = new THREE.Vector3().crossVectors(aim, UP);
    if (side.lengthSq() < 1e-4) side.set(1, 0, 0);
    side.normalize();
    // a tall, narrow stage (a phone) needs the camera closer to the approach line or the rock starts off-screen
    const off = this.host.clientWidth / Math.max(1, this.host.clientHeight) < 0.95 ? 0.3 : 0.82;
    const camDir = aim.clone().normalize().multiplyScalar(Math.cos(off)).addScaledVector(side, Math.sin(off)).addScaledVector(UP, 0.2).normalize();
    const to = camDir.multiplyScalar(dist);
    if (instant) {
      this.eCam.position.copy(to);
      this.eCtl.target.set(0, 0, 0);
    } else {
      this.focusAnim = { from: this.eCam.position.clone(), to, t: 0 };
    }
    this.spin = false;
  }

  focus(lat: number, lon: number, dist = 2.9) {
    if (this.gameOver || this.camScript) return;
    const to = latLonToVec3(lat, lon, 1).multiplyScalar(dist);
    this.focusAnim = { from: this.eCam.position.clone(), to, t: 0 };
    this.spin = false;
  }

  zoom(factor: number) {
    const cam = this.mode === 'earth' ? this.eCam : this.oCam;
    const ctl = this.mode === 'earth' ? this.eCtl : this.oCtl;
    const dir = cam.position.clone().sub(ctl.target);
    const d = Math.min(ctl.maxDistance, Math.max(ctl.minDistance, dir.length() * factor));
    cam.position.copy(ctl.target).add(dir.setLength(d));
  }

  clearFx() {
    while (this.fx.children.length) {
      const o = this.fx.children[0] as any;
      this.fx.remove(o);
      o.geometry?.dispose?.();
      o.material?.dispose?.();
    }
    this.anims = [];
    this.clearLabels3();
  }

  private clearShips() {
    for (const o of this.ships.values()) this.disposeShip(o);
    this.ships.clear();
  }

  private disposeShip(o: ShipObj) {
    this.eScene.remove(o.holder, o.trail.points);
    o.trail.dispose();
    if (o.beam) { this.eScene.remove(o.beam); o.beam.geometry.dispose(); }
  }

  showCorridor(on: boolean) { this.corridor.visible = on; }

  isFollowing() { return this.follow; }
  isBusy() { return this.busyCut || !!this.camScript; }
  setCinematics(on: boolean) { this.cinematics = on; }

  /** Fly alongside the asteroid (on) or back out to the whole Earth (off). */
  asteroidCam(on: boolean, instant = false) {
    if (on === this.follow) return;
    if (on && (this.gameOver || this.camScript)) return;
    this.follow = on;
    this.spin = false;
    this.focusAnim = null;
    const rp = this.rock.position.clone();
    if (on) {
      this.minD = 0.1; this.maxD = 5;
      this.eCtl.minDistance = this.minD; this.eCtl.maxDistance = this.maxD;
      const side = new THREE.Vector3().crossVectors(this.pathR, UP).normalize();
      const toPos = rp.clone().add(this.pathR.clone().multiplyScalar(0.3)).add(side.multiplyScalar(0.2)).add(new THREE.Vector3(0, 0.1, 0));
      this.followed = false;
      this.camAnim = { fromPos: this.eCam.position.clone(), toPos, fromTar: this.eCtl.target.clone(), toTar: rp, t: 0, dur: this.reduceMotion ? 0.01 : 1.6, live: true, onDone: () => { this.followed = true; } };
    } else {
      this.followed = false;
      this.minD = 1.5; this.maxD = 7;
      const dir = this.eCam.position.clone().sub(this.eCtl.target);
      const toPos = (dir.lengthSq() > 1e-6 ? dir.normalize() : new THREE.Vector3(0.1, 0.4, 1).normalize()).multiplyScalar(3.9);
      this.camAnim = { fromPos: this.eCam.position.clone(), toPos, fromTar: this.eCtl.target.clone(), toTar: new THREE.Vector3(), t: 0, dur: instant || this.reduceMotion ? 0.01 : 1.4, onDone: () => { this.eCtl.minDistance = this.minD; this.eCtl.maxDistance = this.maxD; } };
    }
  }

  /** Spacecraft in flight, driven by the game clock. */
  setMissions(list: MissionView[]) {
    this.missionData = list;
  }

  // ------------------------------------------------------------ picking (hover and click on the rock and spacecraft)

  private pickRoots(): THREE.Object3D[] {
    const roots: THREE.Object3D[] = [];
    if (this.rock.visible && !this.fragmented) roots.push(this.rock);
    for (const o of this.ships.values()) if (!o.gone && o.holder.visible) roots.push(o.holder);
    return roots;
  }

  private pickAt(e: PointerEvent): string | null {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -(((e.clientY - r.top) / r.height) * 2 - 1));
    this.raycaster.setFromCamera(ndc, this.eCam);
    const hits = this.raycaster.intersectObjects(this.pickRoots(), true);
    for (const h of hits) {
      let o: THREE.Object3D | null = h.object;
      while (o && !o.userData.pickId) o = o.parent;
      if (o) return o.userData.pickId as string;
    }
    return null;
  }

  private onPointerMove(e: PointerEvent) {
    if (!this.interactive || this.mode !== 'earth' || this.camScript || this.gameOver || e.buttons) { if (this.hoverId) this.setHover(null, 0, 0); return; }
    this.setHover(this.pickAt(e), e.clientX, e.clientY);
  }

  private onPointerUp(e: PointerEvent) {
    const d = this.downAt;
    this.downAt = null;
    if (!d || !this.interactive || this.mode !== 'earth' || this.camScript || this.gameOver) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6) return;
    const id = this.pickAt(e);
    if (id) this.onPick?.({ id, kind: this.kindOf(id), x: e.clientX, y: e.clientY });
  }

  private kindOf(id: string): PickInfo['kind'] {
    if (id === 'asteroid') return 'asteroid';
    return this.ships.get(id)?.kind ?? 'kinetic';
  }

  private setHover(id: string | null, x: number, y: number) {
    if (id !== this.hoverId) {
      this.highlight(this.hoverId, false);
      this.hoverId = id;
      this.highlight(id, true);
      this.canvas.style.cursor = id ? 'pointer' : '';
    }
    if (id) this.onHover?.({ id, kind: this.kindOf(id), x, y });
    else this.onHover?.(null);
  }

  /** Hovering only shows the name box (handled by the panel); nothing is drawn on the object itself. */
  private highlight(_id: string | null, _on: boolean) {
    (this.hoverGlow.material as THREE.SpriteMaterial).opacity = 0;
  }

  // ------------------------------------------------------------ spacecraft

  private makeShip(m: MissionView): ShipObj {
    const holder = new THREE.Group();
    const key: ShipKey = m.kind === 'tractor' || m.kind === 'probe' ? 'tractor' : m.kind === 'nuke' ? 'heavy' : m.tier ?? 'standard';
    const size = m.kind === 'tractor' ? 0.075 : m.kind === 'probe' ? 0.055 : key === 'heavy' ? 0.09 : key === 'standard' ? 0.075 : 0.065;
    // placeholder cone until the model loads
    const ph = new THREE.Mesh(new THREE.ConeGeometry(0.35, 1.2, 10), new THREE.MeshStandardMaterial({ color: 0xdfeaff, emissive: 0x4a6a9a, emissiveIntensity: 0.9 }));
    ph.rotation.x = Math.PI / 2;
    const body = new THREE.Group();
    body.add(ph);
    body.scale.setScalar(size);
    holder.add(body);
    const proxy = this.hitProxy(1);
    proxy.scale.setScalar(size * 1.05);
    holder.add(proxy);
    holder.userData.pickId = m.id;
    void shipTemplate(key).then((tpl) => {
      body.clear();
      const mdl = this.instance(tpl);
      if (m.kind === 'nuke') mdl.traverse((c) => { const mm = c as THREE.Mesh; if (mm.isMesh) { const st = mm.material as THREE.MeshStandardMaterial; st.color.setHex(0xffb4a0); st.emissive.setHex(0x601a10); } });
      body.add(mdl);
    }).catch(() => undefined);
    const trail = new Trail(36, 0.03);
    this.eScene.add(holder, trail.points);
    return { holder, body, outline: null, trail, beam: null, kind: m.kind, struck: false, cut: false, gone: false, size };
  }

  private launchPad() { return latLonToVec3(28.5, -80.6, 1.03); }

  private updateMissions() {
    const seen = new Set<string>();
    const launch = this.launchPad();
    const show = this.corridor.visible && !this.gameOver;
    for (const m of this.missionData) {
      seen.add(m.id);
      let o = this.ships.get(m.id);
      if (!o) {
        o = this.makeShip(m);
        // a mission first seen already finished (the panel re-rendered, or time skipped) must not replay its impact
        o.struck = !hoverKind(m.kind) && m.arrived;
        o.cut = o.struck;
        if (o.struck) { o.gone = true; if (m.kind === 'nuke') this.fragment(); }
        this.ships.set(m.id, o);
      }
      if (!hoverKind(m.kind) && m.arrived) this.biasOwners.delete(m.id);
      if (o.gone) { o.holder.visible = false; o.trail.points.visible = false; if (!hoverKind(m.kind)) continue; }
      if (this.cutShip === o) continue; // the strike cutscene is flying this one
      const rp = this.rock.position;
      const e = ease.inOut(m.p);
      if (!hoverKind(m.kind)) {
        if (!m.arrived) {
          const aim = rp.clone().sub(this.pathR.clone().multiplyScalar(0.05));
          const pos = launch.clone().lerp(aim, e);
          pos.add(new THREE.Vector3(0, Math.sin(m.p * Math.PI) * 0.14, 0));
          o.holder.position.copy(pos);
          o.holder.lookAt(aim);
          o.holder.visible = show;
          const back = launch.clone().sub(pos).normalize();
          o.trail.set(pos, back, 0.12, 0.9, m.kind === 'nuke' ? new THREE.Color(1, 0.55, 0.4) : undefined);
          o.trail.points.visible = show && this.motion > 0.02;
          if (m.p >= 0.8 && !o.cut && this.strikeCuts < 2 && this.cinematics && !this.camScript && !this.gameOver && this.mode === 'earth') this.startStrike(m, o);
        } else if (!o.struck) {
          // no cutscene (skipped time, orbit view): still show the hit
          o.struck = true; o.gone = true;
          o.holder.visible = false; o.trail.points.visible = false;
          this.impactFx(rp.clone(), rp.clone().sub(launch).normalize(), m.kind === 'nuke' ? 1.8 : 0.7);
          this.applyShift(m);
          this.explodeDoomed(m.id);
          if (m.kind === 'nuke') this.fragment();
        }
      } else if (!o.gone) {
        const hover = rp.clone().add(new THREE.Vector3(0.06, 0.04, 0.03));
        if (!m.arrived) {
          const pos = launch.clone().lerp(hover, e);
          pos.add(new THREE.Vector3(0, Math.sin(m.p * Math.PI) * 0.12, 0));
          o.holder.position.copy(pos);
          o.holder.lookAt(hover);
          o.trail.set(pos, launch.clone().sub(pos).normalize(), 0.1, 0.8);
          o.trail.points.visible = show && this.motion > 0.02;
        } else {
          o.holder.position.lerp(hover, 0.2);
          o.holder.lookAt(rp);
          o.trail.points.visible = false;
          if (m.kind !== 'probe') {
            if (!o.beam) {
              o.beam = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineDashedMaterial({ color: 0x7fd6ff, dashSize: 0.012, gapSize: 0.01, transparent: true, opacity: 0.9 }));
              this.eScene.add(o.beam);
            }
            const bp = o.beam.geometry.getAttribute('position') as THREE.BufferAttribute;
            bp.setXYZ(0, o.holder.position.x, o.holder.position.y, o.holder.position.z); bp.setXYZ(1, rp.x, rp.y, rp.z); bp.needsUpdate = true;
            o.beam.computeLineDistances();
            o.beam.visible = show;
          }
        }
        o.holder.visible = show;
      }
    }
    for (const [id, o] of this.ships) {
      if (!seen.has(id)) { this.disposeShip(o); this.ships.delete(id); this.biasOwners.delete(id); }
    }
    // until the team's estimate catches up with a strike, the path keeps the nudge the strike gave it
    this.biasTarget.set(0, 0, 0);
    for (const id of this.biasOwners) { const b = this.biasVecs.get(id); if (b) this.biasTarget.add(b); }
  }

  /** How far a strike moves the drawn path, measured between two real positions so the screen squeeze is respected. */
  private shiftVec(m: MissionView): THREE.Vector3 | null {
    if (!m.shift || !this.pathFrame || !this.sc) return null;
    const c = this.pathCenter;
    const next = framePath(this.sc, c.xi + m.shift.xi, c.zeta + m.shift.zeta, c.tau);
    return next.O.clone().sub(this.pathFrame.O);
  }

  /** A strike nudges the path: remember the sideways shift until the estimate includes it. */
  private applyShift(m: MissionView) {
    const d = this.shiftVec(m);
    if (!d) return;
    this.biasVecs.set(m.id, d);
    this.biasOwners.add(m.id);
  }

  /** Break the asteroid into pieces that keep flying along the same path. */
  private fragment() {
    if (this.fragmented) return;
    this.fragmented = true;
    this.fragOffsets = [];
    const n = 9;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.5;
      const r = 0.5 + Math.random() * 1.1;
      this.fragOffsets.push(new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, (Math.random() - 0.5) * 1.5));
      const holder = new THREE.Group();
      const sz = 0.22 + Math.random() * 0.4;
      const ph = this.placeholderRock();
      holder.add(ph);
      holder.userData.size = sz;
      this.frags.add(holder);
      void rockTemplate(this.sc.seed + 1 + i).then((tpl) => { holder.clear(); const m = this.instance(tpl); m.rotation.set(i, i * 2, 0); holder.add(m); }).catch(() => undefined);
    }
    this.rock.visible = false;
  }

  /** The tractor is hovering at the asteroid when an impactor lands: the debris destroys it. */
  private explodeDoomed(impactorId: string) {
    for (const m of this.missionData) {
      if (m.kind !== 'tractor' || m.doomedBy !== impactorId) continue;
      const o = this.ships.get(m.id);
      if (!o || o.gone || !m.arrived) continue;
      o.gone = true;
      o.holder.visible = false;
      if (o.beam) o.beam.visible = false;
      const at = o.holder.position.clone();
      this.debris(at, new THREE.Vector3().subVectors(at, this.rock.position).normalize(), 90, 0.5);
      const f = glowSprite(0xffb36b, 0.32, 1);
      f.position.copy(at);
      this.eScene.add(f);
      let t = 0;
      this.anims.push((dt) => { t += dt; f.scale.setScalar(0.32 + t * 0.7); (f.material as THREE.SpriteMaterial).opacity = Math.max(0, 1 - t * 1.5); if (t > 0.7) { this.eScene.remove(f); return true; } return false; });
    }
  }

  private debris(at: THREE.Vector3, axis: THREE.Vector3, count: number, speed: number) {
    const dirs = [...randomCone(axis, 0.7, Math.floor(count * 0.6)), ...randomCone(axis.clone().negate(), 1.4, Math.floor(count * 0.4))];
    const b = new Burst(at, dirs, speed, [new THREE.Color(1, 0.75, 0.4), new THREE.Color(1, 0.45, 0.15), new THREE.Color(0.85, 0.8, 0.75)], 0.03, 0.05, 2.2);
    this.eScene.add(b.points);
    this.anims.push((dt) => { if (b.update(dt)) { this.eScene.remove(b.points); b.dispose(); return true; } return false; });
  }

  /** Flash, shock ring and ejecta where an impactor hits the asteroid. */
  private impactFx(at: THREE.Vector3, travel: THREE.Vector3, power: number) {
    const flash = glowSprite(0xfff1d0, 0.25 * power + 0.1, 1);
    flash.position.copy(at);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.95, 1, 48), new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }));
    ring.position.copy(at);
    this.eScene.add(flash, ring);
    this.debris(at, travel.clone().negate(), 150, 0.45 * power + 0.15);
    let t = 0;
    this.anims.push((dt) => {
      t += dt;
      ring.quaternion.copy(this.eCam.quaternion);
      ring.scale.setScalar(0.02 + t * 0.32 * power);
      (ring.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.9 - t * 1.1);
      flash.scale.setScalar(0.35 * power + t * 1.4);
      (flash.material as THREE.SpriteMaterial).opacity = Math.max(0, 1 - t * 1.5);
      if (t > 0.9) { this.eScene.remove(flash, ring); ring.geometry.dispose(); return true; }
      return false;
    });
    this.rockJolt = 1;
    this.shake = Math.max(this.shake, 0.012 * power);
  }

  /** Draw an old and a new path, labelled, so the nudge can be seen. */
  private showPathChange(oldO: THREE.Vector3, newO: THREE.Vector3, R: THREE.Vector3, hold: number) {
    const set = (line: Ribbon, O: THREE.Vector3) => {
      const end = O.lengthSq() < 1 ? Math.sqrt(1 - O.lengthSq()) : -2.5;
      line.setEnds(O.clone().addScaledVector(R, 5.5), O.clone().addScaledVector(R, end));
      line.visible = true;
    };
    set(this.oldLine, oldO); set(this.newLine, newO);
    // labels sit on each line a little behind the rock, so both are in the frame of the cutscene camera
    const along = this.rock.position.dot(R);
    this.addLabel3(oldO.clone().addScaledVector(R, along + 0.7), 'Original path', 'path old');
    this.addLabel3(newO.clone().addScaledVector(R, along + 0.35), 'New path', 'path new');
    let t = 0;
    this.anims.push((dt) => {
      t += dt;
      if (t > hold) {
        this.oldLine.visible = false; this.newLine.visible = false;
        this.clearLabels3();
        return true;
      }
      return false;
    });
  }

  /** The cutscene: ride along with the impactor as it hits the asteroid. */
  private startStrike(m: MissionView, o: ShipObj) {
    o.cut = true;
    this.strikeCuts++;
    this.cutShip = o;
    this.busyCut = true;
    this.setHover(null, 0, 0);
    this.cineBars(true);
    this.cineCaption(m.kind === 'nuke' ? 'Nuclear device on final approach' : audio.line('strike_approach'));
    audio.sfx('flyby');
    if (m.kind !== 'nuke') audio.speak('strike_approach', { interrupt: true, once: false, caption: false });
    const saved = { pos: this.eCam.position.clone(), tar: this.eCtl.target.clone(), follow: this.follow, fov: this.eCam.fov };
    const start = o.holder.position.clone();
    this.eCtl.enabled = false;
    let t = 0, after = 0, hit = false;
    const dur = 3.2;
    const camPos = this.eCam.position.clone();
    const look = this.rock.position.clone();
    const oldO = this.pathO.clone().add(this.bias);
    const R = this.pathR.clone();
    this.camScript = {
      ownsRock: false,
      fn: (dt) => {
        t += dt;
        const target = this.rock.position;
        const s = Math.min(1, t / dur);
        const pos = hit ? target.clone() : start.clone().lerp(target.clone().sub(this.pathR.clone().multiplyScalar(0.01)), s * s * 0.65 + s * 0.35 * s);
        const fwd = target.clone().sub(pos);
        if (!hit && fwd.lengthSq() > 1e-8) { o.holder.position.copy(pos); o.holder.lookAt(target); fwd.normalize(); o.trail.set(pos, fwd.clone().negate(), 0.22, 1.2); o.trail.points.visible = true; }
        const f = fwd.lengthSq() > 1e-8 ? fwd.clone().normalize() : this.pathR.clone().negate();
        const side = new THREE.Vector3().crossVectors(f, UP).normalize();
        let desired: THREE.Vector3;
        let aim: THREE.Vector3;
        if (!hit) {
          // a wide chase shot: the rocket, the asteroid and some of Earth behind them
          desired = pos.clone().sub(f.clone().multiplyScalar(0.55 + 0.35 * (1 - s))).add(side.clone().multiplyScalar(0.34)).add(new THREE.Vector3(0, 0.2, 0));
          aim = pos.clone().lerp(target, 0.5);
          this.eCam.fov += (40 - this.eCam.fov) * (1 - Math.exp(-dt * 3));
        } else {
          after += dt;
          desired = target.clone().add(side.clone().multiplyScalar(2.4)).add(new THREE.Vector3(0, 0.55, 0)).add(R.clone().multiplyScalar(0.7));
          aim = target.clone().addScaledVector(R, -0.4);
          this.eCam.fov += (46 - this.eCam.fov) * (1 - Math.exp(-dt * 2));
        }
        camPos.lerp(desired, 1 - Math.exp(-dt * (hit ? 1.6 : 5)));
        look.lerp(aim, 1 - Math.exp(-dt * 9));
        this.eCam.position.copy(camPos);
        if (this.shake > 0.0005) { this.eCam.position.add(new THREE.Vector3((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake)); this.shake *= Math.exp(-dt * 4); }
        this.eCam.lookAt(look);
        this.eCam.updateProjectionMatrix();
        if (!hit && s >= 1) {
          hit = true;
          o.struck = true; o.gone = true;
          o.holder.visible = false; o.trail.points.visible = false;
          const nuke = m.kind === 'nuke';
          this.impactFx(target.clone(), f, nuke ? 2.2 : 1);
          audio.sfx(nuke ? 'nukeboom' : 'boom');
          this.explodeDoomed(m.id);
          this.cineFlash(nuke ? 0.9 : 0.5);
          if (nuke) { this.fragment(); this.cineCaption(audio.line('nuke_done')); audio.speak('nuke_done', { interrupt: true, once: false, caption: false }); }
          else {
            this.cineCaption(audio.line('strike_hit'));
            audio.speak('strike_hit', { interrupt: true, once: false, caption: false });
            this.applyShift(m);
            const dO = this.shiftVec(m) ?? side.clone().multiplyScalar(0.12);
            this.showPathChange(oldO, oldO.clone().add(dO), R, 5.2);
          }
        }
        if (hit && after > 3.6) {
          // back to where the player was looking
          this.eCam.fov = saved.fov; this.eCam.updateProjectionMatrix();
          this.camAnim = { fromPos: this.eCam.position.clone(), toPos: saved.pos, fromTar: look.clone(), toTar: saved.tar, t: 0, dur: 1.4, live: saved.follow };
          this.cineBars(false);
          this.cineCaption('');
          return true;
        }
        return false;
      },
    };
    // lifted again when the script ends
    const fn = this.camScript.fn;
    this.camScript.fn = (dt) => {
      const done = fn(dt);
      if (done) { this.cutShip = null; this.busyCut = false; this.eCtl.enabled = this.mode === 'earth'; }
      return done;
    };
  }

  // ------------------------------------------------------------ cinematic overlay helpers

  private keepBars = false;
  private cineBars(on: boolean) {
    if (!on && this.keepBars) return;
    this.cine.root.classList.toggle('on', on);
    this.host.classList.toggle('cinema', on);
  }

  /** Watching a replay: letterbox bars stay on and the controls are hidden, the camera drifts around the planet. */
  replayStage(on: boolean) {
    this.keepBars = on;
    this.cineBars(on);
    if (on) this.spin = true;
    else this.cineCaption('');
  }

  private replayTimer = 0;
  /** A line of caption for the replay, cleared after a few seconds. */
  replayCaption(text: string, ms = 3200) {
    this.cineCaption(text);
    clearTimeout(this.replayTimer);
    this.replayTimer = window.setTimeout(() => this.cineCaption(''), ms);
  }
  private cineOff() { this.cine.root.classList.remove('on'); this.host.classList.remove('cinema'); this.cine.cap.textContent = ''; this.cine.count.textContent = ''; this.cine.title.className = 'cine-title'; this.cine.title.innerHTML = ''; }
  private cineCaption(text: string) {
    const c = this.cine.cap;
    if (c.textContent === text) return;
    c.classList.remove('show');
    void c.offsetWidth;
    c.textContent = text;
    if (text) c.classList.add('show');
  }
  private cineCount(text: string) { if (this.cine.count.textContent !== text) this.cine.count.textContent = text; }
  private cineFlash(strength = 1) {
    const f = this.cine.flash;
    f.style.transition = 'none';
    f.style.opacity = String(Math.min(1, strength));
    void f.offsetWidth;
    f.style.transition = 'opacity 1.1s cubic-bezier(0.16, 1, 0.3, 1)';
    f.style.opacity = '0';
  }
  private cineTitle(main: string, sub: string, tone: 'hit' | 'miss') {
    const t = this.cine.title;
    t.className = `cine-title show ${tone}`;
    t.innerHTML = `<b>${main}</b><span>${sub}</span>`;
  }

  // ------------------------------------------------------------ the ending

  /**
   * The ending, shot like a film: a wide establishing view with the asteroid's actual path drawn in,
   * the rock tearing in, then either the strike and its aftermath, or a fly-past that we follow.
   */
  playOutcome(opts: OutcomeOpts, done: () => void) {
    this.setMode('earth');
    this.clearFx();
    this.gameOver = true;
    this.keepBars = false;
    this.interactive = false;
    this.setHover(null, 0, 0);
    this.follow = false; this.followed = false; this.camAnim = null; this.focusAnim = null;
    this.minD = 1.5; this.maxD = 7;
    this.eCtl.minDistance = 1.5; this.eCtl.maxDistance = 7;
    this.corridor.visible = false;
    this.pathLine.visible = false;
    this.histLine.visible = false; this.histGlow.visible = false;
    this.setLabels([]);
    this.clearShips();
    this.missionData = [];
    this.eCtl.enabled = false;
    this.cineBars(true);
    this.cinematic(opts, done);
  }

  private cinematic(opts: OutcomeOpts, done: () => void) {
    const sc = opts.sc;
    const hit = opts.hit && !!opts.site;
    const quick = this.reduceMotion;
    const fin = framePath(sc, opts.final.xi, opts.final.zeta, opts.final.tau);
    const R = fin.R.clone();
    const O = fin.O.clone();
    if (!hit && O.length() < 1.45) O.setLength(1.45); // a miss has to look like one
    const travel = R.clone().negate();
    const P = hit ? (groundPointOf(fin) ?? latLonToVec3(opts.site!.lat, opts.site!.lon, 1)) : new THREE.Vector3();
    const side = hit ? new THREE.Vector3().crossVectors(R, UP).normalize() : O.clone().normalize();
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
    const w = new THREE.Vector3().crossVectors(travel, side).normalize(); // third axis
    const reach = 10;
    const rockHeat = glowSprite(0xff7a2a, 0.3, 0);
    const fireTrail = new FireTail(260);
    this.eScene.add(rockHeat, fireTrail.points);
    if (opts.fragmented && !this.fragmented) this.fragment();
    this.rock.visible = !opts.fragmented;
    let ct = 0;
    let tau = hit ? 0 : -1;
    let phase: 'run' | 'after' = 'run';
    let afterT = 0;
    let impacted = false;
    const camNow = this.eCam.position.clone();
    const look = new THREE.Vector3();
    let slow = 1;
    let lastCount = '';
    // wide establishing shots: Earth and the far-off rock both in frame, whatever the stage shape
    const aspect = Math.max(0.7, Math.min(1.25, this.host.clientWidth / Math.max(1, this.host.clientHeight)));
    const dWide = 15.5 / aspect;
    const midHit = () => P.clone().multiplyScalar(0.5).addScaledVector(R, reach * 0.5);
    const midMiss = () => O.clone().multiplyScalar(0.5).addScaledVector(R, reach * 0.5);
    const wideHit = () => midHit().addScaledVector(side, dWide).addScaledVector(UP, dWide * 0.16);
    const wideMiss = () => midMiss().addScaledVector(w, dWide).addScaledVector(UP, dWide * 0.12);
    // rings and decals shown after a strike
    const zones = hit ? this.buildZones(P, opts.effects, opts.cities ?? []) : null;

    // the paths, drawn in so the way it travels is never in doubt
    const mainLine = new Ribbon(opts.deflected ? 0x66f0b0 : 0xffd9a0, 0.95, 3.2, 0.2, 0.16);
    this.ribbons.add(mainLine);
    this.fx.add(mainLine);
    {
      const until = hit ? Math.sqrt(Math.max(0, 1 - O.lengthSq())) : -reach;
      mainLine.setEnds(O.clone().addScaledVector(R, reach + 3), O.clone().addScaledVector(R, until));
    }
    if (opts.deflected) {
      const base = framePath(sc, opts.base.xi, opts.base.zeta, opts.base.tau);
      const until = base.hits ? Math.sqrt(Math.max(0, 1 - base.O.lengthSq())) : -2;
      this.oldLine.setDash(0.2, 0.16);
      this.oldLine.setEnds(base.O.clone().addScaledVector(base.R, reach + 3), base.O.clone().addScaledVector(base.R, until));
      this.oldLine.visible = true;
      this.addLabel3(base.O.clone().addScaledVector(base.R, 6.5), 'Original path: it would have hit', 'path old');
      this.addLabel3(O.clone().addScaledVector(R, 5), hit ? 'New path' : 'New path: it misses', 'path new');
    } else {
    }

    const rockAt = (): THREE.Vector3 => {
      if (hit) {
        const rem = reach * (1 - tau * tau);
        return P.clone().addScaledVector(R, rem);
      }
      const k = 3;
      const s = (reach * Math.sinh(k * tau)) / Math.sinh(k);
      return O.clone().addScaledVector(travel, s);
    };

    const fmtClock = (secs: number) => {
      const s = Math.max(0, Math.round(secs));
      return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    };

    audio.duck(0.35);
    if (!hit && opts.deflected) {
      this.cineCaption(audio.line('end_deflect_q'));
      audio.speak('end_deflect_q', { interrupt: true, once: false, caption: false });
    } else {
      this.cineCaption('');
    }
    if (hit) audio.speak('end_countdown', { interrupt: true, once: false, caption: false });
    // how many real seconds are left before the rock lands, from where it is now (the approach slows right at the end)
    const etaOf = (t0: number) => {
      let t = t0, secs = 0;
      for (let k = 0; k < 400 && t < 1; k++) {
        const r = reach * (1 - t * t);
        const sl = r < 1.8 ? 0.28 + 0.72 * ease.clamp01((r - 0.2) / 1.6) : 1;
        secs += 0.01 / ((quick ? 0.6 : 0.2) * sl);
        t += 0.01;
      }
      return secs;
    };
    const said: Record<string, boolean> = {};
    let whooshed = false;
    this.camScript = {
      ownsRock: true,
      fn: (dtRaw) => {
        const dt = Math.min(dtRaw, 0.05);
        ct += dt;
        mainLine.flow(dt, 0.5); this.oldLine.flow(dt, 0.5);
        const wideDur = quick ? 0.4 : 2.4;
        // ---- motion along the path
        if ((phase === 'run' || !hit) && ct > wideDur) {
          if (hit) {
            const rem = reach * (1 - tau * tau);
            slow = rem < 1.8 ? 0.28 + 0.72 * ease.clamp01((rem - 0.2) / 1.6) : 1;
            tau = Math.min(1, tau + dt * (quick ? 0.6 : 0.2) * slow);
          } else {
            const near = Math.abs(tau) < 0.2;
            slow = near ? 0.55 : 1;
            tau = Math.min(1, tau + dt * (quick ? 0.7 : 0.26) * (phase === 'after' ? 1 : slow));
          }
        }
        const rp = rockAt();
        this.rock.position.copy(rp);
        this.rock.rotation.y += dt * 1.4; this.rock.rotation.x += dt * 0.7;
        const rem = hit ? reach * (1 - tau * tau) : 0;
        if (hit && !impacted && ct > wideDur) {
          const eta = etaOf(tau);
          if (!whooshed && rem < 3.4) { whooshed = true; audio.sfx('whoosh'); }
          for (const [at, id] of [[6, 'beep'], [4, 'beep'], [5, 'end_5'], [3, 'end_3'], [2, 'end_2'], [1, 'end_1']] as [number, string][]) {
            if (eta <= at && !said[id + at]) {
              said[id + at] = true;
              if (id === 'beep') audio.sfx('beep'); else audio.speak(id, { interrupt: true, once: false, caption: false });
            }
          }
        }
        const heat = hit ? ease.clamp01((2.4 - rem) / 2.2) : 0;
        const dcam = Math.max(0.2, rp.distanceTo(camNow));
        this.rock.scale.setScalar(Math.max(0.06, Math.min(1.1, dcam * 0.085)));
        this.rock.visible = !opts.fragmented && (hit ? !impacted : true);
        // pieces of a broken asteroid fly together along the same line
        if (opts.fragmented) {
          const sp = Math.min(1, dcam * 0.5);
          this.frags.children.forEach((c, i) => {
            const off = this.fragOffsets[i] ?? new THREE.Vector3();
            c.visible = hit ? !impacted : true;
            c.position.copy(rp).addScaledVector(side, off.x * 0.12 * sp).addScaledVector(UP, off.y * 0.12 * sp).addScaledVector(R, off.z * 0.2);
            c.scale.setScalar(Math.max(0.05, Math.min(0.6, dcam * 0.05)) * (c.userData.size ?? 0.3) * 2);
            c.rotation.y += dt * (1 + i * 0.2);
          });
        }
        rockHeat.position.copy(rp);
        const hm = rockHeat.material as THREE.SpriteMaterial;
        hm.opacity = hit && impacted ? 0 : heat;
        rockHeat.scale.setScalar(Math.max(0.2, dcam * 0.12) * (0.7 + heat * 0.9));
        fireTrail.setScale(this.host.clientHeight || 600, this.eCam.fov);
        // a tail that streams back along the way it came
        const tailLen = hit ? 0.2 + heat * 1.3 + (1 - rem / reach) * 0.4 : 0.18 + 0.5 * Math.abs(tau);
        const rr = this.rock.scale.x * 0.55;
        if (!(hit && impacted)) fireTrail.set(rp, R.clone(), rr * (3 + tailLen * 4), rr * (0.45 + heat * 0.35), hit ? 0.5 + heat * 0.8 : 0.5, ct);
        fireTrail.points.visible = !(hit && impacted);

        // ---- countdown
        if (hit && !impacted) {
          const c = fmtClock(rem * 1750 + 12);
          if (c !== lastCount) { lastCount = c; this.cineCount(`IMPACT IN ${c}`); }
        } else if (!hit) {
          const secs = Math.abs(reach * Math.sinh(3 * tau) / Math.sinh(3)) * 1500;
          if (tau < 0) { const c = fmtClock(secs + 20); if (c !== lastCount) { lastCount = c; this.cineCount(`CLOSEST APPROACH IN ${c}`); } }
          else this.cineCount('');
        }

        // ---- camera
        let desiredPos: THREE.Vector3;
        let desiredLook: THREE.Vector3;
        let fov = 44;
        if (phase === 'run') {
          if (hit) {
            const wide = wideHit();
            const track = rp.clone().addScaledVector(side, 0.8 + rem * 0.22).addScaledVector(UP, 0.28).addScaledVector(R, -0.15);
            const chase = rp.clone().addScaledVector(R, 0.5).addScaledVector(side, 0.2).addScaledVector(UP, 0.1);
            const kTrack = ease.inOut(ease.clamp01((ct - wideDur) / 2.2));
            const kChase = ease.inOut(ease.clamp01((2.6 - rem) / 1.4));
            desiredPos = wide.clone().lerp(track, kTrack).lerp(chase, kChase);
            desiredLook = midHit().lerp(rp, kTrack).lerp(P.clone(), kChase * 0.75);
            fov = 44 - 14 * kChase;
          } else {
            const wide = wideMiss();
            const close = w.clone().multiplyScalar(5.2).addScaledVector(travel, rp.dot(travel) * 0.35).addScaledVector(UP, 0.35);
            const kClose = ease.inOut(ease.clamp01((ct - wideDur) / 2.2));
            desiredPos = wide.clone().lerp(close, kClose);
            desiredLook = midMiss().lerp(rp.clone().multiplyScalar(0.5), ease.inOut(ease.clamp01((ct - wideDur) / 1.8)));
            fov = 44 - 8 * kClose;
          }
        } else if (hit) {
          const ground = P.clone().multiplyScalar(1.5).addScaledVector(side, 0.62);
          const orbit = P.clone().multiplyScalar(2.5).addScaledVector(side, 0.9).addScaledVector(UP, 0.3);
          const k = ease.inOut(ease.clamp01((afterT - 1.0) / 3.2));
          desiredPos = ground.lerp(orbit, k);
          desiredLook = P.clone().multiplyScalar(1.0 - 0.15 * k);
          fov = 52 - 14 * k;
        } else {
          // follow the asteroid as it leaves: Earth shrinks behind it
          desiredPos = rp.clone().addScaledVector(travel, -1.5).addScaledVector(side, 0.9).addScaledVector(UP, 0.45);
          desiredLook = rp.clone();
          fov = 40;
        }
        const kk = phase === 'after' && hit && afterT < 0.15 ? 1 : 1 - Math.exp(-dt * (ct < 0.1 ? 40 : phase === 'after' && !hit ? 6 : 4.2));
        camNow.lerp(desiredPos, kk);
        look.lerp(desiredLook, ct < 0.1 ? 1 : 1 - Math.exp(-dt * (phase === 'after' && !hit ? 9 : 6)));
        this.eCam.position.copy(camNow);
        if (this.shake > 0.0005) {
          this.eCam.position.add(new THREE.Vector3((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake));
          this.shake *= Math.exp(-dt * (phase === 'after' ? 2.4 : 5));
        }
        this.eCam.lookAt(look);
        this.eCam.fov += (fov - this.eCam.fov) * (1 - Math.exp(-dt * 4));
        this.eCam.updateProjectionMatrix();
        if (hit && !impacted) this.shake = Math.max(this.shake, 0.012 * heat);

        // ---- beats
        if (hit) {
          if (!impacted && rem < 0.001) {
            impacted = true;
            phase = 'after';
            this.cineCount('');
            this.cineFlash(1);
            this.cineCaption('');
            audio.sfx('impact');
            audio.sfx('shock', { delay: 0.3 });
            this.shake = 0.035;
            camNow.copy(P.clone().multiplyScalar(1.5).addScaledVector(side, 0.62));
            this.groundImpact(P, R, opts.effects, zones!, opts.fragmented);
            this.rock.visible = false; rockHeat.visible = false; fireTrail.points.visible = false;
            this.frags.children.forEach((c) => (c.visible = false));
          }
          if (impacted) {
            afterT += dt;
            if (afterT > 1.4 && afterT < 1.5 && !said.hitline) {
              said.hitline = true;
              this.cineCaption(opts.fragmented ? 'The pieces strike over a wide area.' : audio.line('end_hit'));
              if (!opts.fragmented) audio.speak('end_hit', { interrupt: true, once: false, caption: false });
            }
            if (afterT > 4.6 && !this.cine.title.classList.contains('show')) this.cineTitle(opts.title, opts.subtitle, 'hit');
            if (afterT > 7.4) return this.finishCinematic(rockHeat, fireTrail, mainLine, look, done, hit ? P : null);
          }
        } else {
          if (phase === 'run' && tau >= 0.0 && !impacted) {
            impacted = true; // "passed" marker
            if (!whooshed) { whooshed = true; audio.sfx('whoosh'); }
            this.cineCaption(opts.deflected ? `Deflected: it misses by ${Math.round(opts.missKm).toLocaleString('en-US')} km` : `It passes ${Math.round(opts.missKm).toLocaleString('en-US')} km from Earth`);
          }
          if (phase === 'run' && tau >= 0.45) { phase = 'after'; }
          if (phase === 'after') {
            afterT += dt;
            if (afterT > 0.6 && !this.cine.title.classList.contains('show')) {
              const id = opts.deflected ? 'end_miss' : 'end_miss_plain';
              this.cineCaption(audio.line(id));
              audio.speak(id, { interrupt: true, once: false, caption: false });
              this.cineTitle(opts.title, opts.subtitle, 'miss');
            }
            if (afterT > 5.2) return this.finishCinematic(rockHeat, fireTrail, mainLine, look, done, hit ? P : null);
          }
        }
        return false;
      },
    };
    // start of the script: reset the view to the wide shot immediately
    camNow.copy(hit ? wideHit() : wideMiss());
    look.copy(hit ? midHit() : midMiss());
    this.eCam.fov = 44; this.eCam.updateProjectionMatrix();
  }

  private finishCinematic(rockHeat: THREE.Sprite, fireTrail: FireTail, mainLine: Ribbon, look: THREE.Vector3, done: () => void, ground: THREE.Vector3 | null): boolean {
    this.eScene.remove(rockHeat, fireTrail.points);
    fireTrail.dispose();
    (rockHeat.material as THREE.Material).dispose();
    this.fx.remove(mainLine);
    this.ribbons.delete(mainLine);
    mainLine.dispose();
    this.oldLine.visible = false; this.newLine.visible = false;
    this.oldLine.setDash(0.14, 0.09);
    this.clearLabels3();
    this.cineBars(false);
    this.cineCount('');
    this.cineCaption('');
    this.cine.title.classList.add('out');
    this.frags.clear();
    // settle back to a distance where the whole planet is in view again
    let settle = this.eCam.position.clone().setLength(Math.max(3.0, Math.min(4.2, this.eCam.position.length())));
    if (ground) {
      // after a strike, hold a view of the damaged region, high enough to see the zones and low enough to see the crater
      const n = ground.clone().normalize();
      const sideV = new THREE.Vector3().crossVectors(n, UP);
      if (sideV.lengthSq() < 1e-4) sideV.set(1, 0, 0);
      sideV.normalize();
      settle = n.multiplyScalar(2.15).addScaledVector(sideV, 0.55).addScaledVector(UP, 0.25).setLength(2.3);
    }
    this.camAnim = { fromPos: this.eCam.position.clone(), toPos: settle, fromTar: look.clone(), toTar: new THREE.Vector3(), t: 0, dur: 1.6 };
    this.eCtl.enabled = this.mode === 'earth';
    this.eCam.fov = this.baseFov; this.eCam.updateProjectionMatrix();
    setTimeout(done, 900);
    return true;
  }

  // ---- ground zero

  /**
   * The affected area, painted on the planet itself (a shader on a thin shell, so even a zone as big as half the globe
   * hugs the curve). The real zones of a small rock are tiny next to a whole planet, so the picture is scaled up until even
   * the outer ring can be seen from orbit (the panel gives the true distances). A bowl-shaped crater sits at the centre.
   */
  private buildZones(P: THREE.Vector3, fx: Effects, cities: { lat: number; lon: number; level: number }[] = []) {
    const n = P.clone().normalize();
    const angC = Math.min(2.6, Math.max(fx.rC, 16) / 6371);
    const vis = Math.max(1, 0.06 / angC);
    const ang = [Math.max(fx.rA, 6), Math.max(fx.rB, 12), Math.max(fx.rC, 16)].map((km) => Math.min(2.6, (km / 6371) * vis));
    const uni = {
      uC: { value: n.clone() },
      uRad: { value: new THREE.Vector3(ang[0], ang[1], ang[2]) },
      uK: { value: new THREE.Vector3(0.001, 0.001, 0.001) },
      uTime: { value: 0 },
      cA: { value: new THREE.Color(COL.zoneA) },
      cB: { value: new THREE.Color(COL.zoneB) },
      cC: { value: new THREE.Color(COL.zoneC) },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: uni,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      vertexShader: 'varying vec3 vP; void main() { vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `
        varying vec3 vP;
        uniform vec3 uC; uniform vec3 uRad; uniform vec3 uK; uniform float uTime;
        uniform vec3 cA; uniform vec3 cB; uniform vec3 cC;
        vec4 over(vec4 dst, vec4 src) {
          float a = src.a + dst.a * (1.0 - src.a);
          vec3 c = (src.rgb * src.a + dst.rgb * dst.a * (1.0 - src.a)) / max(a, 1e-5);
          return vec4(c, a);
        }
        float fillOf(float a, float r) { return 1.0 - smoothstep(r * 0.9, r, a); }
        float ringOf(float a, float r) { float w = max(0.0016, r * 0.014); return smoothstep(w, 0.0, abs(a - r)); }
        void main() {
          float a = acos(clamp(dot(normalize(vP), uC), -1.0, 1.0));
          vec3 r = uRad * uK;
          float pulse = 0.86 + 0.14 * sin(uTime * 1.8);
          vec4 acc = vec4(0.0);
          // charred ground under the whole blast
          acc = over(acc, vec4(vec3(0.05, 0.02, 0.015), 0.5 * fillOf(a, r.z * 1.04)));
          acc = over(acc, vec4(cC, 0.24 * fillOf(a, r.z) * pulse));
          // ripples running outward through the outer zone
          float rip = 0.5 + 0.5 * sin(a / max(r.z, 1e-4) * 38.0 - uTime * 2.6);
          acc = over(acc, vec4(cC, 0.15 * rip * fillOf(a, r.z)));
          acc = over(acc, vec4(cB, 0.42 * fillOf(a, r.y) * pulse));
          // molten core: white-hot in the middle
          float heat = smoothstep(r.x, 0.0, a);
          vec3 core = mix(cA, vec3(1.0, 0.86, 0.55), heat * heat);
          acc = over(acc, vec4(core, (0.7 + 0.3 * heat) * fillOf(a, r.x) * pulse));
          acc = over(acc, vec4(cC, 0.95 * ringOf(a, r.z)));
          acc = over(acc, vec4(cB, 0.95 * ringOf(a, r.y)));
          acc = over(acc, vec4(cA, 0.95 * ringOf(a, r.x)));
          // a shockwave ring that keeps leaving the centre
          float ph = fract(uTime * 0.3);
          float full = smoothstep(0.85, 1.0, min(uK.z, 1.0));
          acc = over(acc, vec4(vec3(1.0, 0.82, 0.55), full * (1.0 - ph) * 0.8 * ringOf(a, r.z * (0.15 + 0.85 * ph))));
          if (acc.a < 0.003) discard;
          gl_FragColor = vec4(acc.rgb, acc.a);
        }`,
    });
    const shell = new THREE.Mesh(new THREE.SphereGeometry(1.0035, 160, 96), mat);
    shell.renderOrder = 2;
    shell.visible = false;
    this.fx.add(shell);

    // the crater and its glow stand on the ground at the centre
    const g = new THREE.Group();
    g.position.copy(n.clone().multiplyScalar(1.004));
    g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    const craterR = Math.max(0.011, (fx.craterKm / 2 / 6371) * Math.max(1, vis * 0.6));
    const depth = craterR * (fx.airburst ? 0.12 : 0.34);
    const prof: [number, number][] = [[0, -depth], [0.32, -depth * 0.96], [0.62, -depth * 0.7], [0.86, -depth * 0.25], [0.97, depth * 0.18], [1.06, depth * 0.34], [1.2, depth * 0.16], [1.45, depth * 0.04], [1.7, 0]];
    const lg = new THREE.LatheGeometry(prof.map(([rx, h]) => new THREE.Vector2(rx * craterR, h)), 40);
    const colors: number[] = [];
    const pos = lg.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const rr = Math.hypot(pos.getX(i), pos.getZ(i)) / craterR;
      const heat = Math.max(0, 1 - rr / 0.75);
      const c = new THREE.Color().setRGB(0.2 + heat * 1.2, 0.12 + heat * 0.45, 0.08 + heat * 0.05);
      colors.push(c.r, c.g, c.b);
    }
    lg.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    lg.computeVertexNormals();
    const crater = new THREE.Mesh(lg, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, side: THREE.DoubleSide, emissive: 0x3a1204, emissiveIntensity: 0.9 }));
    crater.rotation.x = Math.PI / 2;
    crater.position.z = 0.0008;
    crater.scale.setScalar(0.001);
    g.add(crater);
    const ember = glowSprite(0xff6a1a, craterR * 2.5, 0.7);
    ember.position.set(0, 0, 0.0035);
    g.add(ember);
    // standing walls of light on each ring, a bubble over the middle, a column of heat and rising embers
    const standing = (rad: number, h: number, color: THREE.ColorRepresentation, amt: number, rTop = rad) => {
      const mat = new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
        uniforms: { uT: uni.uTime, uCol: { value: new THREE.Color(color) }, uAmt: { value: amt } },
        vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: `
          varying vec2 vUv; uniform float uT; uniform vec3 uCol; uniform float uAmt;
          void main() {
            float fade = pow(1.0 - vUv.y, 1.7);
            float bands = 0.62 + 0.38 * sin(vUv.x * 130.0 + uT * 2.4 + vUv.y * 9.0);
            float flick = 0.86 + 0.14 * sin(uT * 7.0 + vUv.x * 40.0);
            gl_FragColor = vec4(uCol * 1.25, fade * bands * flick * uAmt);
          }`,
      });
      const wall = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rad, h, 96, 1, true), mat);
      wall.rotation.x = Math.PI / 2;
      wall.position.z = h / 2;
      const holder = new THREE.Group();
      holder.add(wall);
      holder.scale.setScalar(0.001);
      g.add(holder);
      return holder;
    };
    const cols3 = [COL.zoneA, COL.zoneB, COL.zoneC];
    const walls = ang.map((r, i) => standing(r, Math.min(0.3, r * [1.7, 1.1, 0.7][i]), cols3[i], [0.55, 0.4, 0.3][i]));
    const column = standing(ang[0] * 0.2, 0.26, 0xffd9a0, 0.7, ang[0] * 0.03);
    const domeMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
      uniforms: { uT: uni.uTime },
      vertexShader: 'varying vec3 vN; varying vec3 vV; void main() { vN = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position, 1.0); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }',
      fragmentShader: `
        varying vec3 vN; varying vec3 vV; uniform float uT;
        void main() {
          float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.2);
          float pulse = 0.85 + 0.15 * sin(uT * 2.2);
          gl_FragColor = vec4(vec3(1.0, 0.55, 0.2) * (0.5 + f), (0.07 + f * 0.7) * pulse);
        }`,
    });
    const dome = new THREE.Mesh(new THREE.SphereGeometry(ang[0] * 0.95, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2), domeMat);
    dome.rotation.x = Math.PI / 2;
    dome.scale.set(1, 0.6, 1);
    const domeHolder = new THREE.Group();
    domeHolder.add(dome);
    domeHolder.scale.setScalar(0.001);
    g.add(domeHolder);
    // embers drifting up out of the crater
    const NE = 120;
    const ePos = new Float32Array(NE * 3), eCol = new Float32Array(NE * 3);
    const eSeed = Array.from({ length: NE }, () => ({ a: Math.random() * 6.283, r: Math.random(), v: 0.04 + Math.random() * 0.07, o: Math.random() }));
    const eGeo = new THREE.BufferGeometry();
    eGeo.setAttribute('position', new THREE.BufferAttribute(ePos, 3));
    eGeo.setAttribute('color', new THREE.BufferAttribute(eCol, 3));
    const embers = new THREE.Points(eGeo, new THREE.PointsMaterial({ size: 0.012, map: glowTexture(), vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true }));
    embers.frustumCulled = false;
    g.add(embers);
    g.visible = false;
    this.fx.add(g);

    // places that were hit: a small lit pin on each, coloured by how bad it was there
    const pinColors = [COL.zoneA, COL.zoneB, COL.zoneC];
    const pins: THREE.Sprite[] = [];
    for (const c of cities) {
      const pin = glowSprite(pinColors[Math.max(0, Math.min(2, c.level))], 0.045, 1);
      pin.position.copy(latLonToVec3(c.lat, c.lon, 1.012));
      pin.scale.setScalar(0.001);
      this.fx.add(pin);
      pins.push(pin);
    }
    let t = 0;
    this.anims.push((dt) => {
      t += dt;
      uni.uTime.value = t;
      const pulse = 0.5 + 0.5 * Math.sin(t * 1.8);
      (ember.material as THREE.SpriteMaterial).opacity = 0.3 + 0.3 * pulse;
      const H = 0.13;
      for (let i = 0; i < NE; i++) {
        const e = eSeed[i];
        const z = ((t * e.v + e.o) % 1) * H;
        const rad = ang[0] * (0.1 + 0.9 * e.r) * (1 + z / H * 0.6);
        ePos[i * 3] = Math.cos(e.a + t * 0.2) * rad; ePos[i * 3 + 1] = Math.sin(e.a + t * 0.2) * rad; ePos[i * 3 + 2] = z;
        const f = Math.pow(1 - z / H, 1.3);
        eCol[i * 3] = 1.0 * f; eCol[i * 3 + 1] = (0.45 + 0.3 * e.r) * f; eCol[i * 3 + 2] = 0.12 * f;
      }
      (eGeo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      (eGeo.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
      pins.forEach((pn, i) => { const k = ease.out(ease.clamp01((t - 1.6 - i * 0.08) / 0.5)); pn.scale.setScalar(Math.max(0.001, 0.045 * k * (0.9 + 0.2 * pulse))); });
      return false;
    });
    return { group: g, shell, uni, crater, craterR, ember, walls, column, domeHolder };
  }

  private groundImpact(P: THREE.Vector3, R: THREE.Vector3, fx: Effects, zones: ReturnType<GameView['buildZones']>, fragmented: boolean) {
    const ground = P.clone().multiplyScalar(1.006);
    zones.group.visible = true;
    zones.shell.visible = true;
    // fireball, rising dust, flying debris, shock ring and a scorch mark
    const fire = glowSprite(0xffa23a, 0.2, 1);
    fire.position.copy(ground);
    const core = glowSprite(0xfff3d6, 0.12, 1);
    core.position.copy(ground);
    this.eScene.add(fire, core);
    const dust: THREE.Sprite[] = [];
    for (let i = 0; i < 4; i++) {
      const d = new THREE.Sprite(new THREE.SpriteMaterial({ map: (fire.material as THREE.SpriteMaterial).map, color: 0x4a3426, transparent: true, opacity: 0, depthWrite: false }));
      d.position.copy(ground);
      d.scale.setScalar(0.05);
      this.eScene.add(d);
      dust.push(d);
    }
    const up = P.clone().normalize();
    this.debris(ground, up, fragmented ? 200 : 320, 0.42);
    this.debris(ground, up.clone().addScaledVector(R, 0.8).normalize(), fragmented ? 90 : 160, 0.28);
    if (fragmented) {
      // the pieces land over a wide area: smaller blasts around the main one
      for (let i = 0; i < 6; i++) {
        const a = Math.random() * Math.PI * 2, r = 0.03 + Math.random() * 0.07;
        const t1 = new THREE.Vector3().crossVectors(up, UP).normalize();
        const t2 = new THREE.Vector3().crossVectors(up, t1).normalize();
        const at = up.clone().addScaledVector(t1, Math.cos(a) * r).addScaledVector(t2, Math.sin(a) * r).normalize().multiplyScalar(1.006);
        const delay = 0.15 + Math.random() * 0.7;
        let tt = 0, started = false, sp: THREE.Sprite | null = null;
        this.anims.push((dt) => {
          tt += dt;
          if (tt < delay) return false;
          if (!started) { started = true; sp = glowSprite(0xffb36b, 0.05, 1); sp.position.copy(at); this.eScene.add(sp); this.debris(at, up, 60, 0.22); }
          const k = tt - delay;
          sp!.scale.setScalar(0.05 + k * 0.12);
          (sp!.material as THREE.SpriteMaterial).opacity = Math.max(0, 1 - k * 1.2);
          if (k > 0.9) { this.eScene.remove(sp!); return true; }
          return false;
        });
      }
    }
    const shock = new THREE.Mesh(new THREE.RingGeometry(0.97, 1, 96), new THREE.MeshBasicMaterial({ color: 0xffe2b0, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }));
    shock.position.copy(P.clone().multiplyScalar(1.01));
    shock.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), up);
    this.eScene.add(shock);
    const scorch = new THREE.Mesh(new THREE.CircleGeometry(Math.max(fx.rA, 8) / 6371 * 1.1, 48), new THREE.MeshBasicMaterial({ color: 0x1a0d06, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
    scorch.position.copy(P.clone().multiplyScalar(1.007));
    scorch.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), up);
    this.eScene.add(scorch);
    let t = 0;
    this.anims.push((dt) => {
      t += dt;
      const f = ease.out(ease.clamp01(t / 1.2));
      fire.scale.setScalar(0.06 + f * 0.34);
      (fire.material as THREE.SpriteMaterial).opacity = Math.max(0, 1 - Math.max(0, t - 0.8) / 2.2);
      core.scale.setScalar(0.04 + f * 0.14);
      (core.material as THREE.SpriteMaterial).opacity = Math.max(0, 1 - t / 1.0);
      dust.forEach((d, i) => {
        const tt = Math.max(0, t - 0.3 - i * 0.25);
        d.position.copy(ground).addScaledVector(up, tt * (0.05 + i * 0.025));
        d.scale.setScalar(0.05 + tt * (0.16 + i * 0.05));
        (d.material as THREE.SpriteMaterial).opacity = Math.min(0.55, tt * 0.8) * Math.max(0, 1 - tt / 4.2);
      });
      shock.scale.setScalar(0.02 + ease.out(ease.clamp01(t / 2.0)) * 0.28);
      (shock.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.95 * (1 - t / 2.0));
      (scorch.material as THREE.MeshBasicMaterial).opacity = Math.min(0.75, t * 0.6);
      for (let i = 0; i < 3; i++) {
        const k = ease.out(ease.clamp01((t - 0.35 - (2 - i) * 0.18) / 1.6));
        zones.uni.uK.value.setComponent(i, Math.max(0.001, k));
        zones.walls[i].scale.setScalar(Math.max(0.001, k));
      }
      const kc = ease.out(ease.clamp01((t - 0.2) / 1.2));
      zones.column.scale.setScalar(Math.max(0.001, kc));
      zones.domeHolder.scale.setScalar(Math.max(0.001, kc));
      zones.crater.scale.setScalar(Math.max(0.001, ease.out(ease.clamp01((t - 0.15) / 0.9))));
      if (t > 7) { this.eScene.remove(fire, core, shock, scorch, ...dust); return true; }
      return false;
    });
  }

  // ------------------------------------------------------------ small effects

  /** A scan wave sweeping the globe: telescope time was bought. */
  pulse() {
    // a soft glowing shell that swells and fades: no hard mesh lines
    const mat = new THREE.MeshBasicMaterial({ color: 0x7fd6ff, transparent: true, opacity: 0.16, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.BackSide });
    const shell = new THREE.Mesh(new THREE.SphereGeometry(1.012, 64, 40), mat);
    this.eScene.add(shell);
    let t = 0;
    this.anims.push((dt) => {
      t += dt;
      shell.scale.setScalar(1 + ease.out(Math.min(1, t / 1.2)) * 0.22);
      mat.opacity = Math.max(0, 0.16 * (1 - t / 1.2));
      if (t > 1.2) { this.eScene.remove(shell); shell.geometry.dispose(); mat.dispose(); return true; }
      return false;
    });
  }

  /** A ring on a city: evacuation planning started. */
  ping(lat: number, lon: number) {
    const mat = new THREE.LineBasicMaterial({ color: 0x7fd6ff, transparent: true, opacity: 1 });
    const n = latLonToVec3(lat, lon, 1);
    const g = new THREE.Group();
    g.position.copy(n.clone().multiplyScalar(1.006));
    g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 48; i++) { const a = (i / 48) * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a), Math.sin(a), 0)); }
    g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
    this.fx.add(g);
    let t = 0;
    this.anims.push((dt) => {
      t += dt;
      g.scale.setScalar((80 + t * 900) / 6371);
      mat.opacity = Math.max(0, 1 - t * 0.9);
      if (t > 1.15) { this.fx.remove(g); mat.dispose(); return true; }
      return false;
    });
  }

  // ------------------------------------------------------------ loop

  resize() {
    const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.baseFov = w / h < 0.9 ? 52 : 40;
    if (!this.camScript) this.eCam.fov = this.baseFov;
    for (const cam of [this.eCam, this.oCam]) { cam.aspect = w / h; cam.updateProjectionMatrix(); }
    this.eCtl.minDistance = this.minD;
    this.eCtl.maxDistance = this.maxD;
    (this.corridor.material as THREE.ShaderMaterial).uniforms.uScale.value = 6 * (Math.min(w, h * 1.3) / 700) * this.renderer.getPixelRatio();
  }

  private loop(now: number) {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, (now - (this.lastNow || now)) / 1000);
    this.lastNow = now;
    if (this.mode === 'earth') this.updateEarth(dt, now / 1000);
    else this.updateOrbit(dt);
    const rw = this.host.clientWidth || 1, rh = this.host.clientHeight || 1;
    for (const r of this.ribbons) r.setResolution(rw, rh);
    this.histLine.setResolution(rw, rh); this.histGlow.setResolution(rw, rh);
    this.renderer.render(this.mode === 'earth' ? this.eScene : this.oScene, this.mode === 'earth' ? this.eCam : this.oCam);
    if (this.mode === 'earth') this.updateLabels();
  }
  private lastNow = 0;

  private setLine(line: Ribbon, a: THREE.Vector3, b: THREE.Vector3) {
    line.setEnds(a, b);
  }

  private updateEarth(dt: number, time: number) {
    const scripted = !!this.camScript;
    if (scripted) {
      if (this.camScript!.fn(dt)) this.camScript = null;
    } else {
      if (this.camAnim) {
        const c = this.camAnim;
        if (c.live) {
          // the asteroid keeps moving while the camera flies to it: aim at where it is now
          const rp2 = this.rock.position;
          const side2 = new THREE.Vector3().crossVectors(this.pathR, UP).normalize();
          c.toTar.copy(rp2);
          c.toPos.copy(rp2).add(this.pathR.clone().multiplyScalar(0.3)).add(side2.multiplyScalar(0.2)).add(new THREE.Vector3(0, 0.1, 0));
        }
        c.t = Math.min(1, c.t + dt / c.dur);
        const e = 1 - Math.pow(1 - c.t, 3);
        this.eCam.position.lerpVectors(c.fromPos, c.toPos, e);
        this.eCtl.target.lerpVectors(c.fromTar, c.toTar, e);
        if (c.t >= 1) { const cb = c.onDone; this.camAnim = null; cb?.(); }
      } else if (this.focusAnim) {
        const f = this.focusAnim;
        f.t = Math.min(1, f.t + dt / 1.1);
        const e = 1 - Math.pow(1 - f.t, 3);
        const len = f.from.length() + (f.to.length() - f.from.length()) * e;
        const dir = f.from.clone().normalize().lerp(f.to.clone().normalize(), e).normalize();
        this.eCam.position.copy(dir.multiplyScalar(len));
        if (f.t >= 1) this.focusAnim = null;
      } else if (this.spin && !this.reduceMotion && !this.follow) {
        const a = dt * 0.05;
        const p = this.eCam.position;
        const x = p.x * Math.cos(a) - p.z * Math.sin(a);
        const z = p.x * Math.sin(a) + p.z * Math.cos(a);
        p.x = x; p.z = z;
      } else if (!this.reduceMotion) {
        this.idle += dt;
      }
      // follow the asteroid with the camera
      if (this.follow && !this.camAnim && this.followed) {
        const d = this.rock.position.clone().sub(this.eCtl.target);
        this.eCam.position.add(d);
        this.eCtl.target.copy(this.rock.position);
      }
      this.eCtl.update();
    }

    // the asteroid on its approach: along one straight line, which tracks the dots, tumbling
    if (!this.camScript?.ownsRock && !this.gameOver) {
      const k = 1 - Math.exp(-dt * 2.4);
      this.pathR.lerp(this.pathTR, k).normalize();
      // the line may only slide sideways at a calm speed, so a changing estimate never makes the rock dart about
      const stepTo = (cur: THREE.Vector3, goal: THREE.Vector3, rate: number, maxSpeed: number) => {
        const d = goal.clone().sub(cur).multiplyScalar(rate);
        const cap = maxSpeed * dt;
        if (d.length() > cap) d.setLength(cap);
        cur.add(d);
      };
      stepTo(this.pathO, this.pathTO, k, 0.9);
      stepTo(this.bias, this.biasTarget, 1 - Math.exp(-dt * 3), 1.1);
      const off = this.pathO.clone().add(this.bias);
      const targetS = 1.32 + 0.66 * Math.pow(this.leadFrac, 1.15);
      this.rockS += (targetS - this.rockS) * (1 - Math.exp(-dt * 3));
      this.rockJolt = Math.max(0, this.rockJolt - dt * 2.2);
      const basePos = this.pathR.clone().multiplyScalar(this.rockS).add(off);
      this.rock.position.copy(basePos);
      if (this.rockJolt > 0) this.rock.position.add(new THREE.Vector3((Math.random() - 0.5) * 0.01, (Math.random() - 0.5) * 0.01, (Math.random() - 0.5) * 0.01).multiplyScalar(this.rockJolt * 3));
      const moving = ease.clamp01(this.motion / 0.35);
      const spinRate = 0.3 + moving * 2.2;
      this.rock.rotation.y += dt * spinRate; this.rock.rotation.x += dt * spinRate * 0.45;
      const target = this.follow ? this.rockSize * 1.9 : this.rockSize;
      this.rock.scale.setScalar(this.rock.scale.x + (target - this.rock.scale.x) * (1 - Math.exp(-dt * 3)));
      // the fire tail is for motion only: it flares while time is running and is gone when it stops
      const tailOn = this.motion > 0.02 && this.corridor.visible && !this.fragmented;
      if (tailOn) {
        const size = this.rock.scale.x;
        this.rockTail.setScale(this.host.clientHeight || 600, this.eCam.fov);
        this.rockTail.set(this.rock.position, this.pathR, size * (3 + moving * 5), size * (0.3 + moving * 0.2), 0.5 + moving * 0.7, this.idleClock);
      }
      this.rockTail.points.visible = tailOn;
      const gm = this.rockGlow.material as THREE.SpriteMaterial;
      gm.opacity += ((tailOn ? 0.15 + moving * 0.2 : 0) - gm.opacity) * (1 - Math.exp(-dt * 6));
      this.rockGlow.position.copy(this.rock.position);
      this.rockGlow.scale.setScalar(0.07 + moving * 0.06);
      this.rockGlow.visible = this.corridor.visible && gm.opacity > 0.01;
      this.rock.visible = this.corridor.visible && !this.fragmented;
      // where it has been: a solid line through every place the rock really was
      const lastPt = this.hist[this.hist.length - 1];
      if (!lastPt || lastPt.distanceToSquared(basePos) > 0.0006) {
        this.hist.push(basePos.clone());
        if (this.hist.length > 700) this.hist = this.hist.filter((_, i) => i % 2 === 0 || i > this.hist.length - 120);
        this.histDirty = true;
      }
      const nowMs = performance.now();
      if (this.histDirty && nowMs - this.histBuiltAt > 60) {
        this.histDirty = false;
        this.histBuiltAt = nowMs;
        const pts = this.hist.length ? [...this.hist, basePos] : [];
        this.histLine.setPoints(pts);
        this.histGlow.setPoints(pts);
      }
      this.histLine.visible = this.histLine.visible && this.corridor.visible;
      this.histGlow.visible = this.histLine.visible;
      // where it is going: a dashed line on from the rock to where it meets (or passes) the planet
      const end = off.lengthSq() < 1 ? Math.sqrt(1 - off.lengthSq()) : -3;
      this.setLine(this.pathLine, basePos, off.clone().addScaledVector(this.pathR, end));
      this.pathLine.visible = this.corridor.visible;
      this.pathLine.flow(dt, 0.12 + this.motion * 0.8);
      this.newLine.flow(dt, 0.4); this.oldLine.flow(dt, 0.4);
      // broken pieces ride along
      if (this.fragmented) {
        const sideV = new THREE.Vector3().crossVectors(this.pathR, UP).normalize();
        const upV = new THREE.Vector3().crossVectors(sideV, this.pathR).normalize();
        const spread = ease.clamp01(1 - this.leadFrac * 0.4) * 0.12;
        this.frags.children.forEach((c, i) => {
          const o = this.fragOffsets[i] ?? new THREE.Vector3();
          c.position.copy(this.rock.position).addScaledVector(sideV, o.x * spread).addScaledVector(upV, o.y * spread).addScaledVector(this.pathR, o.z * spread * 1.6);
          c.rotation.y += dt * (0.6 + i * 0.15);
          c.scale.setScalar(0.05 * (c.userData.size ?? 0.3) * 2.2);
          c.visible = this.corridor.visible;
        });
      }
    } else if (this.gameOver && !this.camScript) {
      this.rockTail.points.visible = false;
      this.rockGlow.visible = false;
    }
    if (this.camScript?.ownsRock) {
      this.rockTail.points.visible = false;
      this.rockGlow.visible = false;
    }
    // hover glow follows what the pointer is over
    if (this.hoverId) {
      const tgt = this.hoverId === 'asteroid' ? this.rock : this.ships.get(this.hoverId)?.holder;
      if (tgt) {
        this.hoverGlow.position.copy(tgt.position);
        const base = this.hoverId === 'asteroid' ? this.rockSize : (this.ships.get(this.hoverId)?.size ?? 0.07);
        this.hoverGlow.scale.setScalar(base * 4.5 * (this.follow ? 1.5 : 1));
      }
    }
    void time;
    this.idleClock += dt;
    this.corridorCloud.update(dt);
    this.updateMissions();
    this.anims = this.anims.filter((f) => !f(dt));
  }

  private updateOrbit(dt: number) {
    this.oCtl.update();
    void dt;
  }

  private updateLabels() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    const cam = this.eCam;
    const camDir = cam.position.clone().normalize();
    const v = new THREE.Vector3();
    for (const l of this.labels) {
      const facing = l.vec.clone().normalize().dot(camDir) > 0.12;
      if (!facing || this.gameOver) { l.el.style.opacity = '0'; continue; }
      v.copy(l.vec).project(cam);
      l.el.style.opacity = '1';
      l.el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(10px, -50%)`;
    }
    for (const l of this.labels3) {
      v.copy(l.vec).project(cam);
      const facing = !l.surface || l.vec.clone().normalize().dot(camDir) > 0.08;
      const visible = facing && v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
      l.el.style.opacity = visible ? '1' : '0';
      l.el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, -50%)`;
    }
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.eCtl.dispose();
    this.oCtl.dispose();
    this.renderer.dispose();
    this.canvas.remove();
    for (const l of this.labels) l.el.remove();
    this.clearLabels3();
  }
}
