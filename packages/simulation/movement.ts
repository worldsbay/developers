import type { WorldDefinition } from '../wire/world.js';
import type { InputIntent, Motion } from '../wire/room.js';
export const WALK_SPEED = 3.8,
  RUN_SPEED = 5.8,
  GRAVITY = 18,
  JUMP_SPEED = 6;
export function spawnMotion(position: { x: number; y: number; z: number }): Motion {
  return { ...position, vy: 0, facing: 0, grounded: true, locomotion: 'idle' };
}
export function stepMotion(
  state: Motion,
  input: InputIntent,
  dt: number,
  definition: WorldDefinition,
): Motion {
  dt = Math.min(Math.max(dt, 0), 0.05);
  const next = { ...state },
    length = Math.hypot(input.x, input.z),
    scale = length > 1 ? 1 / length : 1,
    speed = input.run ? RUN_SPEED : WALK_SPEED;
  if (input.jump && next.grounded) {
    next.vy = JUMP_SPEED;
    next.grounded = false;
  }
  const oldY = next.y;
  if (!next.grounded) {
    next.vy -= GRAVITY * dt;
    next.y += next.vy * dt;
    if (next.y <= 0) {
      next.y = 0;
      next.vy = 0;
      next.grounded = true;
    }
  }
  const radius = 0.3,
    collides = (x: number, z: number) =>
      definition.collisions.some(
        (b) =>
          next.y < b.height &&
          x + radius > b.minX &&
          x - radius < b.maxX &&
          z + radius > b.minZ &&
          z - radius < b.maxZ,
      );
  const x = Math.min(
    definition.bounds.maxX,
    Math.max(definition.bounds.minX, next.x + input.x * scale * speed * dt),
  );
  if (!collides(x, next.z)) next.x = x;
  const z = Math.min(
    definition.bounds.maxZ,
    Math.max(definition.bounds.minZ, next.z + input.z * scale * speed * dt),
  );
  if (!collides(next.x, z)) next.z = z;
  next.facing = input.facing;
  next.locomotion = !next.grounded
    ? next.vy > 0
      ? 'jump'
      : 'fall'
    : oldY > 0
      ? 'land'
      : length > 0.01
        ? input.run
          ? 'run'
          : 'walk'
        : 'idle';
  return next;
}
