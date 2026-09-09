import * as THREE from 'three';
import type { Appearance } from '../core/contract.js';
import type { Pose } from '../wire/room.js';
import { loadAvatar, measureAvatar, type Avatar } from './avatar.js';
export class PresentedActor {
  readonly root = new THREE.Group();
  readonly label: HTMLDivElement;
  readonly annotation: HTMLDivElement;
  private avatar?: Avatar;
  private head?: THREE.Object3D;
  private anchor = new THREE.Vector3();
  private fallback: THREE.Mesh;
  private requested = 0;
  private revision = 0;
  private emoteStart = 0;
  private disposed = false;
  private loadFailed = false;
  constructor(
    readonly id: string,
    private scene: THREE.Scene,
    private labels: HTMLElement,
  ) {
    this.root.userData.actorId = id;
    this.fallback = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.25, 0.8, 2, 6),
      new THREE.MeshStandardMaterial({ color: '#bcfa68' }),
    );
    this.fallback.position.y = 1;
    this.root.add(this.fallback);
    this.label = document.createElement('div');
    this.label.className = 'actor-label';
    this.label.dataset.actorId = id;
    this.annotation = document.createElement('div');
    this.annotation.className = 'actor-annotation';
    this.annotation.append(this.label);
    this.labels.append(this.annotation);
    this.scene.add(this.root);
  }
  async setAppearance(value: Appearance) {
    if ((value.revision ?? 1) < this.revision || this.disposed) return;
    this.revision = value.revision ?? 1;
    const request = ++this.requested;
    this.label.textContent = value.player.name;
    this.label.dataset.revision = String(this.revision);
    this.label.dataset.items = value.equipped.map((i) => i.id).join(',');
    this.label.dataset.assetState = 'loading';
    (this.fallback.material as THREE.MeshStandardMaterial).color.set(value.player.color);
    try {
      const avatar = await loadAvatar(value);
      if (request !== this.requested || this.disposed) {
        avatar.dispose();
        return false;
      }
      if (this.avatar) {
        this.root.remove(this.avatar.root);
        this.avatar.dispose();
      }
      this.avatar = avatar;
      this.head = avatar.root.getObjectByName('Head');
      this.loadFailed = false;
      this.emoteStart = 0;
      this.label.title = '';
      this.label.dataset.assetState = 'ready';
      this.root.add(avatar.root);
      this.fallback.visible = false;
      this.label.dataset.revision = String(this.revision);
      this.label.dataset.items = value.equipped.map((i) => i.id).join(',');
      return true;
    } catch {
      if (request === this.requested) {
        this.label.title = 'Appearance unavailable; showing the explorer fallback. Ownership is unchanged.';
        this.loadFailed = true;
        this.label.dataset.assetState = 'fallback';
        this.fallback.visible = true;
        if (this.avatar) this.avatar.root.visible = false;
      }
      return false;
    }
  }
  update(pose: Pose, delta: number, camera: THREE.Camera, width: number, height: number, now: number) {
    this.root.position.set(pose.x, pose.y, pose.z);
    this.root.rotation.y = pose.facing;
    if (this.avatar && pose.emote && pose.emote.startedAt !== this.emoteStart) {
      this.emoteStart = pose.emote.startedAt;
      this.avatar.emote(pose.emote.id, Math.max(0, (now - pose.emote.startedAt) / 1000));
    }
    this.avatar?.update(delta, pose.locomotion);
    const far = camera.position.distanceTo(this.root.position) > 24;
    this.fallback.visible = far || !this.avatar || this.loadFailed;
    if (this.avatar) this.avatar.root.visible = !far && !this.loadFailed;
    // Follow the animated head, then keep a small, constant screen-space gap.
    // A single DOM anchor also keeps speech immediately above its nameplate.
    if (this.head && !this.fallback.visible) {
      this.head.getWorldPosition(this.anchor);
      this.anchor.y += 0.24;
    } else {
      this.anchor.set(pose.x, pose.y + 1.7, pose.z);
    }
    const projected = this.anchor.project(camera);
    this.annotation.style.transform = `translate(${(projected.x * 0.5 + 0.5) * width}px,${(-projected.y * 0.5 + 0.5) * height - 6}px) translate(-50%,-100%)`;
    this.annotation.hidden =
      projected.z < -1 || projected.z > 1 || Math.abs(projected.x) > 1.1 || Math.abs(projected.y) > 1.2;
    this.label.dataset.emote = pose.emote && pose.emote.endsAt > now ? pose.emote.id : 'idle';
  }
  get budget() {
    return this.avatar?.budget;
  }
  measure(renderer: THREE.WebGLRenderer) {
    if (this.avatar && !this.loadFailed) return measureAvatar(renderer, this.avatar);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.requested++;
    this.avatar?.dispose();
    this.fallback.geometry.dispose();
    (this.fallback.material as THREE.Material).dispose();
    this.scene.remove(this.root);
    this.annotation.remove();
  }
}
