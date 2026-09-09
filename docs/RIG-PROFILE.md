# Avatar formats

WorldsBay appearances currently use `pocket-humanoid-v1` for classic avatars and `pocket-humanoid-v2` for modular characters. The public `Appearance` identifies the profile and supplies approved assets. Neither profile is a claim of general VRM compatibility.

Use the included loader when possible. A custom engine must preserve the approved joint hierarchy, bind pose and clip semantics, and apply the correct profile. The world-definition `avatarProfile` field currently remains the v1 protocol marker even though the appearance renderer supports both formats; inspect the received appearance to choose a renderer.

## Common conventions

Assets are self-contained glTF 2.0 binary (`.glb`), in metres, with +Y up and +Z forward. Keep the gameplay transform separate from the skeleton. Do not accept unvalidated uploads or external asset references through the world integration.

Room animation IDs are `idle`, `walk`, `run`, `jump`, `fall`, `land`, `wave` and `dance`. Server pose and emote times drive remote playback. Copying a skeleton does not copy the lifetime rules: release per-instance geometry, material, mixer and skeleton resources when an actor leaves.

## Classic profile: v1

The reference hierarchy is defined in [`packages/core/profile.ts`](../packages/core/profile.ts), with rig revision `humanoid-1`. Rest rotations are identity and scale is one. These translations are relative to the parent:

| Joint    | Parent    | Translation       |
| -------- | --------- | ----------------- |
| Hips     | Mesh root | `0, 0.90, 0`      |
| Spine    | Hips      | `0, 0.45, 0`      |
| Head     | Spine     | `0, 0.45, 0`      |
| LeftArm  | Spine     | `-0.45, 0.21, 0`  |
| RightArm | Spine     | `0.45, 0.21, 0`   |
| LeftLeg  | Hips      | `-0.18, -0.05, 0` |
| RightLeg | Hips      | `0.18, -0.05, 0`  |

This stylized rig has no elbows, knees, fingers or facial bones. Preserve the existing names and coordinates when mapping to another engine; do not silently reinterpret anatomical handedness.

Rigid cosmetics attach to Head or Spine. The four mutually exclusive slots are head, face, back and upper-body. Skinned garments must match the reference bind matrices. An upper-body item declaring `coverage: ["torso"]` hides only the supported torso region, marked by `_BODYREGION`; arbitrary layering is not defined.

The composition uses opaque vertex-color materials. Profile limits are 10,000 triangles, 64 joints, four influences per vertex, two materials and two color-pass draw calls per assembled avatar. These are profile budgets, not a total frame-cost guarantee. The current composition rejects textured products even though legacy budget constants include texture limits.

Classic clips contain approved bone quaternion tracks without root-motion translation or scale. Preserve their IDs and timing from the supplied assets.

## Modular profile: v2

The [character contract](../packages/character/contract.ts) declares the recipe, pack, rig, part and animation shapes. Each recipe pins an immutable pack revision. Its rig asset is the bind reference: preserve joint names/order, hierarchy, world bind matrices and native axes. Different rig families cannot be mixed without an explicitly fitted part in the approved pack.

Modular parts use an indexed skinned triangle primitive and opaque material, with `POSITION`, `NORMAL`, `COLOR_0`, `JOINTS_0` and normalized `WEIGHTS_0`. Tint tags distinguish authored, skin, hair and clothing colors. The profile supports up to 64 joints, four influences and 40,000 triangles per assembled character; the included composer merges it to one material and one color-pass draw call. Shadows add rendering work.

Core animation assets retain the matching rest hierarchy. Additional clips need matching rigs and your own gameplay timing rules. Bind-relative retargeting and explicit fitting are required for assets from another rig; changing bone names is insufficient. Character body-shape sliders, facial animation and general collision-based outfit fitting are not part of this runtime.

The checkout includes no reference GLB library, authoring pipeline or asset-publishing tool. Use the authorized files supplied with an appearance for rendering, and retain their source/license metadata when redistributing them. Read [character integration](CHARACTER-BUILDER.md) for available browser APIs and asset delivery.

[Back to the README](../README.md)
