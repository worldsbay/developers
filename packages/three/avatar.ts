import * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries, deinterleaveGeometry } from 'three/addons/utils/BufferGeometryUtils.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import type { Appearance } from '../core/contract.js';
import { avatarLimits, referenceRig } from '../core/profile.js';
import type { AnimationId } from '../wire/room.js';
import { acquireAsset } from './asset-cache.js';
import type { CharacterAsset } from '../character/contract.js';

export type AvatarBudget = {
  profile?: string;
  triangles: number;
  drawCalls: number | null;
  materials: number;
  texturePixels: number;
  textureBytes: number;
  skinningTextureBytes: number;
  joints: number;
  influences: number;
  coveredTriangles: number;
  pass: string;
};
export type Avatar = {
  root: THREE.Group;
  update: (delta: number, locomotion: boolean | AnimationId) => void;
  wave: () => void;
  emote: (id: 'wave' | 'dance', age?: number) => void;
  dispose: () => void;
  playClip?: (asset: CharacterAsset, id: string, loop?: boolean) => Promise<void>;
  budget: AvatarBudget;
  diagnostics: () => { activeActions: number; locomotion: string; emote: string | null };
};

function geometryForComposition(source: THREE.BufferGeometry) {
  const geometry = source.clone();
  deinterleaveGeometry(geometry);
  for (const attribute of Object.keys(geometry.attributes))
    if (!['position', 'normal', 'color', 'skinIndex', 'skinWeight'].includes(attribute))
      geometry.deleteAttribute(attribute);
  if (!geometry.index)
    geometry.setIndex(Array.from({ length: geometry.getAttribute('position').count }, (_, i) => i));
  const colors = geometry.getAttribute('color');
  if (!colors) {
    geometry.dispose();
    throw new Error('The vertex-colour profile requires COLOR_0.');
  }
  {
    const values = [];
    for (let i = 0; i < colors.count; i++) values.push(colors.getX(i), colors.getY(i), colors.getZ(i));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(values, 3));
  }
  for (const name of ['skinIndex', 'skinWeight']) {
    const attribute = geometry.getAttribute(name);
    if (!attribute) continue;
    const values = [];
    for (let i = 0; i < attribute.count; i++)
      values.push(attribute.getX(i), attribute.getY(i), attribute.getZ(i), attribute.getW(i));
    geometry.setAttribute(
      name,
      name === 'skinIndex'
        ? new THREE.Uint16BufferAttribute(values, 4)
        : new THREE.Float32BufferAttribute(values, 4),
    );
  }
  return geometry;
}
function compatibleMaterial(mesh: THREE.Mesh) {
  if (Array.isArray(mesh.material))
    throw new Error('A supported item uses one opaque vertex-colour material.');
  const material = mesh.material as THREE.MeshStandardMaterial;
  if (
    !material.isMeshStandardMaterial ||
    material.transparent ||
    material.opacity !== 1 ||
    Object.values(material).some((value) => value instanceof THREE.Texture)
  )
    throw new Error(
      'Unsupported material: the current composition profile uses opaque vertex colours without textures.',
    );
}
export function composeAvatar(appearance: Appearance, base: GLTF, items: GLTF[]): Avatar {
  const model = cloneSkeleton(base.scene);
  let body: THREE.SkinnedMesh | undefined;
  model.traverse((object) => {
    if ((object as THREE.SkinnedMesh).isSkinnedMesh) {
      if (body) throw new Error('Reference body must contain one skinned mesh.');
      body = object as THREE.SkinnedMesh;
    }
  });
  if (!body) throw new Error('The reference body has no skeleton.');
  const mesh = body;
  compatibleMaterial(mesh);
  model.updateMatrixWorld(true);
  const pieces: THREE.BufferGeometry[] = [];
  let assembled: THREE.BufferGeometry | undefined, privateMaterial: THREE.Material | undefined;
  try {
    const geometry = geometryForComposition(mesh.geometry);
    pieces.push(geometry);
    const index = geometry.index!,
      region = mesh.geometry.getAttribute('_bodyregion') ?? mesh.geometry.getAttribute('bodyRegion');
    let coveredTriangles = 0;
    if (appearance.equipped.some((item) => item.coverage?.includes('torso'))) {
      if (!region) throw new Error('This body revision does not expose the required torso coverage mask.');
      const visible = [];
      for (let i = 0; i < index.count; i += 3) {
        const triangle = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
        if (triangle.every((v) => region.getX(v) === 1)) coveredTriangles++;
        else visible.push(...triangle);
      }
      geometry.setIndex(visible);
    }
    const originalColor = new THREE.Color('#bcfa68'),
      chosenColor = new THREE.Color(appearance.player.color),
      colors = geometry.getAttribute('color');
    for (let i = 0; i < colors.count; i++)
      if (
        Math.abs(colors.getX(i) - originalColor.r) < 0.01 &&
        Math.abs(colors.getY(i) - originalColor.g) < 0.01 &&
        Math.abs(colors.getZ(i) - originalColor.b) < 0.01
      )
        colors.setXYZ(i, chosenColor.r, chosenColor.g, chosenColor.b);
    for (let n = 0; n < items.length; n++) {
      const item = appearance.equipped[n],
        asset = items[n];
      asset.scene.updateMatrixWorld(true);
      asset.scene.traverse((object) => {
        const part = object as THREE.SkinnedMesh;
        if (!part.isMesh) return;
        compatibleMaterial(part);
        const g = geometryForComposition(part.geometry);
        pieces.push(g);
        if (item.kind === 'skinned') {
          if (!part.isSkinnedMesh || part.skeleton.bones.length !== referenceRig.length)
            throw new Error('Garment skeleton does not match humanoid-1.');
          const remap = part.skeleton.bones.map((bone, i) => {
            const target = mesh.skeleton.bones.findIndex((b) => b.name === bone.name);
            if (
              target < 0 ||
              part.skeleton.boneInverses[i].elements.some(
                (v, j) => Math.abs(v - mesh.skeleton.boneInverses[target].elements[j]) > 0.001,
              )
            )
              throw new Error('Garment bind pose is incompatible.');
            return target;
          });
          const joints = g.getAttribute('skinIndex');
          for (let v = 0; v < joints.count; v++)
            joints.setXYZW(
              v,
              remap[joints.getX(v)],
              remap[joints.getY(v)],
              remap[joints.getZ(v)],
              remap[joints.getW(v)],
            );
          g.applyMatrix4(part.matrixWorld);
        } else {
          if (part.isSkinnedMesh) throw new Error('A rigid item cannot contain skinning.');
          const boneIndex = mesh.skeleton.bones.findIndex((b) => b.name === item.attachment);
          if (boneIndex < 0) throw new Error('Unsupported attachment socket.');
          g.applyMatrix4(part.matrixWorld).applyMatrix4(
            new THREE.Matrix4().copy(mesh.skeleton.boneInverses[boneIndex]).invert(),
          );
          const joints = [],
            weights = [];
          for (let v = 0; v < g.getAttribute('position').count; v++) {
            joints.push(boneIndex, 0, 0, 0);
            weights.push(1, 0, 0, 0);
          }
          g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(joints, 4));
          g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
        }
      });
    }
    assembled = mergeGeometries(pieces) ?? undefined;
    if (!assembled) throw new Error('The outfit cannot be composed for this profile.');
    const triangles = assembled.index!.count / 3;
    if (triangles > avatarLimits.triangles)
      throw new Error('This complete outfit exceeds the 10,000-triangle budget.');
    const skinWeights = assembled.getAttribute('skinWeight');
    let influences = 0;
    for (let v = 0; v < skinWeights.count; v++)
      influences = Math.max(
        influences,
        [skinWeights.getX(v), skinWeights.getY(v), skinWeights.getZ(v), skinWeights.getW(v)].filter(
          (w) => w > 0,
        ).length,
      );
    mesh.geometry = assembled;
    mesh.material = privateMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
    mesh.castShadow = true;
    mesh.frustumCulled = false;
    const root = new THREE.Group();
    root.add(model);
    const mixer = new THREE.AnimationMixer(model),
      actions = new Map<AnimationId, THREE.AnimationAction>();
    for (const id of appearance.animations) {
      const clip = THREE.AnimationClip.findByName(base.animations, id);
      if (!clip) throw new Error(`Missing approved animation: ${id}`);
      if (
        clip.tracks.some((track) => !referenceRig.some((joint) => track.name === `${joint.name}.quaternion`))
      )
        throw new Error('Animation contains unsupported root, translation or scale tracks.');
      actions.set(id, mixer.clipAction(clip));
    }
    let locomotion: AnimationId = 'idle',
      active = actions.get('idle')!.play(),
      fading: THREE.AnimationAction | undefined,
      fadeRemaining = 0,
      social: THREE.AnimationAction | undefined,
      socialId: 'wave' | 'dance' | null = null,
      socialRemaining = 0,
      disposed = false;
    function emote(id: 'wave' | 'dance', age = 0) {
      const action = actions.get(id);
      if (!action) return;
      social?.stop();
      const duration = action.getClip().duration;
      if (age >= duration) return;
      social = action;
      socialId = id;
      socialRemaining = duration - Math.max(age, 0);
      action.reset().setLoop(THREE.LoopOnce, 1).setEffectiveWeight(1).play();
      action.time = Math.max(age, 0);
    }
    return {
      root,
      budget: {
        triangles,
        drawCalls: null,
        materials: 1,
        texturePixels: 0,
        textureBytes: 0,
        skinningTextureBytes: 0,
        joints: mesh.skeleton.bones.length,
        influences,
        coveredTriangles,
        pass: 'Unmeasured until rendered in the isolated primary colour pass',
      },
      update(delta, value) {
        if (disposed) return;
        const dt = Math.min(Math.max(delta, 0), 0.1);
        let next: AnimationId = typeof value === 'boolean' ? (value ? 'walk' : 'idle') : value;
        if (['wave', 'dance'].includes(next)) next = 'idle';
        if (!actions.has(next)) next = next === 'run' ? 'walk' : 'idle';
        if (next !== locomotion) {
          fading?.stop();
          fading = active;
          fadeRemaining = 0.16;
          fading.fadeOut(0.16);
          active = actions.get(next)!.reset().setEffectiveWeight(1).fadeIn(0.16).play();
          locomotion = next;
        }
        if (socialId === 'dance' && next !== 'idle') {
          social?.stop();
          social = undefined;
          socialId = null;
        }
        if (fading && (fadeRemaining -= dt) <= 0) {
          fading.stop();
          fading = undefined;
        }
        if (social && (socialRemaining -= dt) <= 0) {
          social.stop();
          social = undefined;
          socialId = null;
        }
        mixer.update(dt);
      },
      wave() {
        emote('wave');
      },
      emote,
      diagnostics() {
        return {
          activeActions: [...actions.values()].filter((action) => action.isRunning()).length,
          locomotion,
          emote: socialId,
        };
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        mixer.stopAllAction();
        mixer.uncacheRoot(model);
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
        mesh.skeleton.dispose();
        root.removeFromParent();
      },
    };
  } catch (error) {
    assembled?.dispose();
    privateMaterial?.dispose();
    mesh.skeleton.dispose();
    throw error;
  } finally {
    pieces.forEach((geometry) => geometry.dispose());
  }
}

export async function loadAvatar(appearance: Appearance): Promise<Avatar> {
  if (appearance.avatarSupported === false)
    throw new Error('This world uses its own avatar for this player.');
  if (appearance.character) {
    const { loadCharacterAvatar } = await import('../character/avatar.js');
    return loadCharacterAvatar(appearance);
  }
  const resources: Awaited<ReturnType<typeof acquireAsset>>[] = [];
  try {
    // Sequential acquisition bounds per-composition pending reads; cache deduplicates actors.
    for (const url of [appearance.bodyAsset, ...appearance.equipped.map((item) => item.assetUrl)])
      resources.push(await acquireAsset(url));
    return composeAvatar(
      appearance,
      resources[0].value,
      resources.slice(1).map((resource) => resource.value),
    );
  } finally {
    resources.forEach((resource) => resource.release());
  }
}

/** Measure actual submitted geometry in one opaque colour pass, with no scene props or shadows. */
export function measureAvatar(renderer: THREE.WebGLRenderer, avatar: Avatar) {
  const scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera(40, 1, 0.1, 20),
    target = new THREE.WebGLRenderTarget(64, 64),
    parent = avatar.root.parent,
    previousTarget = renderer.getRenderTarget(),
    shadows = renderer.shadowMap.enabled,
    autoReset = renderer.info.autoReset;
  scene.add(avatar.root, new THREE.HemisphereLight(0xffffff, 0x445566, 3));
  camera.position.set(3, 2.4, 5);
  camera.lookAt(0, 1.2, 0);
  try {
    renderer.shadowMap.enabled = false;
    renderer.info.autoReset = true;
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    avatar.budget.drawCalls = renderer.info.render.calls;
    avatar.budget.triangles = renderer.info.render.triangles;
    const materials = new Set<THREE.Material>();
    let skinningBytes = 0;
    avatar.root.traverseVisible((object) => {
      const mesh = object as THREE.SkinnedMesh;
      if (mesh.isMesh)
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material])
          materials.add(material);
      if (mesh.isSkinnedMesh && mesh.skeleton.boneTexture)
        skinningBytes += (mesh.skeleton.boneTexture.image.data as Float32Array).byteLength;
    });
    avatar.budget.materials = materials.size;
    avatar.budget.skinningTextureBytes = skinningBytes;
    avatar.budget.textureBytes = skinningBytes;
    avatar.budget.pass =
      'Measured isolated opaque colour pass, 64×64 offscreen; shadows and postprocessing disabled';
    if (avatar.budget.drawCalls > avatarLimits.drawCalls)
      throw new Error('Complete outfit exceeds the primary colour-pass draw budget.');
    if (
      avatar.budget.triangles >
        (avatar.budget.profile === 'pocket-humanoid-v2' ? 40000 : avatarLimits.triangles) ||
      materials.size > avatarLimits.materials ||
      avatar.budget.textureBytes > avatarLimits.textureBytes
    )
      throw new Error('Complete outfit exceeds the rendering profile budget.');
    return avatar.budget;
  } finally {
    renderer.setRenderTarget(previousTarget);
    renderer.shadowMap.enabled = shadows;
    renderer.info.autoReset = autoReset;
    if (parent) parent.add(avatar.root);
    else avatar.root.removeFromParent();
    target.dispose();
  }
}
