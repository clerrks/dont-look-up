// One geometry for everything the player sees: the dots on the globe, the asteroid's path and the ending.
// The asteroid flies along a straight line that arrives from the sky direction R, offset sideways by O
// (in Earth radii) from the line through Earth's centre. If |O| < 1 the line hits the planet, and the point
// where it does is exactly the ground point the sim reports. If |O| >= 1 it passes by.
import * as THREE from 'three';
import type { Scenario } from '../sim/model';
import { latLonToVec3 } from './geo';

const D2R = Math.PI / 180;

export interface PathFrame {
  /** unit vector from Earth toward the sky the asteroid comes from */
  R: THREE.Vector3;
  /** sideways offset of the line from Earth's centre, in Earth radii (visual: 1 = just touching) */
  O: THREE.Vector3;
  east: THREE.Vector3;
  north: THREE.Vector3;
  /** true if the straight line meets the planet */
  hits: boolean;
  /** the true offset before it was squeezed for drawing */
  raw: number;
}

/**
 * A line that misses by tens of Earth radii must still look like a near miss on screen, not like the asteroid
 * flying off into space: offsets beyond the planet are squeezed smoothly toward a limit just over two radii.
 */
const SQUEEZE = 1.1;
export function visualOffset(len: number): number {
  return len <= 1 ? len : 1 + SQUEEZE * (1 - Math.exp(-(len - 1) / SQUEEZE));
}

/** Earth turns underneath the asteroid while it is late or early: the sky direction swings with the arrival time. */
export function framePath(sc: Scenario, xi: number, zeta: number, tauHours: number): PathFrame {
  const lon = sc.radiant.lon - 15.041 * tauHours;
  const R = latLonToVec3(sc.radiant.lat, lon, 1);
  const phi = (lon + 180) * D2R, lat = sc.radiant.lat * D2R;
  const east = new THREE.Vector3(Math.sin(phi), 0, Math.cos(phi));
  const north = new THREE.Vector3(Math.sin(lat) * Math.cos(phi), Math.cos(lat), -Math.sin(lat) * Math.sin(phi));
  const th = sc.radiant.theta;
  const x = (xi * Math.cos(th) - zeta * Math.sin(th)) / sc.bImp;
  const y = (xi * Math.sin(th) + zeta * Math.cos(th)) / sc.bImp;
  const O = east.clone().multiplyScalar(x).addScaledVector(north, y);
  const raw = O.length();
  if (raw > 1) O.setLength(visualOffset(raw));
  return { R, O, east, north, hits: raw < 1, raw };
}

/** A displacement in the impact plane (Earth radii) as a world-space offset. */
export function planeToWorld(sc: Scenario, f: PathFrame, dxi: number, dzeta: number): THREE.Vector3 {
  const th = sc.radiant.theta;
  const x = (dxi * Math.cos(th) - dzeta * Math.sin(th)) / sc.bImp;
  const y = (dxi * Math.sin(th) + dzeta * Math.cos(th)) / sc.bImp;
  return f.east.clone().multiplyScalar(x).addScaledVector(f.north, y);
}

/** Where the straight line first meets the planet, or null if it misses. */
export function groundPointOf(f: PathFrame, offset = f.O): THREE.Vector3 | null {
  const l2 = offset.lengthSq();
  if (l2 >= 1) return null;
  return offset.clone().addScaledVector(f.R, Math.sqrt(1 - l2));
}
