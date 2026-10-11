// "Possible paths": the asteroid on the left, Earth on the right, one glowing line per path it might still take.
// Amber lines miss. Red lines hit Earth. Spending narrows the fan or turns red lines amber.
import { diskNormals, type Scenario } from '../sim/model';
import { paintEarth } from './geo';

export interface Blob {
  xi: number;
  zeta: number;
  sxi: number;
  szeta: number;
}

export interface TargetState {
  now: Blob;
  /** hover preview: shrink the fan and/or turn some red lines amber */
  preview?: { sigmaScale?: number; redScale?: number } | null;
  /** outcome screen: where it would have gone and where it went */
  marks?: { xi: number; zeta: number; kind: 'before' | 'after' }[];
  hideCloud?: boolean;
}

const N_LINES = 120;

let iconImg: HTMLImageElement | null = null;
function icon(): HTMLImageElement {
  if (!iconImg) { iconImg = new Image(); iconImg.src = '/asteroid-rock.png'; }
  return iconImg;
}

const earthSprites = new Map<number, HTMLCanvasElement>();
let earthTex: ImageData | null = null;

/** Earth as a lit sphere, sampled from the same map as the globe. */
function earthSprite(px: number): HTMLCanvasElement {
  const size = Math.max(24, Math.round(px));
  const hit = earthSprites.get(size);
  if (hit) return hit;
  if (!earthTex) {
    const cv = paintEarth(1024, 512, { ocean: ['#0a2a52', '#0f3e73'], land: '#3f7a52', coast: '#8fd0a0', grid: 'rgba(0,0,0,0)' });
    earthTex = cv.getContext('2d')!.getImageData(0, 0, 1024, 512);
  }
  const pad = Math.round(size * 0.18);
  const full = size + pad * 2;
  const out = document.createElement('canvas');
  out.width = out.height = full;
  const ctx = out.getContext('2d')!;
  const img = ctx.createImageData(full, full);
  const r = size / 2, c = full / 2;
  const lat0 = 0.35, lon0 = -1.2;
  const L = { x: -0.55, y: 0.45, z: 0.7 };
  const ll = Math.hypot(L.x, L.y, L.z);
  for (let y = 0; y < full; y++) {
    for (let x = 0; x < full; x++) {
      const nx = (x - c + 0.5) / r, ny = -(y - c + 0.5) / r;
      const d2 = nx * nx + ny * ny;
      const o = (y * full + x) * 4;
      if (d2 > 1) continue;
      const nz = Math.sqrt(1 - d2);
      const y1 = ny * Math.cos(lat0) + nz * Math.sin(lat0);
      const z1 = -ny * Math.sin(lat0) + nz * Math.cos(lat0);
      const lat = Math.asin(y1);
      const lon = lon0 + Math.atan2(nx, z1);
      const u = (((lon / (2 * Math.PI)) + 0.5) % 1 + 1) % 1;
      const v = 0.5 - lat / Math.PI;
      const ti = (Math.min(511, Math.floor(v * 512)) * 1024 + Math.min(1023, Math.floor(u * 1024))) * 4;
      const lam = Math.max(0, (nx * L.x + ny * L.y + nz * L.z) / ll);
      const shade = 0.28 + 0.95 * lam;
      const rim = Math.pow(1 - nz, 2.2);
      const spec = Math.pow(Math.max(0, (nx * L.x + ny * L.y + nz * L.z) / ll), 14) * 0.18;
      img.data[o] = Math.min(255, earthTex.data[ti] * shade + rim * 60 + spec * 255);
      img.data[o + 1] = Math.min(255, earthTex.data[ti + 1] * shade + rim * 120 + spec * 255);
      img.data[o + 2] = Math.min(255, earthTex.data[ti + 2] * shade + rim * 220 + spec * 255);
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  // soft atmosphere
  const g = ctx.createRadialGradient(c, c, r * 0.96, c, c, r * 1.16);
  g.addColorStop(0, 'rgba(110,190,255,0.55)');
  g.addColorStop(1, 'rgba(110,190,255,0)');
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(c, c, r * 1.16, 0, Math.PI * 2); ctx.fill();
  earthSprites.set(size, out);
  return out;
}

export class TargetView {
  private ctx: CanvasRenderingContext2D;
  private cur: Blob;
  private tgt: TargetState;
  private scaleCur = 1;
  private redCur = 1;
  private span = 6;
  private raf = 0;
  private last = 0;
  private zx: Float32Array;
  private zz: Float32Array;
  private stars: { x: number; y: number; a: number }[] = [];
  private ro: ResizeObserver;
  private io: IntersectionObserver;
  private visible = true;
  private clock = 0;
  private reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  constructor(private canvas: HTMLCanvasElement, private sc: Scenario) {
    this.ctx = canvas.getContext('2d')!;
    const n = diskNormals(sc);
    this.zx = n.zx;
    this.zz = n.zz;
    this.cur = { xi: 0, zeta: 0, sxi: 1, szeta: 1 };
    this.tgt = { now: this.cur };
    let s = 11;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 60; i++) this.stars.push({ x: rnd(), y: rnd(), a: 0.15 + rnd() * 0.5 });
    this.ro = new ResizeObserver(() => this.kick());
    this.ro.observe(canvas);
    this.io = new IntersectionObserver((e) => { this.visible = e.some((x) => x.isIntersecting); if (this.visible) this.kick(); });
    this.io.observe(canvas);
    icon();
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.io.disconnect();
  }

  set(state: TargetState, jump = false) {
    this.tgt = state;
    if (jump || this.reduce) {
      this.cur = { ...state.now };
      this.scaleCur = state.preview?.sigmaScale ?? 1;
      this.redCur = state.preview?.redScale ?? 1;
      this.span = state.marks?.length ? this.wantMarksSpan(state) : this.wantSpan(this.cur, this.scaleCur);
    }
    this.kick();
  }

  private wantSpan(a: Blob, scale: number) {
    const b = this.sc.bImp;
    const reach = Math.abs(a.zeta) * 1.1 + 2.0 * a.szeta * scale;
    return Math.min(Math.max(b * 2.4, reach), 7 * b);
  }

  private wantMarksSpan(t: TargetState) {
    const b = this.sc.bImp;
    const far = Math.max(...(t.marks ?? []).map((m) => Math.hypot(m.xi, m.zeta)), 0);
    return Math.min(Math.max(b * 2.2, far * 1.25), 9 * b);
  }

  private kick() {
    if (this.raf || !this.visible) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number) => {
    this.raf = 0;
    if (!this.visible) return;
    if (document.hidden) { this.raf = requestAnimationFrame(this.frame); return; }
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.clock += dt;
    const k = 1 - Math.exp(-dt * 5.5);
    const lerp = (a: number, b: number) => a + (b - a) * k;
    const t = this.tgt;
    const c = this.cur;
    c.xi = lerp(c.xi, t.now.xi); c.zeta = lerp(c.zeta, t.now.zeta);
    c.sxi = Math.exp(lerp(Math.log(c.sxi), Math.log(t.now.sxi))); c.szeta = Math.exp(lerp(Math.log(c.szeta), Math.log(t.now.szeta)));
    this.scaleCur = Math.exp(lerp(Math.log(this.scaleCur), Math.log(t.preview?.sigmaScale ?? 1)));
    this.redCur = lerp(this.redCur, t.preview?.redScale ?? 1);
    const want = t.marks?.length ? this.wantMarksSpan(t) : this.wantSpan(t.now, t.preview?.sigmaScale ?? 1);
    this.span = Math.exp(lerp(Math.log(this.span), Math.log(want)));
    this.draw();
    // keep animating: the paths carry slowly travelling sparks
    this.raf = requestAnimationFrame(this.frame);
  };

  private draw() {
    if (this.tgt.marks?.length) this.drawPlane(); else this.drawFan();
  }

  private prep() {
    const cv = this.canvas;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return null;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    // deep-space backdrop
    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#060a16'); bg.addColorStop(0.5, '#0a1226'); bg.addColorStop(1, '#050812');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
    for (const s of this.stars) {
      const tw = 0.6 + 0.4 * Math.sin(this.clock * 1.4 + s.x * 40);
      ctx.fillStyle = `rgba(190,210,255,${s.a * tw})`;
      ctx.fillRect(s.x * w, s.y * h, 1.2, 1.2);
    }
    return { w, h, ctx };
  }

  private drawFan() {
    const p = this.prep();
    if (!p) return;
    const { w, h, ctx } = p;
    const b = this.sc.bImp;
    const S = this.span;
    const midY = h / 2;
    const px = (h / 2 - 16) / S; // pixels per Earth radius
    const ax = 44, ex = w - 78;
    const earthR = Math.max(13, b * px);
    const Y = (z: number) => midY - z * px;
    const blob = { ...this.cur, sxi: this.cur.sxi * this.scaleCur, szeta: this.cur.szeta * this.scaleCur };
    const tilt = 0.1; // the target plane is seen slightly from the side, which gives the scene its depth

    // the plane the paths cross: a slanted ruler behind Earth
    ctx.save();
    ctx.strokeStyle = 'rgba(140,175,230,0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(ex - h * tilt * 0.5, h - 6); ctx.lineTo(ex + h * tilt * 0.5, 6); ctx.stroke();
    for (let m = -Math.floor(S / b); m <= Math.floor(S / b); m++) {
      const yy = Y(m * b), xx = ex + (midY - yy) * tilt;
      ctx.beginPath(); ctx.moveTo(xx - 5, yy); ctx.lineTo(xx + 5, yy); ctx.stroke();
    }
    ctx.restore();

    // the lines
    type L = { y: number; hit: boolean; idx: number };
    const lines: L[] = [];
    let hits = 0;
    for (let i = 0; i < N_LINES; i++) {
      const xi = blob.xi + this.zx[i] * blob.sxi, z = blob.zeta + this.zz[i] * blob.szeta;
      const hit = xi * xi + z * z < b * b;
      lines.push({ y: Y(z), hit, idx: hit ? hits++ : -1 });
    }
    const redLimit = Math.ceil(hits * Math.max(0, Math.min(1, this.redCur)) - 1e-6);
    const endX = (y: number) => ex + (midY - y) * tilt;
    const geo = (l: L) => {
      const x1 = l.hit ? ex - earthR * 0.78 : endX(l.y) + 22;
      const y1 = l.hit ? midY + (l.y - midY) * 0.35 : l.y;
      return { x1, y1, cx: (ax + x1) / 2, cy: midY + (y1 - midY) * 0.46 };
    };
    const at = (l: L, t: number) => {
      const g = geo(l);
      const u = 1 - t;
      return { x: u * u * ax + 2 * u * t * g.cx + t * t * g.x1, y: u * u * midY + 2 * u * t * g.cy + t * t * g.y1 };
    };

    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, w, h); ctx.clip();
    ctx.globalCompositeOperation = 'lighter';
    for (const l of lines) {
      const red = l.hit && l.idx < redLimit;
      const g = geo(l);
      const grad = ctx.createLinearGradient(ax, midY, g.x1, g.y1);
      if (red) { grad.addColorStop(0, 'rgba(255,110,80,0.95)'); grad.addColorStop(1, 'rgba(255,60,50,0.9)'); }
      else { grad.addColorStop(0, 'rgba(255,196,96,0.6)'); grad.addColorStop(1, 'rgba(255,150,40,0.1)'); }
      ctx.beginPath(); ctx.moveTo(ax, midY); ctx.quadraticCurveTo(g.cx, g.cy, g.x1, g.y1);
      ctx.strokeStyle = grad;
      ctx.lineWidth = red ? 5 : 3.2; ctx.globalAlpha = red ? 0.16 : 0.07; ctx.stroke();
      ctx.lineWidth = red ? 1.9 : 1.05; ctx.globalAlpha = red ? 1 : 0.75; ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // sparks travelling down the paths: slow on the safe ones, quick on the dangerous ones
    for (let i = 0; i < lines.length; i += 3) {
      const l = lines[i];
      const red = l.hit && l.idx < redLimit;
      const speed = red ? 0.5 : 0.22;
      const t = (this.clock * speed + ((i * 0.173) % 1)) % 1;
      const q = at(l, t);
      ctx.beginPath(); ctx.arc(q.x, q.y, red ? 2.4 : 1.5, 0, Math.PI * 2);
      ctx.fillStyle = red ? 'rgba(255,230,210,0.95)' : 'rgba(255,225,170,0.7)';
      ctx.fill();
    }
    // small bursts where red lines meet Earth
    for (const l of lines) {
      if (!(l.hit && l.idx < redLimit)) continue;
      const g = geo(l);
      const rg = ctx.createRadialGradient(g.x1, g.y1, 0, g.x1, g.y1, 9);
      rg.addColorStop(0, 'rgba(255,170,120,0.9)'); rg.addColorStop(1, 'rgba(255,90,60,0)');
      ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(g.x1, g.y1, 9, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();

    // Earth
    const es = earthSprite(earthR * 2);
    ctx.drawImage(es, ex - es.width / 2, midY - es.height / 2, es.width, es.height);

    // the asteroid: the supplied rock artwork (without its fire tail), on a soft glow
    const img = icon();
    ctx.save();
    ctx.translate(ax, midY);
    const g0 = ctx.createRadialGradient(0, 0, 4, 0, 0, 46);
    g0.addColorStop(0, 'rgba(255,170,90,0.42)'); g0.addColorStop(1, 'rgba(255,120,40,0)');
    ctx.fillStyle = g0; ctx.beginPath(); ctx.arc(0, 0, 46, 0, Math.PI * 2); ctx.fill();
    if (img.complete && img.naturalWidth) {
      const size = 50, k = size / 710;
      ctx.rotate(this.clock * 0.25);
      ctx.drawImage(img, 290, 325, 710, 680, -355 * k, -340 * k, 710 * k, 680 * k);
    } else {
      ctx.beginPath(); ctx.arc(0, 0, 14, 0, Math.PI * 2); ctx.fillStyle = '#6a6786'; ctx.fill();
    }
    ctx.restore();

    ctx.font = '600 12px "Hanken Grotesk Variable", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(214,224,245,0.9)'; ctx.fillText('Asteroid', ax, Math.min(h - 7, midY + 42));
    ctx.fillStyle = '#a9dcff'; ctx.fillText('Earth', ex, Math.min(h - 7, midY + earthR + 19));
    ctx.textAlign = 'start';
    if (Math.abs(blob.zeta) - 2 * blob.szeta > S) {
      ctx.fillStyle = '#8fe0c4'; ctx.font = '600 13px "Hanken Grotesk Variable", sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('Passing far from Earth', w / 2, 24);
      ctx.textAlign = 'start';
    }
  }

  /** Outcome screen: the target plane head-on, with where it would have gone and where it went. */
  private drawPlane() {
    const p = this.prep();
    if (!p) return;
    const { w, h, ctx } = p;
    const t = this.tgt;
    const cx = w / 2, cy = h / 2;
    const px = Math.min(w, h) / 2 / this.span;
    const X = (xi: number) => cx + xi * px;
    const Y = (z: number) => cy - z * px;
    const b = this.sc.bImp;
    ctx.save();
    ctx.strokeStyle = 'rgba(140,170,215,0.12)'; ctx.lineWidth = 1;
    for (let m = 2; m * b < this.span * 1.4; m += 2) { ctx.beginPath(); ctx.arc(cx, cy, m * b * px, 0, Math.PI * 2); ctx.stroke(); }
    ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(w, cy); ctx.moveTo(cx, 0); ctx.lineTo(cx, h); ctx.stroke();
    ctx.restore();
    const es = earthSprite(b * px * 2);
    ctx.drawImage(es, cx - es.width / 2, cy - es.height / 2, es.width, es.height);
    const mk = t.marks ?? [];
    if (mk.length === 2) {
      ctx.setLineDash([6, 5]); ctx.strokeStyle = 'rgba(200,215,240,0.6)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(X(mk[0].xi), Y(mk[0].zeta)); ctx.lineTo(X(mk[1].xi), Y(mk[1].zeta)); ctx.stroke(); ctx.setLineDash([]);
    }
    for (const m of mk) {
      let x = X(m.xi), y = Y(m.zeta);
      const edge = Math.min(w, h) / 2 - 16;
      const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy);
      let clamped = false;
      if (d > edge) { x = cx + (dx / d) * edge; y = cy + (dy / d) * edge; clamped = true; }
      const col = m.kind === 'before' ? '255,84,70' : '110,230,180';
      const g = ctx.createRadialGradient(x, y, 0, x, y, 20);
      g.addColorStop(0, `rgba(${col},0.7)`); g.addColorStop(1, `rgba(${col},0)`);
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, 20, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(x, y, 6.5, 0, Math.PI * 2); ctx.fillStyle = `rgb(${col})`; ctx.fill();
      ctx.strokeStyle = '#050812'; ctx.lineWidth = 2; ctx.stroke();
      if (clamped) { ctx.fillStyle = '#e8eefc'; ctx.font = '600 11px sans-serif'; ctx.fillText('far', x + 10, y + 4); }
    }
    ctx.font = '600 12px "Hanken Grotesk Variable", sans-serif';
    ctx.fillStyle = '#a9dcff'; ctx.textAlign = 'center';
    const lr = b * px;
    ctx.fillText('Earth', cx, cy - lr - 9 > 12 ? cy - lr - 9 : cy + lr + 17);
    ctx.textAlign = 'start';
  }
}
