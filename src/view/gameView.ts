import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CITIES } from '../data/cities';
import { asteroidAt, earthAt, orbitPath, phaseFor, type Elements, type OrbitPhase } from '../sim/orbit';
import type { Corridor, Effects, Scenario } from '../sim/model';
import { circlePoints, latLonToVec3, makeLandMask, paintEarth, vec3ToLatLon } from './geo';

export interface MapLabel {
  id: string;
  text: string;
  lat: number;
  lon: number;
  tone: 'risk' | 'plan' | 'safe';
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

const POINT_VERT = /* glsl */ `
  attribute float aAlpha;
  varying float vA;
  uniform float uScale;
  void main() {
    vA = aAlpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = uScale * (1.6 + 2.6 * aAlpha) / -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;
const POINT_FRAG = /* glsl */ `
  varying float vA;
  uniform float uGain;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    if (d > 0.5) discard;
    float soft = smoothstep(0.5, 0.05, d);
    vec3 cool = vec3(1.0, 0.62, 0.18);
    vec3 hot = vec3(1.0, 0.93, 0.78);
    vec3 col = mix(cool, hot, smoothstep(0.55, 1.0, vA));
    gl_FragColor = vec4(col, soft * (0.18 + 0.62 * vA) * uGain);
  }
`;

export class GameView {
  readonly canvas: HTMLCanvasElement;
  readonly isLand: (lat: number, lon: number) => boolean;
  private renderer: THREE.WebGLRenderer;
  private host: HTMLElement;
  private labelHost: HTMLElement;
  private mode: 'earth' | 'orbit' = 'earth';
  private raf = 0;
  private disposed = false;
  private reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // earth scene
  private eScene = new THREE.Scene();
  private eCam: THREE.PerspectiveCamera;
  private eCtl: OrbitControls;
  private earth: THREE.Mesh;
  private corridorGeo: THREE.BufferGeometry;
  private corridor: THREE.Points;
  private fx = new THREE.Group();
  private rock: THREE.Mesh;
  private rockLine: THREE.Line;
  private labels: { el: HTMLElement; vec: THREE.Vector3; data: MapLabel }[] = [];
  private idle = 0;
  private spin = true;
  private focusAnim: { from: THREE.Vector3; to: THREE.Vector3; t: number } | null = null;
  private approach: { from: THREE.Vector3; to: THREE.Vector3; t: number; dur: number; done: () => void; impact: boolean } | null = null;
  private flash: THREE.Mesh | null = null;
  private shock: THREE.Mesh | null = null;
  private centroidVec: THREE.Vector3 | null = null;
  private leadFrac = 1;

  // orbit scene
  private oScene = new THREE.Scene();
  private oCam: THREE.PerspectiveCamera;
  private oCtl: OrbitControls;
  private oEarth!: THREE.Mesh;
  private oRock!: THREE.Mesh;
  private oPhase: OrbitPhase | null = null;
  private oElements: Elements | null = null;
  private oObjects = new THREE.Group();
  private oEarthTrail!: THREE.Line;

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

    this.isLand = makeLandMask();

    // ---- earth scene
    this.eCam = new THREE.PerspectiveCamera(38, 1, 0.05, 200);
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

    this.corridorGeo = new THREE.BufferGeometry();
    this.corridorGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(4300 * 3), 3));
    this.corridorGeo.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(4300), 1));
    this.corridorGeo.setDrawRange(0, 0);
    this.corridor = new THREE.Points(
      this.corridorGeo,
      new THREE.ShaderMaterial({
        vertexShader: POINT_VERT, fragmentShader: POINT_FRAG, transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending, uniforms: { uScale: { value: 6 }, uGain: { value: 1 } },
      }),
    );
    this.corridor.frustumCulled = false;
    this.eScene.add(this.corridor);
    this.eScene.add(this.fx);

    this.rock = this.makeRock(0.016);
    this.eScene.add(this.rock);
    const lg = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, 1)]);
    this.rockLine = new THREE.Line(lg, new THREE.LineDashedMaterial({ color: COL.asteroid, dashSize: 0.03, gapSize: 0.03, transparent: true, opacity: 0.45 }));
    this.eScene.add(this.rockLine);

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

  private makeAtmosphere(): THREE.Mesh {
    const m = new THREE.ShaderMaterial({
      transparent: true, side: THREE.BackSide, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `varying vec3 vN; varying vec3 vV; void main(){ vN = normalize(normalMatrix*normal); vec4 mv = modelViewMatrix*vec4(position,1.0); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }`,
      fragmentShader: `varying vec3 vN; varying vec3 vV; void main(){ gl_FragColor = vec4(0.30,0.58,1.0,1.0) * pow(clamp(-dot(vN, vV) * 2.1, 0.0, 1.0), 2.4) * 0.55; }`,
    });
    return new THREE.Mesh(new THREE.SphereGeometry(1.14, 64, 48), m);
  }

  private makeStars(): THREE.Points {
    const n = 1400;
    const pos = new Float32Array(n * 3);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < n; i++) {
      const u = rnd() * 2 - 1, th = rnd() * Math.PI * 2, s = Math.sqrt(1 - u * u);
      const r = 60 + rnd() * 20;
      pos.set([r * s * Math.cos(th), r * u, r * s * Math.sin(th)], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    return new THREE.Points(g, new THREE.PointsMaterial({ color: 0x9fb4d8, size: 0.16, sizeAttenuation: true, transparent: true, opacity: 0.7, depthWrite: false }));
  }

  private addCityDots() {
    const pos = new Float32Array(CITIES.length * 3);
    CITIES.forEach((c, i) => latLonToVec3(c.lat, c.lon, 1.002).toArray(pos, i * 3));
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.eScene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0x9fe3ff, size: 0.014, sizeAttenuation: true, transparent: true, opacity: 0.85, depthWrite: false })));
  }

  private makeRock(radius: number): THREE.Mesh {
    const geo = new THREE.IcosahedronGeometry(radius, 2);
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const v = new THREE.Vector3().fromBufferAttribute(p, i);
      const k = 1 + 0.28 * Math.sin(v.x * 190 + 1.3) * Math.cos(v.y * 170) + 0.12 * Math.sin(v.z * 260);
      v.multiplyScalar(k);
      p.setXYZ(i, v.x, v.y, v.z);
    }
    geo.computeVertexNormals();
    return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xb08a5e, roughness: 1, emissive: 0x3a1f08, emissiveIntensity: 0.9 }));
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
    this.oEarthTrail = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: COL.earthDot, transparent: true, opacity: 0.0 }));
    this.oScene.add(this.oEarthTrail);
  }

  // ------------------------------------------------------------ public API

  setScenario(sc: Scenario) {
    this.leadFrac = 1;
    this.clearFx();
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
    this.eCam.position.set(0.4, 1.3, 3.5);
    this.eCtl.target.set(0, 0, 0);
    this.spin = !this.reduceMotion;
  }

  setMode(m: 'earth' | 'orbit') {
    this.mode = m;
    this.eCtl.enabled = m === 'earth';
    this.oCtl.enabled = m === 'orbit';
    for (const l of this.labels) l.el.style.display = m === 'earth' ? '' : 'none';
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

  setCorridor(c: Corridor) {
    const pos = this.corridorGeo.getAttribute('position') as THREE.BufferAttribute;
    const al = this.corridorGeo.getAttribute('aAlpha') as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    for (let i = 0; i < c.count; i++) {
      latLonToVec3(c.lat[i], c.lon[i], 1.004, v);
      pos.setXYZ(i, v.x, v.y, v.z);
      al.setX(i, c.alpha[i]);
    }
    pos.needsUpdate = true; al.needsUpdate = true;
    this.corridorGeo.setDrawRange(0, c.count);
    (this.corridor.material as THREE.ShaderMaterial).uniforms.uGain.value = Math.max(0.4, Math.min(1, 1800 / Math.max(1, c.count)));
    this.centroidVec = c.centroid ? latLonToVec3(c.centroid.lat, c.centroid.lon, 1) : null;
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

  focus(lat: number, lon: number, dist = 2.9) {
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
    this.approach = null;
    this.flash = null;
    this.shock = null;
    while (this.fx.children.length) {
      const o = this.fx.children[0] as any;
      this.fx.remove(o);
      o.geometry?.dispose?.();
      o.material?.dispose?.();
    }
    this.rock.visible = true;
  }

  /** Fly the rock in, then show the damage zones (hit) or a clean pass (miss). */
  playOutcome(opts: { hit: boolean; site: { lat: number; lon: number } | null; effects: Effects; missRe: number; sc: Scenario }, done: () => void) {
    this.setMode('earth');
    this.clearFx();
    this.corridor.visible = false;
    const sc = opts.sc;
    let to: THREE.Vector3;
    let from: THREE.Vector3;
    if (opts.hit && opts.site) {
      to = latLonToVec3(opts.site.lat, opts.site.lon, 1.0);
      const out = to.clone().normalize();
      const side = new THREE.Vector3().crossVectors(out, new THREE.Vector3(0, 1, 0)).normalize().multiplyScalar(0.7);
      from = out.clone().multiplyScalar(6).add(side);
      this.focus(opts.site.lat, opts.site.lon, 2.15);
    } else {
      const c = this.centroidVec ?? latLonToVec3(sc.radiant.lat, sc.radiant.lon, 1);
      const out = c.clone().normalize();
      const side = new THREE.Vector3().crossVectors(out, new THREE.Vector3(0, 1, 0)).normalize();
      const offset = Math.min(1.9, 1.15 + Math.log10(1 + opts.missRe) * 0.5);
      const p = out.clone().multiplyScalar(0.25).add(side.clone().multiplyScalar(offset));
      to = p.clone().add(out.clone().multiplyScalar(-6));
      from = p.clone().add(out.clone().multiplyScalar(6));
      const ll = vec3ToLatLon(out);
      this.focus(ll.lat, ll.lon, 4.2);
    }
    this.rock.visible = true;
    this.rock.position.copy(from);
    this.approach = { from, to, t: 0, dur: this.reduceMotion ? 0.01 : opts.hit ? 3.2 : 3.6, done: () => {
      if (opts.hit && opts.site) this.showImpact(opts.site, opts.effects);
      done();
    }, impact: opts.hit };
  }

  private showImpact(site: { lat: number; lon: number }, fx: Effects) {
    this.rock.visible = false;
    const zones: [number, number][] = [
      [fx.rC, COL.zoneC],
      [fx.rB, COL.zoneB],
      [Math.max(fx.rA, 12), COL.zoneA],
    ];
    for (const [km, color] of zones) {
      const ring = circlePoints(site.lat, site.lon, km, 128, 1.004);
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(ring), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95 }));
      this.fx.add(line);
      const center = latLonToVec3(site.lat, site.lon, 1.003);
      const verts = [center, ...ring];
      const idx: number[] = [];
      for (let i = 1; i < verts.length - 1; i++) idx.push(0, i, i + 1);
      const g = new THREE.BufferGeometry().setFromPoints(verts);
      g.setIndex(idx);
      this.fx.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.2, depthWrite: false, side: THREE.DoubleSide })));
    }
    const flash = new THREE.Mesh(new THREE.SphereGeometry(0.05, 24, 16), new THREE.MeshBasicMaterial({ color: 0xfff1d0, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false }));
    flash.position.copy(latLonToVec3(site.lat, site.lon, 1.01));
    this.flash = flash;
    this.fx.add(flash);
    // a visible marker even when the true damage radius is only a few pixels wide
    const mark = circlePoints(site.lat, site.lon, 260, 64, 1.006);
    this.fx.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(mark), new THREE.LineBasicMaterial({ color: 0xfff1d0, transparent: true, opacity: 0.9 })));
    const shock = new THREE.Mesh(new THREE.RingGeometry(0.97, 1.0, 96), new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }));
    const n = latLonToVec3(site.lat, site.lon, 1).normalize();
    shock.position.copy(n.clone().multiplyScalar(1.008));
    shock.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    shock.scale.setScalar(0.02);
    this.shock = shock;
    this.fx.add(shock);
  }

  showCorridor(on: boolean) { this.corridor.visible = on; }

  // ------------------------------------------------------------ loop

  resize() {
    const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    for (const cam of [this.eCam, this.oCam]) { cam.aspect = w / h; cam.updateProjectionMatrix(); }
    // On narrow canvases pull the camera back so the planet always fits.
    const base = w / h < 0.9 ? 1.45 : 1;
    this.eCtl.minDistance = 1.5;
    this.eCtl.maxDistance = 7;
    (this.corridor.material as THREE.ShaderMaterial).uniforms.uScale.value = 6 * (Math.min(w, h * 1.3) / 700) * this.renderer.getPixelRatio();
    void base;
    this.eCam.fov = w / h < 0.9 ? 50 : 38;
    this.eCam.updateProjectionMatrix();
  }

  private loop(now: number) {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, (now - (this.lastNow || now)) / 1000);
    this.lastNow = now;
    if (this.mode === 'earth') this.updateEarth(dt, now / 1000);
    else this.updateOrbit(dt);
    this.renderer.render(this.mode === 'earth' ? this.eScene : this.oScene, this.mode === 'earth' ? this.eCam : this.oCam);
    if (this.mode === 'earth') this.updateLabels();
  }
  private lastNow = 0;

  private updateEarth(dt: number, time: number) {
    if (this.focusAnim) {
      const f = this.focusAnim;
      f.t = Math.min(1, f.t + dt / 1.1);
      const e = 1 - Math.pow(1 - f.t, 3);
      const len = f.from.length() + (f.to.length() - f.from.length()) * e;
      const dir = f.from.clone().normalize().lerp(f.to.clone().normalize(), e).normalize();
      this.eCam.position.copy(dir.multiplyScalar(len));
      if (f.t >= 1) this.focusAnim = null;
    } else if (this.spin && !this.reduceMotion) {
      const a = dt * 0.05;
      const p = this.eCam.position;
      const x = p.x * Math.cos(a) - p.z * Math.sin(a);
      const z = p.x * Math.sin(a) + p.z * Math.cos(a);
      p.x = x; p.z = z;
    } else if (!this.reduceMotion) {
      this.idle += dt;
    }
    this.eCtl.update();

    // asteroid on approach: distance shrinks with time left
    if (!this.approach) {
      const dir = (this.centroidVec ?? new THREE.Vector3(0.3, 0.4, 0.86)).clone().normalize();
      const dist = 1.32 + 1.2 * this.leadFrac;
      this.rock.position.copy(dir.clone().multiplyScalar(dist));
      this.rock.rotation.y = time * 0.6;
      this.rock.rotation.x = time * 0.35;
      const lp = this.rockLine.geometry.getAttribute('position') as THREE.BufferAttribute;
      lp.setXYZ(0, this.rock.position.x, this.rock.position.y, this.rock.position.z);
      const tip = dir.clone().multiplyScalar(1.005);
      lp.setXYZ(1, tip.x, tip.y, tip.z);
      lp.needsUpdate = true;
      this.rockLine.computeLineDistances();
      this.rockLine.visible = !!this.centroidVec && this.corridor.visible;
      this.rock.visible = this.corridor.visible;
    } else {
      this.rockLine.visible = false;
      const a = this.approach;
      a.t = Math.min(1, a.t + dt / a.dur);
      const e = a.impact ? a.t * a.t * (3 - 2 * a.t) * 0.35 + a.t * 0.65 : a.t;
      this.rock.position.lerpVectors(a.from, a.to, e);
      this.rock.rotation.y += dt * 2;
      if (a.t >= 1) {
        const cb = a.done;
        this.approach = null;
        cb();
      }
    }
    if (this.shock) {
      const m = this.shock.material as THREE.MeshBasicMaterial;
      const sc2 = Math.min(0.26, this.shock.scale.x + dt * 0.12);
      this.shock.scale.setScalar(sc2);
      m.opacity = Math.max(0, 0.9 * (1 - sc2 / 0.26));
      if (m.opacity <= 0.01) { this.fx.remove(this.shock); this.shock = null; }
    }
    if (this.flash) {
      const m = this.flash.material as THREE.MeshBasicMaterial;
      const s = Math.min(3.5, this.flash.scale.x + dt * 4);
      this.flash.scale.setScalar(s);
      m.opacity = Math.max(0, m.opacity - dt * 0.7);
      if (m.opacity <= 0) { this.fx.remove(this.flash); this.flash = null; }
    }
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
      if (!facing) { l.el.style.opacity = '0'; continue; }
      v.copy(l.vec).project(cam);
      l.el.style.opacity = '1';
      l.el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(10px, -50%)`;
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
  }
}
