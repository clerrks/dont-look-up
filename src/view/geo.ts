import * as THREE from 'three';
import { feature } from 'topojson-client';
import land110 from 'world-atlas/land-110m.json';

export const D2R = Math.PI / 180;

/** Matches three.js SphereGeometry's equirectangular UV layout (lon -180 at u=0). */
export function latLonToVec3(lat: number, lon: number, r = 1, out = new THREE.Vector3()): THREE.Vector3 {
  const la = lat * D2R;
  const phi = (lon + 180) * D2R;
  return out.set(-r * Math.cos(la) * Math.cos(phi), r * Math.sin(la), r * Math.cos(la) * Math.sin(phi));
}

export function vec3ToLatLon(v: THREE.Vector3): { lat: number; lon: number } {
  const r = v.length();
  const lat = Math.asin(v.y / r) / D2R;
  const phi = Math.atan2(v.z, -v.x);
  let lon = phi / D2R - 180;
  lon = ((lon + 540) % 360) - 180;
  return { lat, lon };
}

let landGeo: any = null;
function land() {
  if (!landGeo) landGeo = feature(land110 as any, (land110 as any).objects.land);
  return landGeo;
}

function tracePolygons(ctx: CanvasRenderingContext2D, W: number, H: number) {
  const geo = land();
  const feats = geo.type === 'FeatureCollection' ? geo.features : [geo];
  ctx.beginPath();
  for (const f of feats) {
    const g = f.geometry;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    for (const poly of polys) {
      for (const ring of poly) {
        // unwrap longitudes so rings crossing the antimeridian do not smear a line across the map
        const lons: number[] = [];
        let prev = ring[0][0], off = 0;
        for (const p of ring) {
          const d = p[0] - prev;
          if (d > 180) off -= 360; else if (d < -180) off += 360;
          prev = p[0];
          lons.push(p[0] + off);
        }
        for (const shift of [-360, 0, 360]) {
          ring.forEach((p: number[], i: number) => {
            const x = ((lons[i] + shift + 180) / 360) * W;
            const y = ((90 - p[1]) / 180) * H;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          });
          ctx.closePath();
        }
      }
    }
  }
}

export interface Palette {
  ocean: [string, string];
  land: string;
  coast: string;
  grid: string;
}

export function paintEarth(W: number, H: number, pal: Palette): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, pal.ocean[0]); g.addColorStop(0.5, pal.ocean[1]); g.addColorStop(1, pal.ocean[0]);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  // graticule
  ctx.strokeStyle = pal.grid; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let lon = -180; lon <= 180; lon += 15) { const x = ((lon + 180) / 360) * W; ctx.moveTo(x, 0); ctx.lineTo(x, H); }
  for (let lat = -75; lat <= 75; lat += 15) { const y = ((90 - lat) / 180) * H; ctx.moveTo(0, y); ctx.lineTo(W, y); }
  ctx.stroke();
  tracePolygons(ctx, W, H);
  ctx.fillStyle = pal.land; ctx.fill();
  ctx.strokeStyle = pal.coast; ctx.lineWidth = Math.max(1, W / 1400); ctx.stroke();
  return cv;
}

export function makeLandMask(): (lat: number, lon: number) => boolean {
  const W = 1440, H = 720;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  tracePolygons(ctx, W, H);
  ctx.fillStyle = '#fff'; ctx.fill();
  const data = ctx.getImageData(0, 0, W, H).data;
  return (lat, lon) => {
    const x = Math.min(W - 1, Math.max(0, Math.floor(((lon + 180) / 360) * W)));
    const y = Math.min(H - 1, Math.max(0, Math.floor(((90 - lat) / 180) * H)));
    return data[(y * W + x) * 4] > 127;
  };
}

/** Points on a small circle of angular radius from `km` around lat/lon. */
export function circlePoints(lat: number, lon: number, km: number, n = 96, r = 1.003): THREE.Vector3[] {
  const center = latLonToVec3(lat, lon, 1);
  const north = new THREE.Vector3(0, 1, 0);
  let east = new THREE.Vector3().crossVectors(north, center);
  if (east.lengthSq() < 1e-6) east = new THREE.Vector3(1, 0, 0);
  east.normalize();
  const nrm = new THREE.Vector3().crossVectors(center, east).normalize();
  const ang = Math.min(Math.PI - 0.01, km / 6371);
  const pts: THREE.Vector3[] = [];
  for (let k = 0; k <= n; k++) {
    const a = (k / n) * Math.PI * 2;
    const dir = east.clone().multiplyScalar(Math.cos(a)).add(nrm.clone().multiplyScalar(Math.sin(a)));
    pts.push(center.clone().multiplyScalar(Math.cos(ang)).add(dir.multiplyScalar(Math.sin(ang))).normalize().multiplyScalar(r));
  }
  return pts;
}
