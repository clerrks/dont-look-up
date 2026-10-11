// Spacecraft and asteroid meshes from the supplied model pack (FBX), normalised so they drop straight into the scene.
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import type { KineticTier } from '../sim/model';

export type ShipKey = KineticTier | 'tractor';

const SHIP_FILES: Record<ShipKey, string> = {
  light: 'Rocket_03',
  standard: 'Rocket_01',
  heavy: 'Rocket_04',
  tractor: 'Signal_buoy',
};
const ROCK_FILES = ['asteroid_01', 'asteroid_03', 'asteroid_04', 'asteroid_05', 'asteroid_07', 'asteroid_09'];

const loader = new FBXLoader();
const cache = new Map<string, Promise<THREE.Group>>();
let atlas: THREE.Texture | null = null;

let atlasReady: Promise<void> | null = null;
function propsTexture(): THREE.Texture {
  if (!atlas) {
    atlasReady = new Promise<void>((res) => {
      atlas = new THREE.TextureLoader().load('/models/props.png', () => res(), undefined, () => res());
    });
    atlas!.colorSpace = THREE.SRGBColorSpace;
  }
  return atlas!;
}

function normalise(root: THREE.Group, longAxisToZ: boolean): THREE.Group {
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  root.position.sub(centre);
  const inner = new THREE.Group();
  inner.add(root);
  inner.scale.setScalar(1 / Math.max(size.x, size.y, size.z, 1e-6));
  const outer = new THREE.Group();
  outer.add(inner);
  // rockets are modelled nose-up; the scene flies things along +Z
  if (longAxisToZ && size.y > size.x && size.y > size.z) outer.rotation.x = Math.PI / 2;
  return outer;
}

function load(file: string, kind: 'rock' | 'ship' | 'tractor'): Promise<THREE.Group> {
  const key = `${kind}:${file}`;
  let p = cache.get(key);
  if (!p) {
    p = new Promise<THREE.Group>((resolve, reject) => {
      loader.load(
        `/models/${file}.fbx`,
        (obj) => {
          obj.traverse((c) => {
            const m = c as THREE.Mesh;
            if (!m.isMesh) return;
            m.geometry.computeVertexNormals();
            if (kind === 'rock') {
              m.material = new THREE.MeshStandardMaterial({ color: 0x9a8268, roughness: 1, metalness: 0, flatShading: true, emissive: 0x24160a, emissiveIntensity: 0.7 });
            } else if (kind === 'tractor') {
              m.material = new THREE.MeshStandardMaterial({ map: propsTexture(), color: 0xcfe1ff, roughness: 0.4, metalness: 0.55, emissive: 0x16345f, emissiveIntensity: 1.1 });
            } else {
              m.material = new THREE.MeshStandardMaterial({ map: propsTexture(), color: 0xf2f6ff, roughness: 0.35, metalness: 0.5, emissive: 0x233b64, emissiveIntensity: 1 });
            }
          });
          resolve(normalise(obj, kind === 'ship'));
        },
        undefined,
        reject,
      );
    });
    cache.set(key, p);
  }
  return p;
}

/** Load every model and the texture they share, reporting each one as it lands. Nothing is a placeholder after this. */
export async function loadAllModels(tick: () => void): Promise<void> {
  propsTexture();
  const jobs: Promise<unknown>[] = [
    ...(Object.keys(SHIP_FILES) as ShipKey[]).map((k) => shipTemplate(k)),
    ...ROCK_FILES.map((f) => load(f, 'rock')),
    atlasReady!,
  ];
  await Promise.all(jobs.map((p) => p.then(tick, tick)));
}

/** Start fetching everything the game uses, so it is ready when needed. */
export function preloadModels() {
  for (const k of Object.keys(SHIP_FILES) as ShipKey[]) void shipTemplate(k).catch(() => undefined);
  void load(ROCK_FILES[0], 'rock').catch(() => undefined);
}

export function shipTemplate(key: ShipKey) {
  return load(SHIP_FILES[key], key === 'tractor' ? 'tractor' : 'ship');
}

export function rockTemplate(seed: number) {
  return load(ROCK_FILES[Math.abs(seed) % ROCK_FILES.length], 'rock');
}
