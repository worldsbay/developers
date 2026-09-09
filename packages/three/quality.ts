import type * as THREE from 'three';

export type GraphicsTier = 'low' | 'medium' | 'high';
export type GraphicsMode = 'auto' | GraphicsTier;
const STORAGE_KEY = 'yoworlds.graphics-quality';
const tiers: GraphicsTier[] = ['low', 'medium', 'high'];
const settings = {
  low: { pixelRatio: 0.85, shadowSize: 0 },
  medium: { pixelRatio: 1.5, shadowSize: 1024 },
  high: { pixelRatio: 2, shadowSize: 2048 },
};
const isMode = (value: unknown): value is GraphicsMode =>
  value === 'auto' || value === 'low' || value === 'medium' || value === 'high';

/** Sustained frame measurements prevent isolated hitches or loading work changing quality. */
export function createQualitySampler(initial: GraphicsTier = 'medium') {
  let tier = initial,
    elapsed = 0,
    frames = 0,
    slowWindows = 0,
    fastWindows = 0,
    cooldown = 4000;
  return {
    reset(next = tier) {
      tier = next;
      elapsed = frames = slowWindows = fastWindows = 0;
      cooldown = 4000;
    },
    sample(frameMs: number): GraphicsTier | undefined {
      if (!Number.isFinite(frameMs) || frameMs < 4 || frameMs > 1000) return;
      if (cooldown > 0) {
        cooldown -= frameMs;
        return;
      }
      elapsed += frameMs;
      frames++;
      if (elapsed < 1200) return;
      const mean = elapsed / frames;
      elapsed = frames = 0;
      slowWindows = mean > 27 ? slowWindows + 1 : 0;
      fastWindows = mean < 18.5 ? fastWindows + 1 : 0;
      const index = tiers.indexOf(tier);
      const next =
        slowWindows >= 2 && index > 0
          ? tiers[index - 1]
          : fastWindows >= 6 && index < 2
            ? tiers[index + 1]
            : undefined;
      if (next) this.reset(next);
      return next;
    },
  };
}

/** Quality affects rendering only; the room, avatars and interaction geometry stay intact. */
export function createGraphicsQuality(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  container: HTMLElement,
) {
  let mode: GraphicsMode = 'auto';
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isMode(saved)) mode = saved;
  } catch {
    // Storage can be unavailable in private or embedded sessions.
  }
  let tier: GraphicsTier = mode === 'auto' ? 'medium' : mode,
    disposed = false;
  const sampler = createQualitySampler(tier);
  const apply = () => {
    const config = settings[tier];
    renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, config.pixelRatio));
    const shadowsChanged = renderer.shadowMap.enabled !== config.shadowSize > 0;
    renderer.shadowMap.enabled = config.shadowSize > 0;
    scene.traverse((object) => {
      const minimum = object.userData.minQuality as GraphicsTier | undefined;
      if (minimum && tiers.includes(minimum)) object.visible = tiers.indexOf(tier) >= tiers.indexOf(minimum);
      const light = object as THREE.DirectionalLight;
      if (light.isDirectionalLight && light.castShadow && config.shadowSize > 0) {
        if (light.shadow.mapSize.x !== config.shadowSize) {
          light.shadow.map?.dispose();
          light.shadow.map = null;
          light.shadow.mapSize.set(config.shadowSize, config.shadowSize);
          light.shadow.needsUpdate = true;
        }
      }
      const mesh = object as THREE.Mesh;
      if (shadowsChanged && mesh.isMesh)
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material])
          material.needsUpdate = true;
    });
    container.dataset.quality = tier;
    container.dataset.qualityMode = mode;
    container.dispatchEvent(new CustomEvent('graphicsqualitychange', { detail: { mode, tier } }));
  };
  const resetMeasurements = () => sampler.reset(tier);
  const resize = () => {
    if (!disposed)
      renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, settings[tier].pixelRatio));
  };
  document.addEventListener('visibilitychange', resetMeasurements);
  window.addEventListener('resize', resize);
  apply();
  return {
    get mode() {
      return mode;
    },
    get tier() {
      return tier;
    },
    setMode(next: GraphicsMode) {
      if (disposed || !isMode(next)) return;
      mode = next;
      tier = next === 'auto' ? tier : next;
      sampler.reset(tier);
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // The current session still keeps the user's selection.
      }
      apply();
    },
    sample(frameMs: number) {
      if (disposed || mode !== 'auto' || document.hidden) return;
      const next = sampler.sample(frameMs);
      if (next) {
        tier = next;
        apply();
      }
    },
    dispose() {
      disposed = true;
      document.removeEventListener('visibilitychange', resetMeasurements);
      window.removeEventListener('resize', resize);
    },
  };
}
