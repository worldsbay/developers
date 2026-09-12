import * as THREE from 'three';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { mergeGeometries, deinterleaveGeometry } from 'three/addons/utils/BufferGeometryUtils.js';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { acquireAsset } from '../three/asset-cache.js';
import type { Avatar } from '../three/avatar.js';
import type { Appearance } from '../core/contract.js';
import { clothingRegion, clothingRegions } from './color-regions.js';
import { characterLimits, type CharacterAppearance, type CharacterAsset } from './contract.js';

export function characterAssetUrl(asset: CharacterAsset, baseUrl?: string) {
  if (baseUrl) return new URL(asset.file, baseUrl.endsWith('/') ? baseUrl : baseUrl + '/').href;
  if (!asset.url) throw new Error('Character asset URL is missing.');
  return asset.url;
}

export type CharacterAvatar = Omit<Avatar, 'emote'> & {
  emote: (id: string, age?: number, loop?: boolean) => void;
};

export function composeCharacter(
  value: CharacterAppearance,
  source: GLTF,
  parts: GLTF[],
  animations: GLTF,
): CharacterAvatar {
  const root = new THREE.Group(),
    model = clone(source.scene);
  root.add(model);
  model.updateMatrixWorld(true);
  const order = source.scene.userData.jointOrder as string[];
  if (!Array.isArray(order) || order.length > characterLimits.joints)
    throw new Error('Invalid character rig.');
  const bones = order.map((name) => {
    const bone = model.getObjectByName(name) as THREE.Bone;
    // Animation-only glTF nodes load as Object3D. Skeleton only needs node transforms.
    if (!bone) throw new Error(`Missing character joint: ${name}`);
    return bone;
  });
  const inverses = bones.map((b) => b.matrixWorld.clone().invert());
  const skeleton = new THREE.Skeleton(bones, inverses),
    pieces: THREE.BufferGeometry[] = [];
  let geometry: THREE.BufferGeometry | null = null,
    material: THREE.Material | undefined;
  try {
    for (const [index, gltf] of parts.entries()) {
      let meshes = 0;
      gltf.scene.traverse((object) => {
        const mesh = object as THREE.SkinnedMesh;
        if (!mesh.isSkinnedMesh) return;
        meshes++;
        if (
          mesh.skeleton.bones.length !== bones.length ||
          mesh.skeleton.bones.some(
            (b, i) =>
              b.name !== order[i] ||
              mesh.skeleton.boneInverses[i].elements.some(
                (x, k) => Math.abs(x - inverses[i].elements[k]) > 0.001,
              ),
          )
        )
          throw new Error(`Incompatible character part: ${value.parts[index].name}`);
        const g = mesh.geometry.clone();
        deinterleaveGeometry(g);
        pieces.push(g);
        const tint = g.getAttribute('_tint'),
          colors = g.getAttribute('color');
        const skin = new THREE.Color(value.recipe.colors.skin),
          hair = new THREE.Color(value.recipe.colors.hair),
          cloth = new THREE.Color(value.recipe.colors.cloth);
        const colorMode =
          value.recipe.partColorModes?.[value.parts[index].slot] ?? value.recipe.colorMode ?? 'custom';
        const part = value.parts[index];
        const overrides = value.recipe.partColors?.[part.id];
        const regionMode = overrides && clothingRegions(part).length > 0;
        for (let v = 0; v < colors.count; v++) {
          // Released Ranger hoods lacked a clothing tint tag. Keep pinned saved
          // assets recolorable without replacing their immutable files.
          const channel =
            (tint?.getX(v) ?? 0) || (/Ranger_Head_Hood$/.test(value.parts[index].sourceNode) ? 3 : 0);
          if (colorMode === 'custom' && regionMode && channel === 3) {
            const original = new THREE.Color(colors.getX(v), colors.getY(v), colors.getZ(v));
            const region = clothingRegion(part, original, channel);
            const replacement = region && overrides[region];
            if (replacement) {
              const reference = new THREE.Color(clothingRegions(part).find((r) => r.id === region)!.color);
              const brightness = Math.min(
                2,
                Math.max(
                  0.15,
                  Math.max(original.r, original.g, original.b) /
                    Math.max(reference.r, reference.g, reference.b),
                ),
              );
              const chosen = new THREE.Color(replacement).multiplyScalar(brightness);
              colors.setXYZ(v, chosen.r, chosen.g, chosen.b);
            }
            continue;
          }
          if (colorMode === 'custom' && (channel === 1 || channel === 2 || channel === 3)) {
            const chosen = channel === 1 ? skin : channel === 2 ? hair : cloth;
            // Keep the baked shading while letting the user choose a pigment.
            const brightness = Math.min(
              1.6,
              Math.max(
                0.3,
                (colors.getX(v) + colors.getY(v) + colors.getZ(v)) / (channel === 1 ? 0.8 : 0.18),
              ),
            );
            colors.setXYZ(v, chosen.r * brightness, chosen.g * brightness, chosen.b * brightness);
          }
        }
        for (const attribute of Object.keys(g.attributes))
          if (!['position', 'normal', 'color', 'skinIndex', 'skinWeight'].includes(attribute))
            g.deleteAttribute(attribute);
      });
      if (meshes !== 1) throw new Error('Each modular part must contain one skinned mesh.');
    }
    geometry = mergeGeometries(pieces);
    if (!geometry || geometry.index!.count / 3 > characterLimits.triangles)
      throw new Error('Character geometry exceeds the profile.');
    material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.85,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.SkinnedMesh(geometry, material);
    mesh.name = 'ModularCharacter';
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    model.add(mesh);
    mesh.bind(skeleton, new THREE.Matrix4());
    const mixer = new THREE.AnimationMixer(model),
      actions = new Map<string, THREE.AnimationAction>();
    for (const clip of animations.animations) actions.set(clip.name, mixer.clipAction(clip));
    let locomotion = 'idle',
      active = actions.get('idle')!.play(),
      fading: THREE.AnimationAction | undefined,
      fadeRemaining = 0;
    let social: THREE.AnimationAction | undefined,
      socialId: string | null = null,
      socialRemaining = 0,
      disposed = false,
      clipGeneration = 0;
    // Legacy feet are sibling branches. Cache their ankle in lower-leg coordinates
    // and repair after every mixer/blend; never accumulate frame-relative offsets.
    const feet = ['L', 'R'].flatMap((side) => {
      const foot = model.getObjectByName(`Foot${side}`),
        leg = model.getObjectByName(`LowerLeg${side}`);
      return foot && leg && foot.parent !== leg
        ? [{ foot, leg, anchor: leg.worldToLocal(foot.getWorldPosition(new THREE.Vector3())) }]
        : [];
    });
    const footPosition = new THREE.Vector3();
    function stopSocial() {
      social?.stop();
      social = undefined;
      socialId = null;
    }
    function emote(id: string, age = 0, loop = false) {
      const action = actions.get(id);
      if (!action) return;
      stopSocial();
      const duration = action.getClip().duration;
      if (age >= duration && !loop) return;
      social = action;
      socialId = id;
      socialRemaining = loop ? Infinity : duration - Math.max(0, age);
      active.setEffectiveWeight(0);
      action
        .reset()
        .setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1)
        .setEffectiveWeight(1)
        .play();
      action.time = Math.max(age, 0) % duration;
    }
    return {
      root,
      budget: {
        profile: 'pocket-humanoid-v2',
        triangles: geometry.index!.count / 3,
        drawCalls: null,
        materials: 1,
        texturePixels: 0,
        textureBytes: 0,
        skinningTextureBytes: 0,
        joints: bones.length,
        influences: 4,
        coveredTriangles: 0,
        pass: 'Unmeasured',
      },
      update(delta, value) {
        if (disposed) return;
        const dt = Math.min(0.1, Math.max(0, delta));
        let next = typeof value === 'boolean' ? (value ? 'walk' : 'idle') : value;
        if (next === 'wave' || next === 'dance') next = 'idle';
        if (!actions.has(next)) next = 'idle';
        if (next !== locomotion) {
          stopSocial();
          fading?.stop();
          fading = active;
          fadeRemaining = 0.16;
          fading.fadeOut(0.16);
          active = actions.get(next)!.reset().setEffectiveWeight(1).fadeIn(0.16).play();
          locomotion = next;
          if (['jump', 'land', 'fall'].includes(next)) {
            active.setLoop(THREE.LoopOnce, 1);
            active.clampWhenFinished = true;
          } else active.setLoop(THREE.LoopRepeat, Infinity);
        }
        if (fading && (fadeRemaining -= dt) <= 0) {
          fading.stop();
          fading = undefined;
        }
        if (social && (socialRemaining -= dt) <= 0) stopSocial();
        if (!social) active.setEffectiveWeight(1);
        mixer.update(dt);
        model.updateMatrixWorld(true);
        for (const f of feet) {
          footPosition.copy(f.anchor);
          f.leg.localToWorld(footPosition);
          f.foot.parent!.worldToLocal(footPosition);
          f.foot.position.copy(footPosition);
          f.foot.updateMatrixWorld(true);
        }
      },
      wave() {
        emote('wave');
      },
      emote,
      async playClip(asset: CharacterAsset, id: string, loop = false) {
        const generation = ++clipGeneration;
        const resource = await acquireAsset(characterAssetUrl(asset));
        try {
          if (disposed || generation !== clipGeneration) return;
          const clip = resource.value.animations.find((c) => c.name === id);
          if (!clip) throw new Error('Animation clip is missing.');
          stopSocial();
          // Keep only the core set plus the latest optional clip per instance.
          for (const [name, action] of actions)
            if (!animations.animations.some((c) => c.name === name)) {
              action.stop();
              mixer.uncacheAction(action.getClip(), model);
              actions.delete(name);
            }
          actions.set(id, mixer.clipAction(clip));
          emote(id, 0, loop);
        } finally {
          resource.release();
        }
      },
      diagnostics() {
        return {
          activeActions: [...actions.values()].filter((a) => a.isRunning()).length,
          locomotion,
          emote: socialId,
        };
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        clipGeneration++;
        mixer.stopAllAction();
        mixer.uncacheRoot(model);
        geometry!.dispose();
        material!.dispose();
        skeleton.dispose();
        root.removeFromParent();
      },
    };
  } catch (error) {
    geometry?.dispose();
    material?.dispose();
    skeleton.dispose();
    throw error;
  } finally {
    pieces.forEach((g) => g.dispose());
  }
}

// A full outfit can use all sixteen template-cache slots. Serialize composition
// so a room full of different recipes cannot exhaust that cache while loading.
let loadQueue: Promise<unknown> = Promise.resolve();
export function loadCharacterAvatar(appearance: Appearance): Promise<Avatar> {
  const result = loadQueue.then(() => loadCharacter(appearance));
  loadQueue = result.catch(() => undefined);
  return result;
}

async function loadCharacter(appearance: Appearance): Promise<Avatar> {
  const value = appearance.character;
  if (!value) throw new Error('Missing modular character recipe.');
  const resources: Awaited<ReturnType<typeof acquireAsset>>[] = [];
  try {
    for (const asset of [value.rig, ...value.parts.map((p) => p.asset), value.defaultAnimations])
      resources.push(await acquireAsset(characterAssetUrl(asset)));
    return composeCharacter(
      value,
      resources[0].value,
      resources.slice(1, -1).map((r) => r.value),
      resources.at(-1)!.value,
    );
  } finally {
    resources.forEach((r) => r.release());
  }
}
