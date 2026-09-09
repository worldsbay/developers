import { brandMark } from '../ui/brand.js';
import { hubMarkup, mountHub } from '../ui/hub.js';
import * as THREE from 'three';
import { WorldsBay, RoomConnection } from '@worldsbay/api';
import { el, escapeHtml as esc, toast } from '../ui/dom.js';
import { buildWorld, rendererFor } from './scenes.js';
import { createGraphicsQuality } from './quality.js';
import { PresentedActor } from './actor.js';
import { assetCacheMetrics } from './asset-cache.js';
import { Prediction, PoseBuffer } from '../simulation/prediction.js';
import { spawnMotion } from '../simulation/movement.js';
import type { Appearance, Item, World } from '../core/contract.js';
import { defaultDefinition, type WorldDefinition } from '../wire/world.js';
import type { Pose, RoomSnapshot, ChatMessage } from '../wire/room.js';
export { buildWorld };

export async function startWorld(
  options: { createScene?: (definition: WorldDefinition) => ReturnType<typeof buildWorld> } = {},
) {
  const sdk = new WorldsBay();
  let homeUrl = document.body.dataset.homeUrl || '/',
    busy = false,
    travelCooldown = 0;
  const keys = new Set<string>();
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let transitionTimer = 0;
  const finishTransition = () => {
    const panel = document.querySelector<HTMLElement>('#transition');
    if (!panel) return;
    panel.classList.add('is-leaving');
    clearTimeout(transitionTimer);
    transitionTimer = window.setTimeout(() => panel.remove(), reducedMotion.matches ? 0 : 420);
  };
  const overlay = (title: string, copy: string) => {
    clearTimeout(transitionTimer);
    let panel = document.querySelector<HTMLElement>('#transition');
    if (!panel) {
      panel = document.createElement('section');
      panel.id = 'transition';
      panel.className = 'loading-overlay';
      document.body.append(panel);
    }
    panel.classList.remove('is-leaving');
    panel.setAttribute('role', 'status');
    panel.innerHTML = `${brandMark}<h2>${esc(title)}</h2><p>${esc(copy)}</p><a class="button" href="${esc(homeUrl)}">Return Home</a>`;
  };
  try {
    overlay('A little adventure awaits.', 'Opening the doors to your world.');
    const cfg = await sdk.getConfig();
    homeUrl = cfg.homeUrl;
    document.title = `${cfg.world.name} — WorldsBay`;
    if (new URL(location.href).searchParams.get('entry') === 'failed') {
      overlay(
        'The doorway has closed.',
        'Your ticket could not be accepted. Return Home for a fresh entry; your collection is saved.',
      );
      return;
    }
    overlay('Welcome back, explorer.', 'Getting your look ready for the journey.');
    const session = await sdk.enterSession(),
      definition =
        session.world.definition ??
        defaultDefinition(
          session.world.id,
          session.world.name,
          session.destinations.map((w) => w.id),
        );
    let destination =
      session.destinations.find((w) => w.id === definition.portals[0]?.target) ?? session.destinations[0];
    overlay('Making yourself at home.', 'A place to meet. A world to discover.');
    const world =
        options.createScene?.(definition) ?? buildWorld(session.world.id, definition, session.destinations),
      renderer = rendererFor(el('#scene'));
    const quality = createGraphicsQuality(renderer, world.scene, el('#scene'));
    const portalPosition = definition.portals[0]?.position ?? definition.spawn;
    world.portal.position.set(portalPosition.x, portalPosition.y + 1.65, portalPosition.z);
    world.portalPosition.set(portalPosition.x, portalPosition.y, portalPosition.z);
    for (const portal of options.createScene ? definition.portals.slice(1) : []) {
      const copy = world.portal.clone();
      copy.position.set(portal.position.x, portal.position.y + 1.65, portal.position.z);
      world.scene.add(copy);
    }
    const camera = new THREE.PerspectiveCamera(48, innerWidth / innerHeight, 0.1, 120);
    const lifecycle = new AbortController(),
      listenerOptions = { signal: lifecycle.signal };
    camera.position.set(5, 5.7, 14);
    const labels = document.createElement('div');
    labels.className = 'actor-labels';
    document.body.append(labels);
    const actors = new Map<string, PresentedActor>(),
      appearances = new Map<string, Appearance>(),
      buffers = new Map<string, PoseBuffer>();
    const speech = new Map<string, { element: HTMLDivElement; expiresAt: number }>();
    const showSpeech = (message: ChatMessage) => {
      let bubble = speech.get(message.actorId);
      if (!bubble) {
        const element = document.createElement('div');
        element.className = 'hub-speech';
        element.dataset.actorId = message.actorId;
        bubble = { element, expiresAt: 0 };
        speech.set(message.actorId, bubble);
      }
      bubble.element.textContent =
        message.text.length > 110 ? message.text.slice(0, 107) + '…' : message.text;
      bubble.expiresAt = performance.now() + 7000;
    };
    let snapshot: RoomSnapshot | undefined,
      serverOffset = 0;
    const prediction = new Prediction(spawnMotion(definition.spawn), definition);
    let selfPose: Pose | undefined;
    const connection = new RoomConnection(() => sdk.enterSession());
    const doorBox = definition.collisions.find((box) => box.id === 'showroom-door');
    const door = new THREE.Mesh(
      new THREE.BoxGeometry(
        doorBox ? doorBox.maxX - doorBox.minX : 0.35,
        doorBox?.height ?? 2.2,
        doorBox ? doorBox.maxZ - doorBox.minZ : 2,
      ),
      new THREE.MeshStandardMaterial({
        color: '#769e8b',
        metalness: 0.3,
        roughness: 0.35,
        emissive: '#274e46',
        emissiveIntensity: 0.35,
        transparent: true,
        opacity: 0.55,
      }),
    );
    door.position.set(
      doorBox ? (doorBox.minX + doorBox.maxX) / 2 : 3,
      (doorBox?.height ?? 2.2) / 2,
      doorBox ? (doorBox.minZ + doorBox.maxZ) / 2 : 0,
    );
    if (doorBox) world.scene.add(door);
    const switchMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.35, 0.4, 0.9, 12),
      new THREE.MeshStandardMaterial({
        color: '#ecc891',
        metalness: 0.4,
        roughness: 0.3,
        emissive: '#8d6435',
        emissiveIntensity: 0.25,
      }),
    );
    const switchPosition =
      definition.interactions.find(
        (interaction) => interaction.kind === 'switch' || interaction.kind === 'race-ready',
      )?.position ?? definition.spawn;
    switchMesh.position.set(switchPosition.x, switchPosition.y + 0.45, switchPosition.z);
    world.scene.add(switchMesh);
    const checkpoints: THREE.Mesh[] = [];
    if (definition.scene === 'race')
      for (const point of [
        { x: 0, z: -1 },
        { x: -4, z: -3 },
        { x: 4, z: -5 },
        { x: 0, z: -8 },
      ]) {
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(0.9, 0.08, 6, 24),
          new THREE.MeshStandardMaterial({ color: '#ffcb77', emissive: '#665024' }),
        );
        ring.rotation.x = Math.PI / 2;
        ring.position.set(point.x, 0.15, point.z);
        world.scene.add(ring);
        checkpoints.push(ring);
      }
    el('#world-ui').innerHTML = hubMarkup({
      homeUrl,
      worldName: session.world.name,
      playerName: session.appearance.player.name,
      isRace: definition.scene === 'race',
      destinations: session.destinations,
    });
    const hub = mountHub({
      connection,
      clearMovement: () => keys.clear(),
      quality,
      actorId: () => connection.actorId,
    });
    const syncQuality = () => hub.setQuality(quality.mode, quality.tier);
    el('#scene').addEventListener('graphicsqualitychange', syncQuality, listenerOptions);
    const updateOutfit = (value: Appearance) => {
      session.appearance = value;
      el('#player-name').textContent = value.player.name;
      el('#outfit-label').textContent = value.equipped.map((i) => i.name).join(' · ') || 'Starter look';
      el('#scene').dataset.equipped = value.equipped.map((i) => i.id).join(',');
      el('#scene').dataset.player = session.appearance.player.id;
      el('#scene').dataset.revision = String(value.revision ?? 1);
    };
    updateOutfit(session.appearance);
    let sceneReadySent = false;
    const present = async (id: string, value: Appearance) => {
      const previous = appearances.get(id);
      if (previous && (previous.revision ?? 1) > (value.revision ?? 1)) return;
      appearances.set(id, value);
      let actor = actors.get(id);
      if (!actor) {
        actor = new PresentedActor(id, world.scene, labels);
        actors.set(id, actor);
      }
      const loaded = await actor.setAppearance(value);
      if (appearances.get(id) !== value || actors.get(id) !== actor) return;
      if (loaded) actor.measure(renderer);
      if (id === connection.actorId) {
        updateOutfit({ ...value, player: { ...value.player, id: session.appearance.player.id } });
        el('#scene').dataset.ready = 'true';
        el('#scene').dataset.assetState = loaded ? 'ready' : 'fallback';
        finishTransition();
        if (loaded && !sceneReadySent) {
          sceneReadySent = true;
          connection.send({ type: 'diagnostic', stage: 'scene-ready' });
        }
        const budget = actor.budget;
        el('#avatar-stats').textContent = budget
          ? `${budget.triangles.toLocaleString()} triangles · ${budget.drawCalls} draw call · ${budget.materials} material · no textures`
          : 'Avatar fallback · canonical outfit remains recorded';
      }
    };
    connection.on('welcome', (message) => {
      serverOffset = Date.now() - message.time;
      prediction.clear();
      sceneReadySent = false;
      hub.setChatHistory(message.chatHistory ?? []);
      for (const [id, appearance] of Object.entries(message.appearances)) void present(id, appearance);
      connection.send({ type: 'diagnostic', stage: 'room-joined' });
    });
    // Admission sends the appearance immediately before the snapshot that adds the actor.
    connection.on('appearance', ({ actorId, appearance }) => {
      void present(actorId, appearance);
    });
    connection.on('chat', (message) => {
      hub.receiveChat(message);
      showSpeech(message);
    });
    connection.on('state', (state) => {
      hub.setConnection(state);
      el('#scene').dataset.connection = state;
      if (state !== 'ready') {
        keys.clear();
        prediction.clear();
      }
      if (state === 'expired' || state === 'offline') document.querySelector('#transition')?.remove();
    });
    connection.on('central', (available) => {
      el('#central-state').textContent = available
        ? ''
        : 'Travel is taking a break. You can still hang out here.';
    });
    connection.on('error', (message) => toast(message, true));
    connection.on('snapshot', (value) => {
      snapshot = value;
      prediction.setSwitch(value.game.switchOn);
      hub.setPeople(value.actors);
      el('#scene').dataset.actorCount = String(value.actors.length);
      const ids = new Set(value.actors.map((a) => a.id));
      for (const [id, actor] of actors)
        if (!ids.has(id)) {
          actor.dispose();
          actors.delete(id);
          appearances.delete(id);
          buffers.delete(id);
          speech.get(id)?.element.remove();
          speech.delete(id);
        }
      for (const pose of value.actors) {
        if (pose.id === connection.actorId) {
          selfPose = pose;
          prediction.reconcile(pose);
          el('#scene').dataset.emote = pose.emote?.id ?? 'idle';
          el('#wave-status').textContent = pose.emote
            ? pose.emote.id === 'wave'
              ? 'Waving hello'
              : 'Dancing'
            : '';
        } else {
          const buffer = buffers.get(pose.id) ?? new PoseBuffer();
          buffer.push(value.time, pose);
          buffers.set(pose.id, buffer);
        }
      }
      el('#game-state').textContent =
        definition.scene === 'race'
          ? `${value.game.race.phase.toUpperCase()} · Round ${value.game.race.round}${value.game.race.phase === 'countdown' ? ` · ${Math.max(0, Math.ceil((value.game.race.phaseEndsAt - value.time) / 1000))}` : ''}`
          : `Showroom door: ${value.game.switchOn ? 'open' : 'closed'}`;
      const race = value.game.race,
        racer = race.racers[connection.actorId];
      if (definition.scene === 'race') {
        el('#race-results').textContent = racer
          ? `Checkpoint ${racer.checkpoint}/${race.checkpoints.length}${racer.finishedMs !== null ? ` · Finished in ${(racer.finishedMs / 1000).toFixed(2)}s` : racer.dnf ? ' · Did not finish' : ''}`
          : `${race.ready.length} ready`;
        el<HTMLButtonElement>('#shared-interact').textContent =
          race.phase === 'results' ? 'Reset race' : 'Ready to race';
        checkpoints.forEach((point, index) =>
          (point.material as THREE.MeshStandardMaterial).color.set(
            index === (racer?.checkpoint ?? 0) ? '#bcfa68' : '#b6a5ff',
          ),
        );
      }
    });
    async function travel(target = destination?.id) {
      if (busy || Date.now() < travelCooldown) return;
      if (!target) return;
      busy = true;
      keys.clear();
      hub.closePanels();
      overlay(
        'Crossing over…',
        target === 'random'
          ? 'Finding another world for your explorer.'
          : `Taking your explorer to ${session.destinations.find((w) => w.id === target)?.name ?? 'a new world'}.`,
      );
      try {
        const result = await sdk.requestTravel(target);
        connection.disconnect();
        location.assign(result.url);
      } catch (error) {
        busy = false;
        travelCooldown = Date.now() + 5000;
        document.querySelector('#transition')?.remove();
        toast((error as Error).message, true);
      }
    }
    async function store(itemId?: string, character = false) {
      if (busy) return;
      busy = true;
      keys.clear();
      overlay(
        character ? 'Make it your own.' : 'A fresh look awaits.',
        'Your friends will be here when you return.',
      );
      try {
        const result = character ? await sdk.openCharacterCreator() : await sdk.openWardrobe(itemId);
        connection.disconnect();
        location.assign(result.url);
      } catch (error) {
        busy = false;
        document.querySelector('#transition')?.remove();
        toast((error as Error).message, true);
      }
    }
    const emote = (id: 'wave' | 'dance') => {
      if (!busy) connection.send({ type: 'emote', id });
    };
    el('#travel').onclick = () => void travel();
    const description = el('#destination-description');
    const chooseDestination = (target: string) => {
      const selected = session.destinations.find((w) => w.id === target);
      if (!selected) return;
      destination = selected;
      el('#travel').textContent = `Travel to ${destination.name} ↗`;
      description.textContent = destination.description;
      document.querySelectorAll<HTMLButtonElement>('[data-destination]').forEach((button) => {
        button.setAttribute('aria-pressed', String(button.dataset.destination === target));
      });
    };
    if (destination) chooseDestination(destination.id);
    else {
      el<HTMLButtonElement>('#travel').disabled = true;
      el('#travel').textContent = 'More worlds coming soon';
      description.textContent = 'Make yourself at home while new destinations arrive.';
    }
    const portalLabels = definition.portals.map((portal) => {
      const target = session.destinations.find((w) => w.id === portal.target);
      const label = document.createElement('button');
      label.className = 'portal-label hub-portal-label';
      label.hidden = true;
      label.dataset.portal = portal.target;
      label.style.setProperty('--portal-accent', target?.accent ?? '#c4b4ff');
      label.setAttribute('aria-label', `Open portal to ${target?.name ?? 'a surprise world'}`);
      label.innerHTML = `<strong>${esc(target?.name ?? 'Surprise me')} ↗</strong><span>Step inside to explore</span>`;
      label.onclick = () => void travel(portal.target);
      labels.append(label);
      return {
        label,
        position: new THREE.Vector3(portal.position.x, portal.position.y + 3.8, portal.position.z),
      };
    });
    document.querySelectorAll<HTMLButtonElement>('[data-destination]').forEach((button) => {
      button.onclick = () => chooseDestination(button.dataset.destination!);
    });
    el('#store').onclick = () => void store();
    el('#edit-character').onclick = () => void store(undefined, true);
    el('#wave').onclick = () => emote('wave');
    el('#touch-wave').onclick = () => emote('wave');
    el('#dance').onclick = () => emote('dance');
    el('#respawn').onclick = () => connection.send({ type: 'interact', id: 'respawn' });
    el('#shared-interact').onclick = () =>
      connection.send({
        type: 'interact',
        id:
          definition.scene === 'race'
            ? snapshot?.game.race.phase === 'results'
              ? 'race-reset'
              : 'race-ready'
            : 'showroom-switch',
      });
    el('#refresh-appearance').onclick = () => {
      void sdk
        .refreshAppearance()
        .then((value) => {
          if (connection.actorId) void present(connection.actorId, value);
        })
        .catch((error) => toast(error.message, true));
    };
    async function inspect(actorId?: string) {
      keys.clear();
      const appearance = actorId ? appearances.get(actorId) : undefined;
      const items: Item[] = appearance ? appearance.equipped : await sdk.getCollection();
      el('#inspection-title').textContent = appearance
        ? `${appearance.player.name} is wearing`
        : 'Showroom collection';
      el('#inspection-items').innerHTML = items.length
        ? items
            .map(
              (item) =>
                `<article><h3>${esc(item.name)}</h3><p>${esc(item.creator)} · Free</p><button data-open-product="${item.id}">View ${esc(item.name)} in wardrobe ↗</button></article>`,
            )
            .join('')
        : '<p>This explorer is wearing the free starter body.</p>';
      keys.clear();
      el<HTMLDialogElement>('#inspection').showModal();
    }
    el('#inspect-display').onclick = () => {
      void inspect().catch((error) => toast(error.message, true));
    };
    el('#close-inspection').onclick = () => el<HTMLDialogElement>('#inspection').close();
    document.addEventListener(
      'click',
      (event) => {
        const button = (event.target as HTMLElement).closest<HTMLElement>(
          '[data-inspect-actor],[data-open-product]',
        );
        if (button?.dataset.inspectActor)
          void inspect(button.dataset.inspectActor).catch((error) => toast(error.message, true));
        if (button?.dataset.openProduct) void store(button.dataset.openProduct);
      },
      listenerOptions,
    );
    const raycaster = new THREE.Raycaster();
    renderer.domElement.addEventListener(
      'click',
      (event) => {
        if (hub.isPanelOpen()) {
          hub.closePanels();
          return;
        }
        raycaster.setFromCamera(
          new THREE.Vector2((event.clientX / innerWidth) * 2 - 1, (-event.clientY / innerHeight) * 2 + 1),
          camera,
        );
        const hit = raycaster.intersectObjects(
          [...actors.values()].map((a) => a.root),
          true,
        )[0];
        let object: THREE.Object3D | null = hit?.object ?? null;
        while (object && !object.userData.actorId) object = object.parent;
        if (object?.userData.actorId)
          void inspect(object.userData.actorId).catch((error) => toast(error.message, true));
      },
      listenerOptions,
    );
    addEventListener(
      'keydown',
      (event) => {
        if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
        if ((event.target as HTMLElement).closest('dialog,input,select,textarea,[contenteditable="true"]'))
          return;
        if (event.key === ' ' && (event.target as HTMLElement).closest('button,a')) return;
        if (hub.isPanelOpen() || document.querySelector('dialog[open]')) return;
        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(event.key))
          event.preventDefault();
        const key = event.key.toLowerCase();
        if (key === 'e' && !event.repeat) emote('wave');
        keys.add(key);
      },
      listenerOptions,
    );
    addEventListener('keyup', (event) => keys.delete(event.key.toLowerCase()), listenerOptions);
    addEventListener('blur', () => keys.clear(), listenerOptions);
    document.addEventListener('visibilitychange', () => keys.clear(), listenerOptions);
    document.addEventListener(
      'focusin',
      (event) => {
        if ((event.target as HTMLElement).closest('input,select,textarea,[contenteditable="true"]'))
          keys.clear();
      },
      listenerOptions,
    );
    document.querySelectorAll<HTMLButtonElement>('[data-key]').forEach((button) => {
      button.onpointerdown = (event) => {
        event.preventDefault();
        if (hub.isPanelOpen() || busy) return;
        button.setPointerCapture(event.pointerId);
        keys.add(button.dataset.key!);
      };
      button.onpointerup =
        button.onpointercancel =
        button.onlostpointercapture =
          () => keys.delete(button.dataset.key!);
    });
    const resize = () => {
      renderer.setSize(innerWidth, innerHeight);
      camera.aspect = innerWidth / innerHeight;
      camera.updateProjectionMatrix();
    };
    addEventListener('resize', resize, listenerOptions);
    resize();
    addEventListener(
      'pagehide',
      () => {
        keys.clear();
        connection.disconnect();
      },
      listenerOptions,
    );
    addEventListener(
      'pageshow',
      (event) => {
        if (event.persisted) {
          busy = false;
          keys.clear();
          prediction.clear();
          document.querySelector('#transition')?.remove();
          el('#scene').dataset.restored = 'true';
          void sdk
            .enterSession()
            .then(() => connection.connect())
            .catch(() => {
              el('#connection-state').textContent = 'Session ended · return Home to enter again';
            });
        }
      },
      listenerOptions,
    );
    let frameTime = performance.now(),
      time = 0,
      inputAccumulator = 0;
    const frameIntervals: number[] = [];
    let lastDiagnostic = 0;
    let jumpHeld = false;
    let viewOffset = 0;
    renderer.setAnimationLoop(() => {
      const frameNow = performance.now(),
        interval = frameNow - frameTime;
      frameTime = frameNow;
      quality.sample(interval);
      const delta = Math.min(interval / 1000, 0.05);
      if (hub.isPanelOpen() || document.querySelector('dialog[open]')) keys.clear();
      time += delta;
      frameIntervals.push(interval);
      if (frameIntervals.length > 12000) frameIntervals.splice(0, 1000);
      // Preserve elapsed movement time through slow frames, with bounded catch-up after a stall.
      inputAccumulator += Math.min(interval / 1000, 0.25);
      while (connection.state === 'ready' && !busy && inputAccumulator >= 0.05) {
        inputAccumulator -= 0.05;
        const x =
            Number(keys.has('d') || keys.has('arrowright')) - Number(keys.has('a') || keys.has('arrowleft')),
          z = Number(keys.has('s') || keys.has('arrowdown')) - Number(keys.has('w') || keys.has('arrowup')),
          frozen = definition.scene === 'race' && snapshot?.game.race.phase === 'countdown',
          jump = !frozen && keys.has(' ') && !jumpHeld;
        jumpHeld = keys.has(' ');
        const input = {
          type: 'input' as const,
          x: frozen ? 0 : x,
          z: frozen ? 0 : z,
          jump,
          run: keys.has('shift'),
          facing: x || z ? Math.atan2(x, z) : prediction.pose.facing,
        };
        const seq = connection.send(input);
        if (seq) prediction.advance({ ...input, seq }, 0.05);
      }
      if (connection.state !== 'ready' || busy) {
        inputAccumulator = 0;
        jumpHeld = false;
      }
      world.update(time);
      const doorTarget = snapshot?.game.switchOn ? -(doorBox?.height ?? 2.2) : (doorBox?.height ?? 2.2) / 2;
      door.position.y = reducedMotion.matches
        ? doorTarget
        : THREE.MathUtils.lerp(door.position.y, doorTarget, 1 - Math.exp(-delta * 6));
      const pose = prediction.sample(inputAccumulator / 0.05, delta);
      camera.position.lerp(
        new THREE.Vector3(pose.x + 5, pose.y + 5.7, pose.z + 11),
        1 - Math.exp(-delta * 4),
      );
      camera.lookAt(pose.x, 1.1, pose.z - 1);
      // On phones, compose the plaza into the space above the conversation sheet.
      const targetOffset = innerWidth <= 700 && hub.isSocialPanelOpen() ? innerHeight * 0.2 : 0;
      viewOffset = reducedMotion.matches
        ? targetOffset
        : THREE.MathUtils.lerp(viewOffset, targetOffset, 1 - Math.exp(-delta * 12));
      if (Math.abs(viewOffset - targetOffset) < 0.1) viewOffset = targetOffset;
      if (viewOffset) camera.setViewOffset(innerWidth, innerHeight, 0, viewOffset, innerWidth, innerHeight);
      else if (camera.view?.enabled) camera.clearViewOffset();
      camera.updateMatrixWorld();
      const nearestPortal = portalLabels.reduce<(typeof portalLabels)[number] | undefined>(
        (nearest, item) => {
          const distance = Math.hypot(pose.x - item.position.x, pose.z - item.position.z);
          if (distance > 4.5) return nearest;
          return !nearest || distance < Math.hypot(pose.x - nearest.position.x, pose.z - nearest.position.z)
            ? item
            : nearest;
        },
        undefined,
      );
      for (const entry of portalLabels) {
        const { label, position } = entry;
        const point = position.clone().project(camera);
        label.hidden =
          entry !== nearestPortal ||
          hub.isPanelOpen() ||
          busy ||
          point.z < -1 ||
          point.z > 1 ||
          Math.abs(point.x) > 0.8 ||
          Math.abs(point.y) > 0.8;
        label.style.left = `${(point.x * 0.5 + 0.5) * innerWidth}px`;
        label.style.top = `${(-point.y * 0.5 + 0.5) * innerHeight}px`;
      }
      for (const [id, actor] of actors) {
        const current =
          id === connection.actorId && selfPose
            ? { ...selfPose, ...pose }
            : buffers.get(id)?.at(Date.now() - serverOffset - 100);
        if (current) actor.update(current, delta, camera, innerWidth, innerHeight, Date.now() - serverOffset);
      }
      for (const [id, bubble] of speech) {
        const actor = actors.get(id);
        if (!actor || frameNow > bubble.expiresAt) {
          bubble.element.remove();
          speech.delete(id);
          continue;
        }
        if (bubble.element.parentElement !== actor.annotation) actor.annotation.append(bubble.element);
        bubble.element.hidden = busy;
      }
      el('#position-label').textContent = `Position ${pose.x.toFixed(1)}, ${pose.z.toFixed(1)}`;
      if (
        selfPose &&
        !busy &&
        !hub.isPanelOpen() &&
        !document.querySelector('dialog[open]') &&
        connection.state === 'ready'
      ) {
        const approaching = definition.portals.find(
          (p) => Math.hypot(selfPose!.x - p.position.x, selfPose!.z - p.position.z) < 3,
        );
        el('#portal-hint').textContent = approaching
          ? 'A new adventure is just a step away.'
          : 'Choose a world, or follow a glowing path.';
        const nearbyPortal = definition.portals.find(
          (p) => Math.hypot(selfPose!.x - p.position.x, selfPose!.z - p.position.z) < 1.05,
        );
        if (nearbyPortal) void travel(nearbyPortal.target);
      }
      renderer.render(world.scene, camera);
      if (frameNow - lastDiagnostic > 1000) {
        lastDiagnostic = frameNow;
        const recent = frameIntervals.slice(-240).sort((a, b) => a - b);
        el('#scene').dataset.render = JSON.stringify({
          calls: renderer.info.render.calls,
          triangles: renderer.info.render.triangles,
          geometries: renderer.info.memory.geometries,
          textures: renderer.info.memory.textures,
          frameP95Ms: recent[Math.max(0, Math.ceil(recent.length * 0.95) - 1)] ?? 0,
          cache: assetCacheMetrics(),
        });
      }
      el('#render-stats').textContent =
        `Scene: ${renderer.info.render.calls} calls · ${renderer.info.render.triangles.toLocaleString()} triangles · ${renderer.info.memory.geometries} geometries · ${renderer.info.memory.textures} textures`;
    });
    overlay('See you in a moment.', 'Finding your place in the world.');
    connection.connect();
    return {
      connection,
      renderer,
      actors,
      frameIntervals,
      world,
      quality,
      dispose() {
        lifecycle.abort();
        clearTimeout(transitionTimer);
        hub.dispose();
        quality.dispose();
        connection.dispose();
        renderer.setAnimationLoop(null);
        for (const actor of actors.values()) actor.dispose();
        actors.clear();
        appearances.clear();
        buffers.clear();
        speech.clear();
        const geometries = new Set<THREE.BufferGeometry>(),
          materials = new Set<THREE.Material>();
        world.scene.traverse((object) => {
          const mesh = object as THREE.Mesh;
          if ((object as THREE.InstancedMesh).isInstancedMesh) (object as THREE.InstancedMesh).dispose();
          if (mesh.isMesh || (object as THREE.Points).isPoints) {
            geometries.add(mesh.geometry);
            for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material])
              materials.add(material);
          }
          if ((object as THREE.Light).isLight)
            (object as THREE.Light & { shadow?: { dispose(): void } }).shadow?.dispose();
        });
        geometries.add(door.geometry);
        materials.add(door.material);
        for (const geometry of geometries) geometry.dispose();
        for (const material of materials) material.dispose();
        world.scene.clear();
        labels.remove();
        renderer.dispose();
        renderer.domElement.remove();
        el('#world-ui').replaceChildren();
        document.querySelector('#transition')?.remove();
      },
    };
  } catch (error) {
    overlay(
      'Let’s find your way back.',
      'Your collection is safe. ' + (error instanceof Error ? error.message : 'The world could not load.'),
    );
  }
}
