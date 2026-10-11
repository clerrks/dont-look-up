// Small spinning 3D asteroids for the home screen. One shared WebGL renderer draws every rock in turn
// and copies the picture into each row's own canvas, so ten rocks cost one extra graphics context, not ten.
import * as THREE from 'three';
import { rockTemplate } from '../view/models';

interface Spinner {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  model: THREE.Object3D | null;
  phase: number;
  tiltX: number;
  tiltZ: number;
  rate: number;
  visible: boolean;
  drawn: boolean;
}

const spinners = new Set<Spinner>();
const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
let gl: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene;
let cam: THREE.PerspectiveCamera;
let io: IntersectionObserver | null = null;
let raf = 0;
let lastDraw = 0;
let px = 128;
let broken = false;

function setup(): boolean {
  if (gl) return true;
  if (broken) return false;
  try {
    gl = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' });
  } catch {
    broken = true;
    return false;
  }
  px = 224;
  gl.setPixelRatio(1);
  gl.setSize(px, px, false);
  gl.setClearColor(0x000000, 0);
  scene = new THREE.Scene();
  cam = new THREE.PerspectiveCamera(32, 1, 0.1, 10);
  cam.position.set(0, 0, 3.1);
  scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x4a3822, 1.5));
  const key = new THREE.DirectionalLight(0xffe0b0, 3.2);
  key.position.set(2.2, 1.6, 2.6);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x6aa8ff, 1.6);
  rim.position.set(-2.4, -0.4, -1.6);
  scene.add(rim);
  io = new IntersectionObserver((entries) => {
    for (const en of entries) for (const s of spinners) if (s.canvas === en.target) s.visible = en.isIntersecting;
  });
  return true;
}

function frame(now: number) {
  raf = requestAnimationFrame(frame);
  if (document.hidden || !gl || now - lastDraw < 33) return;
  lastDraw = now;
  const t = now / 1000;
  for (const s of spinners) {
    if (!s.canvas.isConnected) { spinners.delete(s); io?.unobserve(s.canvas); continue; }
    if (!s.model || !s.visible || (still && s.drawn)) continue;
    s.model.rotation.set(s.tiltX + Math.sin(t * 0.5 + s.phase) * 0.14, still ? s.phase : t * s.rate + s.phase, s.tiltZ);
    scene.add(s.model);
    gl.render(scene, cam);
    scene.remove(s.model);
    s.ctx.clearRect(0, 0, s.canvas.width, s.canvas.height);
    s.ctx.drawImage(gl.domElement, 0, 0, s.canvas.width, s.canvas.height);
    s.drawn = true;
  }
  if (!spinners.size) { cancelAnimationFrame(raf); raf = 0; }
}

/** Find the `canvas.spin3d` elements under `root` and start a different rock spinning on each. */
export function spinRocks(root: HTMLElement) {
  if (!setup()) return;
  root.querySelectorAll<HTMLCanvasElement>('canvas.spin3d:not([data-ready])').forEach((canvas) => {
    canvas.dataset.ready = '1';
    const css = canvas.clientWidth || Number(canvas.dataset.css) || 64;
    const bw = Math.min(px, Math.round(css * Math.min(2, window.devicePixelRatio || 1)));
    canvas.width = bw;
    canvas.height = bw;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const seed = Number(canvas.dataset.seed ?? 0);
    const s: Spinner = {
      canvas, ctx, model: null, visible: true, drawn: false,
      phase: seed * 1.7, tiltX: 0.25 + 0.2 * Math.sin(seed * 2.1), tiltZ: 0.2 * Math.cos(seed * 1.3), rate: 0.55 + 0.3 * ((seed * 7) % 5) / 5,
    };
    spinners.add(s);
    io?.observe(canvas);
    void rockTemplate(seed).then((tpl) => {
      // every row gets its own squash and stretch, so even two copies of one model look like different rocks
      const holder = new THREE.Group();
      const m = tpl.clone(true);
      m.scale.set(1 + 0.2 * Math.sin(seed * 1.9), 1 + 0.18 * Math.sin(seed * 2.7 + 1), 1 + 0.2 * Math.sin(seed * 3.3 + 2));
      holder.add(m);
      holder.scale.setScalar(1.12);
      s.model = holder;
    }).catch(() => undefined);
  });
  if (!raf && spinners.size) raf = requestAnimationFrame(frame);
}
