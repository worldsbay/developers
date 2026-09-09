export const PROFILE = 'pocket-humanoid-v1';
export const RIG_REVISION = 'humanoid-1' as const;
export const referenceRig = [
  { name: 'Hips', parent: null, position: [0, 0.9, 0], semantic: 'hips' },
  { name: 'Spine', parent: 'Hips', position: [0, 0.45, 0], semantic: 'spine' },
  { name: 'Head', parent: 'Spine', position: [0, 0.45, 0], semantic: 'head' },
  { name: 'LeftArm', parent: 'Spine', position: [-0.45, 0.21, 0], semantic: 'leftUpperArm' },
  { name: 'RightArm', parent: 'Spine', position: [0.45, 0.21, 0], semantic: 'rightUpperArm' },
  { name: 'LeftLeg', parent: 'Hips', position: [-0.18, -0.05, 0], semantic: 'leftUpperLeg' },
  { name: 'RightLeg', parent: 'Hips', position: [0.18, -0.05, 0], semantic: 'rightUpperLeg' },
] as const;
export const avatarLimits = {
  triangles: 10000,
  drawCalls: 2,
  materials: 2,
  textureDimension: 1024,
  textureBytes: 8 * 1024 * 1024,
  joints: 64,
  influences: 4,
} as const;
