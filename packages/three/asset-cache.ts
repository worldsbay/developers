import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';

type Entry = { promise: Promise<GLTF>; value?: GLTF; users: number; used: number };
const cache = new Map<string, Entry>(),
  limit = 16;
let requests = 0,
  hits = 0,
  loadMs = 0;
async function loadSource(url: string) {
  const response = await fetch(url, {
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok || !response.body) throw new Error('Approved avatar asset could not be loaded.');
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16 * 1024 * 1024) {
        await reader.cancel();
        throw new Error('Avatar asset exceeds the 16 MiB input limit.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new GLTFLoader().parseAsync(bytes.buffer, url.startsWith('blob:') ? '' : new URL('.', url).href);
}
function disposeTemplate(value: GLTF) {
  const geometries = new Set<THREE.BufferGeometry>(),
    materials = new Set<THREE.Material>(),
    textures = new Set<THREE.Texture>(),
    skeletons = new Set<THREE.Skeleton>();
  value.scene.traverse((object) => {
    const mesh = object as THREE.SkinnedMesh;
    if (mesh.isMesh) {
      geometries.add(mesh.geometry);
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        materials.add(material);
        for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
      }
    }
    if (mesh.isSkinnedMesh) skeletons.add(mesh.skeleton);
  });
  geometries.forEach((g) => g.dispose());
  materials.forEach((m) => m.dispose());
  textures.forEach((t) => t.dispose());
  skeletons.forEach((s) => s.dispose());
}
function trim() {
  for (const [url, entry] of [...cache].sort((a, b) => a[1].used - b[1].used)) {
    if (cache.size < limit) return;
    if (entry.users || !entry.value) continue;
    disposeTemplate(entry.value);
    cache.delete(url);
  }
}
export async function acquireAsset(url: string) {
  let entry = cache.get(url);
  if (entry) hits++;
  else {
    trim();
    if (cache.size >= limit) throw new Error('Asset loader is busy. Try again shortly.');
    const start = performance.now();
    requests++;
    entry = { users: 0, used: start, promise: Promise.resolve(null as unknown as GLTF) };
    const current = entry;
    current.promise = loadSource(url)
      .then((value) => {
        current.value = value;
        loadMs += performance.now() - start;
        return value;
      })
      .catch((error) => {
        if (cache.get(url) === current) cache.delete(url);
        throw error;
      });
    cache.set(url, current);
  }
  entry.users++;
  entry.used = performance.now();
  const current = entry;
  try {
    const value = await current.promise;
    let released = false;
    return {
      value,
      release() {
        if (!released) {
          released = true;
          current.users--;
          current.used = performance.now();
        }
      },
    };
  } catch (error) {
    current.users--;
    throw error;
  }
}
export function assetCacheMetrics() {
  return {
    entries: cache.size,
    limit,
    activeReaders: [...cache.values()].reduce((n, e) => n + e.users, 0),
    requests,
    hits,
    loadMs,
  };
}
export function clearAssetCache() {
  for (const [url, entry] of cache)
    if (!entry.users && entry.value) {
      disposeTemplate(entry.value);
      cache.delete(url);
    }
}
