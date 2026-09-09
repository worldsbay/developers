import type { InputIntent, Motion, Pose } from '../wire/room.js';
import type { WorldDefinition } from '../wire/world.js';
import { stepMotion } from './movement.js';
export class Prediction {
  private pending: { input: InputIntent; dt: number }[] = [];
  private switchOn = false;
  private previous: Motion;
  private correction = { x: 0, y: 0, z: 0, facing: 0 };
  private resetPresentation = true;
  constructor(
    public pose: Motion,
    private definition: WorldDefinition,
  ) {
    this.previous = { ...pose };
  }
  setSwitch(open: boolean) {
    this.switchOn = open;
  }
  private currentDefinition() {
    return this.switchOn
      ? { ...this.definition, collisions: this.definition.collisions.filter((c) => c.id !== 'showroom-door') }
      : this.definition;
  }
  advance(input: InputIntent, dt: number) {
    this.previous = { ...this.pose };
    this.pose = stepMotion(this.pose, input, dt, this.currentDefinition());
    this.pending.push({ input: { ...input }, dt });
    if (this.pending.length > 120) this.pending.shift();
    return this.pose;
  }
  reconcile(pose: Pose) {
    const predicted = this.pose;
    this.pending = this.pending.filter((p) => p.input.seq > pose.ack);
    this.pose = { ...pose };
    for (const frame of this.pending)
      this.pose = stepMotion(this.pose, frame.input, frame.dt, this.currentDefinition());
    const dx = predicted.x - this.pose.x,
      dy = predicted.y - this.pose.y,
      dz = predicted.z - this.pose.z,
      facing = angleDifference(predicted.facing, this.pose.facing);
    // Spawn/reconnect and large authoritative relocations must not glide through the world.
    if (this.resetPresentation || Math.hypot(dx, dy, dz) > 2) {
      this.previous = { ...this.pose };
      this.correction = { x: 0, y: 0, z: 0, facing: 0 };
      this.resetPresentation = false;
      return;
    }
    // Move both interpolation endpoints together, preserving the displayed position.
    // Only the visual offset is eased; collision checks use the corrected simulation immediately.
    this.previous = {
      ...this.previous,
      x: this.previous.x - dx,
      y: this.previous.y - dy,
      z: this.previous.z - dz,
      facing: this.previous.facing - facing,
    };
    this.correction.x += dx;
    this.correction.y += dy;
    this.correction.z += dz;
    this.correction.facing += facing;
  }
  sample(alpha: number, delta: number): Motion {
    const blend = Math.max(0, Math.min(1, alpha)),
      elapsed = Math.max(0, delta),
      distance = Math.hypot(this.correction.x, this.correction.y, this.correction.z),
      // A delayed snapshot can leave a larger offset; limit its recovery speed as well as easing it.
      decay = Math.max(Math.exp(-elapsed * 15), 1 - (elapsed * 3) / Math.max(distance, 0.000001));
    this.correction.x *= decay;
    this.correction.y *= decay;
    this.correction.z *= decay;
    this.correction.facing *= Math.exp(-elapsed * 15);
    return {
      ...this.pose,
      x: this.previous.x + (this.pose.x - this.previous.x) * blend + this.correction.x,
      y: this.previous.y + (this.pose.y - this.previous.y) * blend + this.correction.y,
      z: this.previous.z + (this.pose.z - this.previous.z) * blend + this.correction.z,
      facing:
        this.previous.facing +
        angleDifference(this.pose.facing, this.previous.facing) * blend +
        this.correction.facing,
    };
  }
  clear() {
    this.pending = [];
    this.previous = { ...this.pose };
    this.correction = { x: 0, y: 0, z: 0, facing: 0 };
    this.resetPresentation = true;
  }
}
function angleDifference(to: number, from: number) {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}
export class PoseBuffer {
  private frames: { time: number; pose: Pose }[] = [];
  push(time: number, pose: Pose) {
    if (this.frames.length && time < this.frames.at(-1)!.time) return;
    this.frames.push({ time, pose });
    if (this.frames.length > 20) this.frames.shift();
  }
  at(time: number): Pose | undefined {
    if (!this.frames.length) return;
    let before = this.frames[0],
      after = this.frames.at(-1)!;
    for (const frame of this.frames) {
      if (frame.time <= time) before = frame;
      if (frame.time >= time) {
        after = frame;
        break;
      }
    }
    const blend = Math.max(0, Math.min(1, (time - before.time) / Math.max(1, after.time - before.time)));
    return {
      ...after.pose,
      x: before.pose.x + (after.pose.x - before.pose.x) * blend,
      y: before.pose.y + (after.pose.y - before.pose.y) * blend,
      z: before.pose.z + (after.pose.z - before.pose.z) * blend,
      facing:
        before.pose.facing +
        Math.atan2(
          Math.sin(after.pose.facing - before.pose.facing),
          Math.cos(after.pose.facing - before.pose.facing),
        ) *
          blend,
    };
  }
}
