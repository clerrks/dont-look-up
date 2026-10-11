import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';

let glow: THREE.CanvasTexture | null = null;
export function glowTexture(): THREE.CanvasTexture {
  if (!glow) {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d')!;
    const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.25, 'rgba(255,255,255,0.55)');
    grd.addColorStop(0.6, 'rgba(255,255,255,0.12)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 128, 128);
    glow = new THREE.CanvasTexture(c);
    glow.colorSpace = THREE.SRGBColorSpace;
  }
  return glow;
}

export function glowSprite(color: number, size: number, opacity = 1): THREE.Sprite {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false }));
  s.scale.setScalar(size);
  return s;
}

/** A tail of soft points streaming behind something fast: sparks, exhaust, a fireball's wake. */
export class Trail {
  readonly points: THREE.Points;
  private pos: Float32Array;
  private col: Float32Array;
  private n: number;

  constructor(n = 48, size = 0.035) {
    this.n = n;
    this.pos = new Float32Array(n * 3);
    this.col = new Float32Array(n * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    this.points = new THREE.Points(g, new THREE.PointsMaterial({ size, map: glowTexture(), vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true }));
    this.points.frustumCulled = false;
  }

  /** `dir` points from the head backwards along the tail. */
  set(head: THREE.Vector3, dir: THREE.Vector3, length: number, strength: number, hot = new THREE.Color(1, 0.78, 0.4), cool = new THREE.Color(0.9, 0.25, 0.05)) {
    const c = new THREE.Color();
    for (let i = 0; i < this.n; i++) {
      const f = i / (this.n - 1);
      const jitter = (Math.sin(i * 12.9898) * 43758.5453) % 1;
      this.pos[i * 3] = head.x + dir.x * length * f + jitter * 0.004;
      this.pos[i * 3 + 1] = head.y + dir.y * length * f + jitter * 0.004;
      this.pos[i * 3 + 2] = head.z + dir.z * length * f + jitter * 0.004;
      c.copy(hot).lerp(cool, Math.min(1, f * 1.4)).multiplyScalar(strength * Math.pow(1 - f, 1.6));
      this.col[i * 3] = c.r; this.col[i * 3 + 1] = c.g; this.col[i * 3 + 2] = c.b;
    }
    (this.points.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.points.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose() {
    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}

/** Debris and sparks thrown out of a collision, pulled back by gravity. */
export class Burst {
  readonly points: THREE.Points;
  private pos: Float32Array;
  private vel: Float32Array;
  private col: Float32Array;
  private life: Float32Array;
  private base: Float32Array;
  private n: number;
  private age = 0;
  private gravity: number;

  constructor(origin: THREE.Vector3, dirs: THREE.Vector3[], speed: number, colors: THREE.Color[], size = 0.03, gravity = 0.12, lifeMax = 2.4) {
    this.n = dirs.length;
    this.gravity = gravity;
    this.pos = new Float32Array(this.n * 3);
    this.vel = new Float32Array(this.n * 3);
    this.col = new Float32Array(this.n * 3);
    this.base = new Float32Array(this.n * 3);
    this.life = new Float32Array(this.n);
    for (let i = 0; i < this.n; i++) {
      const s = speed * (0.35 + Math.random() * 0.9);
      this.pos.set([origin.x, origin.y, origin.z], i * 3);
      this.vel.set([dirs[i].x * s, dirs[i].y * s, dirs[i].z * s], i * 3);
      const c = colors[i % colors.length];
      this.base.set([c.r, c.g, c.b], i * 3);
      this.life[i] = lifeMax * (0.45 + Math.random() * 0.55);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    this.points = new THREE.Points(g, new THREE.PointsMaterial({ size, map: glowTexture(), vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true }));
    this.points.frustumCulled = false;
  }

  update(dt: number): boolean {
    this.age += dt;
    let alive = 0;
    const tmp = new THREE.Vector3();
    for (let i = 0; i < this.n; i++) {
      const f = this.age / this.life[i];
      if (f >= 1) { this.col[i * 3] = this.col[i * 3 + 1] = this.col[i * 3 + 2] = 0; continue; }
      alive++;
      tmp.set(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]);
      const r = Math.max(0.3, tmp.length());
      const gx = (-tmp.x / r) * this.gravity, gy = (-tmp.y / r) * this.gravity, gz = (-tmp.z / r) * this.gravity;
      this.vel[i * 3] += gx * dt; this.vel[i * 3 + 1] += gy * dt; this.vel[i * 3 + 2] += gz * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt; this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt; this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      const k = Math.pow(1 - f, 1.4);
      this.col[i * 3] = this.base[i * 3] * k; this.col[i * 3 + 1] = this.base[i * 3 + 1] * k; this.col[i * 3 + 2] = this.base[i * 3 + 2] * k;
    }
    (this.points.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.points.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    return alive === 0;
  }

  dispose() {
    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}

export function randomCone(axis: THREE.Vector3, halfAngle: number, n: number): THREE.Vector3[] {
  const a = axis.clone().normalize();
  const t = new THREE.Vector3().crossVectors(a, Math.abs(a.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize();
  const b = new THREE.Vector3().crossVectors(a, t);
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) {
    const phi = Math.random() * Math.PI * 2;
    const th = Math.acos(1 - Math.random() * (1 - Math.cos(halfAngle)));
    out.push(a.clone().multiplyScalar(Math.cos(th)).add(t.clone().multiplyScalar(Math.sin(th) * Math.cos(phi))).add(b.clone().multiplyScalar(Math.sin(th) * Math.sin(phi))));
  }
  return out;
}

export const ease = {
  inOut: (x: number) => x * x * (3 - 2 * x),
  out: (x: number) => 1 - Math.pow(1 - x, 3),
  in: (x: number) => x * x,
  clamp01: (x: number) => Math.max(0, Math.min(1, x)),
};

/** A dashed line a few pixels wide that can march: used for the path the asteroid is flying along. */
export class Ribbon extends Line2 {
  private key = '';

  constructor(color: number, opacity: number, width: number, dash: number, gap: number) {
    const g = new LineGeometry();
    g.setPositions([0, 0, 0, 0, 0, 1]);
    super(g, new LineMaterial({ color, linewidth: width, dashed: true, dashSize: dash, gapSize: gap, transparent: true, opacity, depthWrite: false }));
    this.frustumCulled = false;
  }

  setEnds(a: THREE.Vector3, b: THREE.Vector3) {
    const key = `${a.x.toFixed(4)},${a.y.toFixed(4)},${a.z.toFixed(4)},${b.x.toFixed(4)},${b.y.toFixed(4)},${b.z.toFixed(4)}`;
    if (key === this.key) return;
    this.key = key;
    (this.geometry as LineGeometry).setPositions([a.x, a.y, a.z, b.x, b.y, b.z]);
    this.computeLineDistances();
  }

  setDash(dash: number, gap: number) {
    const m = this.material as LineMaterial;
    m.dashSize = dash;
    m.gapSize = gap;
  }

  /** Make the dashes slide from the first point toward the second: the way it is travelling. */
  flow(dt: number, speed: number) {
    (this.material as LineMaterial).dashOffset -= dt * speed;
  }

  setResolution(w: number, h: number) {
    (this.material as LineMaterial).resolution.set(w, h);
  }

  dispose() {
    this.geometry.dispose();
    (this.material as LineMaterial).dispose();
  }
}

/** The line an asteroid has already flown: a solid glowing polyline that fades toward where it started. */
export class Streak extends Line2 {
  private npts = 0;

  constructor(color: number, width: number, opacity: number) {
    const g = new LineGeometry();
    g.setPositions([0, 0, 0, 0, 0, 0.001]);
    super(g, new LineMaterial({ color: 0xffffff, linewidth: width, vertexColors: true, transparent: true, opacity, depthWrite: false }));
    this.tint = new THREE.Color(color);
    this.frustumCulled = false;
    this.visible = false;
  }

  private tint: THREE.Color;

  get pointCount() { return this.npts; }

  /** Replace the whole path. The oldest points are dim, the newest are bright. */
  setPoints(pts: THREE.Vector3[]) {
    this.npts = pts.length;
    if (pts.length < 2) { this.visible = false; return; }
    const pos: number[] = [];
    const col: number[] = [];
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      pos.push(pts[i].x, pts[i].y, pts[i].z);
      const f = 0.15 + 0.85 * Math.pow(i / (n - 1), 1.3);
      col.push(this.tint.r * f, this.tint.g * f, this.tint.b * f);
    }
    const g = this.geometry as LineGeometry;
    g.setPositions(pos);
    g.setColors(col);
    this.visible = true;
  }

  setResolution(w: number, h: number) {
    (this.material as LineMaterial).resolution.set(w, h);
  }

  dispose() {
    this.geometry.dispose();
    (this.material as LineMaterial).dispose();
  }
}

/**
 * A thick, wide flame behind something falling fast: a dense cone of soft glowing points, bright and wide at the head,
 * thinning and reddening toward the tip. Short and fat, not a long string of dots.
 */
export class FireTail {
  readonly points: THREE.Points;
  private n: number;
  private pos: Float32Array;
  private size: Float32Array;
  private alpha: Float32Array;
  private along: Float32Array;
  private seed: Float32Array;
  private mat: THREE.ShaderMaterial;

  constructor(n = 220) {
    this.n = n;
    this.pos = new Float32Array(n * 3);
    this.size = new Float32Array(n);
    this.alpha = new Float32Array(n);
    this.along = new Float32Array(n);
    this.seed = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      this.along[i] = Math.pow((i + Math.random() * 0.9) / n, 1.15);
      this.seed[i * 3] = Math.random() * 2 - 1;
      this.seed[i * 3 + 1] = Math.random() * 2 - 1;
      this.seed[i * 3 + 2] = Math.random();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    g.setAttribute('aAlong', new THREE.BufferAttribute(this.along, 1));
    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uPx: { value: 800 } },
      vertexShader: `
        attribute float aSize; attribute float aAlpha; attribute float aAlong;
        uniform float uPx;
        varying float vA; varying float vT;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = max(2.0, aSize * uPx / max(0.05, -mv.z));
          vA = aAlpha; vT = aAlong;
        }`,
      fragmentShader: `
        varying float vA; varying float vT;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float d = length(c) * 2.0;
          if (d > 1.0) discard;
          float soft = pow(1.0 - d, 1.6);
          vec3 hot = vec3(1.0, 0.93, 0.7);
          vec3 mid = vec3(1.0, 0.52, 0.14);
          vec3 cool = vec3(0.75, 0.12, 0.04);
          vec3 col = mix(hot, mid, smoothstep(0.0, 0.35, vT));
          col = mix(col, cool, smoothstep(0.3, 1.0, vT));
          gl_FragColor = vec4(col * soft * vA, soft * vA);
        }`,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
  }

  /** Pixels per world unit at distance 1 for the current camera. */
  setScale(viewHeightPx: number, fovDeg: number) {
    this.mat.uniforms.uPx.value = (viewHeightPx * 0.5) / Math.tan((fovDeg * Math.PI) / 360);
  }

  /**
   * `back` points from the head backwards along the flame. `radius` is the head's half-width (world units),
   * `length` how far the flame reaches, `strength` 0..1.5.
   */
  set(head: THREE.Vector3, back: THREE.Vector3, length: number, radius: number, strength: number, time: number) {
    const b = back.clone().normalize();
    const u = new THREE.Vector3().crossVectors(b, Math.abs(b.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize();
    const v = new THREE.Vector3().crossVectors(b, u);
    for (let i = 0; i < this.n; i++) {
      const t = this.along[i];
      const wob = 1 + 0.18 * Math.sin(time * 9 + this.seed[i * 3 + 2] * 40);
      const spread = radius * Math.pow(1 - t, 0.75) * wob;
      const a = this.seed[i * 3], c = this.seed[i * 3 + 1];
      const x = head.x + b.x * length * t + (u.x * a + v.x * c) * spread * 0.8;
      const y = head.y + b.y * length * t + (u.y * a + v.y * c) * spread * 0.8;
      const z = head.z + b.z * length * t + (u.z * a + v.z * c) * spread * 0.8;
      this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
      this.size[i] = radius * 1.6 * (1 - 0.8 * t) * (0.7 + 0.5 * this.seed[i * 3 + 2]);
      this.alpha[i] = strength * 0.22 * Math.pow(1 - t, 1.2) * (0.7 + 0.3 * Math.sin(time * 14 + i));
    }
    const g = this.points.geometry;
    (g.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute('aSize') as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute('aAlpha') as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose() {
    this.points.geometry.dispose();
    this.mat.dispose();
  }
}
