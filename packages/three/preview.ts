import * as THREE from 'three';
import type { Appearance } from '../core/contract.js';
import { loadAvatar, measureAvatar, type Avatar } from './avatar.js';
import { rendererFor } from './scenes.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { AnimationId } from '../wire/room.js';
import { assetCacheMetrics } from './asset-cache.js';
import type { CharacterAsset } from '../character/contract.js';
export type PreviewFocus = 'body' | 'head' | 'torso' | 'legs' | 'feet';
export function avatarPreview(container: HTMLElement) {
  const scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera(32, 1, 0.1, 50),
    renderer = rendererFor(container);
  Object.assign(renderer.domElement.style, { position: 'absolute', top: '52px', left: '0' });
  camera.position.set(3, 2.1, 5.5);
  camera.lookAt(0, 1.25, 0);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1.25, 0);
  controls.enablePan = false;
  controls.enableZoom = true;
  controls.minDistance = 0.55;
  controls.maxDistance = 9;
  controls.minPolarAngle = 0.6;
  controls.maxPolarAngle = 2;
  controls.update();
  controls.addEventListener('change', () => {
    container.dataset.angle = controls.getAzimuthalAngle().toFixed(3);
    container.dataset.distance = camera.position.distanceTo(controls.target).toFixed(3);
  });
  container.classList.add('inspectable-avatar');
  const inspection = document.createElement('div');
  inspection.className = 'avatar-inspection-controls';
  inspection.innerHTML = `<label><span>Focus</span><select aria-label="Preview focus"><option value="body">Full body</option><option value="head">Face & headwear</option><option value="torso">Upper body</option><option value="legs">Legs</option><option value="feet">Feet</option></select></label><button type="button" aria-label="Zoom out">−</button><button type="button" aria-label="Zoom in">+</button>`;
  container.append(inspection);
  const focusSelect = inspection.querySelector('select')!;
  let focusView: PreviewFocus = 'body';
  let framedDistance: number | undefined;
  const modelBounds = new THREE.Box3(new THREE.Vector3(-0.5, 0, -0.3), new THREE.Vector3(0.5, 2, 0.3));
  function focus(view: PreviewFocus) {
    focusView = view;
    focusSelect.value = view;
    const height = Math.max(1, modelBounds.max.y - modelBounds.min.y);
    const [center, span] = (
      {
        body: [0.51, 1.17],
        head: [0.88, 0.34],
        torso: [0.64, 0.65],
        legs: [0.3, 0.58],
        feet: [0.07, 0.27],
      } as const
    )[view];
    const direction = camera.position.clone().sub(controls.target).normalize();
    controls.target.set(0, modelBounds.min.y + height * center, 0);
    const distance = THREE.MathUtils.clamp(
      (height * span) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / Math.min(1, camera.aspect),
      controls.minDistance,
      controls.maxDistance,
    );
    camera.position.copy(controls.target).addScaledVector(direction, distance);
    framedDistance = distance;
    controls.update();
    container.dataset.focus = view;
  }
  function zoom(factor: number) {
    const offset = camera.position.clone().sub(controls.target);
    const distance = THREE.MathUtils.clamp(
      offset.length() / factor,
      controls.minDistance,
      controls.maxDistance,
    );
    camera.position.copy(controls.target).add(offset.setLength(distance));
    controls.update();
  }
  focusSelect.onchange = () => focus(focusSelect.value as PreviewFocus);
  inspection.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.onclick = () => zoom(1.25);
  inspection.querySelector<HTMLButtonElement>('[aria-label="Zoom out"]')!.onclick = () => zoom(0.8);
  scene.add(new THREE.HemisphereLight('#ffffff', '#668383', 3));
  const light = new THREE.DirectionalLight('#faffde', 4);
  light.position.set(3, 5, 4);
  scene.add(light);
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(1.15, 1.2, 0.12, 48),
    new THREE.MeshStandardMaterial({ color: '#365255', roughness: 0.8 }),
  );
  base.position.y = -0.03;
  scene.add(base);
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(1.24, 0.013, 6, 64),
    new THREE.MeshBasicMaterial({ color: '#bcfa68' }),
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.03;
  scene.add(ring);
  const fallback = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.25, 0.8, 2, 6),
    new THREE.MeshStandardMaterial({ color: '#bcfa68' }),
  );
  fallback.position.y = 1;
  scene.add(fallback);
  let avatar: Avatar | undefined,
    revision = 0,
    disposed = false,
    locomotion: AnimationId = 'idle';
  const resize = new ResizeObserver(() => {
    const { width, height } = container.getBoundingClientRect();
    const toolbarBottom = inspection.offsetTop + inspection.offsetHeight + 4;
    renderer.domElement.style.top = `${toolbarBottom}px`;
    const renderHeight = Math.max(height - toolbarBottom, 1);
    renderer.setSize(Math.max(width, 1), renderHeight);
    camera.aspect = Math.max(width, 1) / renderHeight;
    camera.updateProjectionMatrix();
    if (avatar) {
      const zoomRatio = framedDistance ? framedDistance / camera.position.distanceTo(controls.target) : 1;
      focus(focusView);
      zoom(zoomRatio);
    }
  });
  resize.observe(container);
  resize.observe(inspection);
  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    avatar?.update(Math.min(clock.getDelta(), 0.1), locomotion);
    renderer.render(scene, camera);
    container.dataset.geometries = String(renderer.info.memory.geometries);
    container.dataset.textures = String(renderer.info.memory.textures);
    container.dataset.cache = JSON.stringify(assetCacheMetrics());
    if (avatar) container.dataset.actions = String(avatar.diagnostics().activeActions);
  });
  return {
    async show(appearance: Appearance) {
      const current = ++revision;
      container.dataset.assetState = 'loading';
      container.dataset.ready = 'false';
      (fallback.material as THREE.MeshStandardMaterial).color.set(appearance.player.color);
      let next: Avatar;
      try {
        next = await loadAvatar(appearance);
      } catch (error) {
        if (current === revision && !disposed) {
          container.dataset.assetState = 'error';
          container.dataset.error = error instanceof Error ? error.message : 'Preview could not load.';
          fallback.visible = true;
          if (avatar) avatar.root.visible = false;
        }
        return false;
      }
      if (current !== revision || disposed) {
        next.dispose();
        return false;
      }
      if (avatar) {
        scene.remove(avatar.root);
        avatar.dispose();
      }
      avatar = next;
      scene.add(next.root);
      next.update(0, 'idle');
      modelBounds.setFromObject(next.root);
      // Keep the chosen body region while swapping parts.
      const zoomRatio = framedDistance ? framedDistance / camera.position.distanceTo(controls.target) : 1;
      focus(focusView);
      zoom(zoomRatio);
      fallback.visible = false;
      measureAvatar(renderer, next);
      container.dataset.budget = JSON.stringify(next.budget);
      container.dataset.assetState = 'ready';
      delete container.dataset.error;
      container.dataset.ready = 'true';
      container.dataset.revision = String(appearance.revision ?? 1);
      container.dataset.equipped = appearance.equipped.map((i) => i.id).join(',');
      return true;
    },
    wave() {
      avatar?.wave();
    },
    async playClip(asset: CharacterAsset, id: string, loop = false) {
      locomotion = 'idle';
      if (!avatar?.playClip) throw new Error('Select a modular character to play this clip.');
      await avatar.playClip(asset, id, loop);
    },
    animate(id: AnimationId) {
      if (id === 'wave' || id === 'dance') {
        locomotion = 'idle';
        avatar?.emote(id);
      } else locomotion = id;
    },
    rotate(radians: number) {
      const offset = camera.position
        .clone()
        .sub(controls.target)
        .applyAxisAngle(new THREE.Vector3(0, 1, 0), radians);
      camera.position.copy(controls.target).add(offset);
      controls.update();
    },
    focus,
    zoom,
    dispose() {
      revision++;
      disposed = true;
      controls.dispose();
      inspection.remove();
      resize.disconnect();
      renderer.setAnimationLoop(null);
      avatar?.dispose();
      for (const mesh of [base, ring, fallback]) {
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      }
      renderer.dispose();
    },
  };
}
