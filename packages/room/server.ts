import { randomUUID } from 'node:crypto';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { WebSocket, WebSocketServer } from 'ws';
import type { FastifyInstance } from 'fastify';
import type { IncomingMessage } from 'node:http';
import type { Appearance } from '../core/contract.js';
import type { WorldDefinition } from '../wire/world.js';
import {
  clientMessageSchema,
  neutralInput,
  type InputIntent,
  type Pose,
  type RaceState,
  type RoomSnapshot,
  type RoomMessage,
  type ChatMessage,
  type ChatError,
} from '../wire/room.js';
import { spawnMotion, stepMotion } from '../simulation/movement.js';

export type Admission = { playerId: string; grant: string; expiresAt: number; appearance: Appearance };
type Actor = {
  id: string;
  playerId: string;
  generation: number;
  socket: WebSocket;
  grant: string;
  expiresAt: number;
  appearance: Appearance;
  pose: Pose;
  input: InputIntent;
  lastInputAt: number;
  lastPong: number;
  seq: number;
  rateStart: number;
  rateCount: number;
  frameStart: number;
  frameCount: number;
  frameBytes: number;
  lastEmote: number;
  lastChatErrorAt: number;
  diagnostics: Set<string>;
};
export class WorldRoom {
  readonly actors = new Map<string, Actor>();
  readonly metrics = {
    joins: 0,
    leaves: 0,
    replacements: 0,
    rejectedMessages: 0,
    messagesIn: 0,
    messagesOut: 0,
    bytesIn: 0,
    bytesOut: 0,
    sceneReady: 0,
    roomJoined: 0,
    steps: [] as number[],
    simulationSteps: 0,
    peakActors: 0,
  };
  private nextGeneration = 0;
  private tick = 0;
  private switchOn = false;
  private lastAt: number;
  private accumulated = 0;
  private stepsSinceSnapshot = 0;
  private chatHistory: ChatMessage[] = [];
  // Keep limits against the authenticated player through socket replacements and reconnects.
  private chatLimits = new Map<string, { nextAt: number; windowStart: number; count: number }>();
  private lastChatCleanup = 0;
  private race: RaceState = {
    round: 1,
    phase: 'lobby',
    startedAt: 0,
    phaseEndsAt: 0,
    ready: [],
    checkpoints: [
      { x: 0, y: 0, z: -1 },
      { x: -4, y: 0, z: -3 },
      { x: 4, y: 0, z: -5 },
      { x: 0, y: 0, z: -8 },
    ],
    racers: {},
  };
  constructor(
    readonly definition: WorldDefinition,
    private now: () => number = Date.now,
    readonly tickHz = 20,
    readonly snapshotHz = 10,
  ) {
    this.lastAt = now();
  }
  /** Apply an explicitly requested canonical update; rooms never poll central. */
  updateAppearance(grant: string, appearance: Appearance) {
    for (const actor of this.actors.values()) {
      if (actor.grant !== grant || actor.expiresAt <= this.now() ||
          (appearance.revision ?? 1) <= (actor.appearance.revision ?? 1)) continue;
      actor.appearance = appearance;
      actor.pose.revision = appearance.revision ?? 1;
      actor.pose.color = appearance.player.color;
      actor.pose.name = appearance.player.name;
      this.broadcast({ type: 'appearance', actorId: actor.id, appearance: this.publicAppearance(actor) });
    }
  }
  admit(socket: WebSocket, identity: Admission) {
    if (identity.expiresAt <= this.now()) {
      socket.close(4003, 'Session expired');
      return;
    }
    const previous = this.actors.get(identity.playerId);
    if (!previous && this.actors.size >= this.definition.roomLimit) {
      socket.close(4004, 'Room is full');
      return;
    }
    const generation = ++this.nextGeneration;
    const id = previous?.id ?? randomUUID();
    let spawn = { ...this.definition.spawn };
    if (!previous || previous.grant !== identity.grant) {
      const offsets = [
        [0, 0],
        [0, 1.2],
        [-1.2, 0],
        [1.2, 0],
        [-1.2, 1.2],
        [1.2, 1.2],
        [0, 2.4],
        [-2.4, 0],
        [2.4, 0],
        [-2.4, 1.2],
        [2.4, 1.2],
        [-1.2, 2.4],
        [1.2, 2.4],
        [-2.4, 2.4],
        [2.4, 2.4],
        [0, 3.6],
      ];
      const available = offsets
        .map(([x, z]) => ({ ...spawn, x: spawn.x + x, z: spawn.z + z }))
        .find(
          (candidate) =>
            candidate.x >= this.definition.bounds.minX &&
            candidate.x <= this.definition.bounds.maxX &&
            candidate.z >= this.definition.bounds.minZ &&
            candidate.z <= this.definition.bounds.maxZ &&
            !this.definition.collisions.some(
              (box) =>
                candidate.y < box.height &&
                candidate.x + 0.3 > box.minX &&
                candidate.x - 0.3 < box.maxX &&
                candidate.z + 0.3 > box.minZ &&
                candidate.z - 0.3 < box.maxZ,
            ) &&
            [...this.actors.values()].every(
              (actor) =>
                actor === previous ||
                Math.hypot(actor.pose.x - candidate.x, actor.pose.z - candidate.z) >= 1.1,
            ),
        );
      if (available) spawn = available;
    }
    const actor: Actor = {
      ...identity,
      id,
      socket,
      generation,
      pose: {
        ...spawnMotion(spawn),
        id,
        name: identity.appearance.player.name,
        color: identity.appearance.player.color,
        ack: 0,
        revision: identity.appearance.revision ?? 1,
        emote: null,
      },
      input: neutralInput(),
      lastInputAt: 0,
      lastPong: this.now(),
      seq: 0,
      rateStart: this.now(),
      rateCount: 0,
      frameStart: this.now(),
      frameCount: 0,
      frameBytes: 0,
      lastEmote: 0,
      lastChatErrorAt: -Infinity,
      diagnostics: new Set(),
    };
    if (previous) {
      if ((previous.appearance.revision ?? 1) > (actor.appearance.revision ?? 1))
        actor.appearance = previous.appearance;
      if (previous.grant === identity.grant) actor.pose = { ...previous.pose, ack: 0 };
      actor.pose.revision = actor.appearance.revision ?? 1;
      this.metrics.replacements++;
      previous.socket.close(4001, 'A newer connection replaced this one');
    }
    this.actors.set(identity.playerId, actor);
    this.metrics.joins++;
    this.metrics.peakActors = Math.max(this.metrics.peakActors, this.actors.size);
    socket.on('pong', () => {
      if (this.current(actor)) actor.lastPong = this.now();
    });
    socket.on('message', (data, isBinary) => {
      if (!this.current(actor)) return;
      this.receive(actor, data.toString(), isBinary);
    });
    socket.on('close', () => {
      if (!this.current(actor)) return;
      this.actors.delete(actor.playerId);
      this.metrics.leaves++;
      this.race.ready = this.race.ready.filter((id) => id !== actor.id);
      if (this.race.racers[actor.id]) this.race.racers[actor.id].dnf = true;
      this.broadcast(this.snapshot());
    });
    socket.on('error', () => socket.terminate());
    this.send(actor, {
      type: 'welcome',
      actorId: id,
      generation,
      time: this.now(),
      expiresAt: identity.expiresAt,
      appearances: Object.fromEntries([...this.actors.values()].map((a) => [a.id, this.publicAppearance(a)])),
      snapshot: this.snapshot(),
      chatHistory: [...this.chatHistory],
    });
    this.broadcast({ type: 'appearance', actorId: id, appearance: this.publicAppearance(actor) });
    this.broadcast(this.snapshot());
  }
  private current(actor: Actor) {
    return this.actors.get(actor.playerId)?.generation === actor.generation;
  }
  private publicAppearance(actor: Actor): Appearance {
    return { ...actor.appearance, player: { ...actor.appearance.player, id: actor.id } };
  }
  private send(actor: Actor, message: RoomMessage) {
    if (actor.socket.readyState !== WebSocket.OPEN) return;
    if (actor.socket.bufferedAmount > 256 * 1024) {
      actor.socket.close(4008, 'Slow receiver');
      return;
    }
    const json = JSON.stringify(message);
    this.metrics.messagesOut++;
    this.metrics.bytesOut += Buffer.byteLength(json);
    actor.socket.send(json);
  }
  private broadcast(message: RoomMessage) {
    for (const actor of this.actors.values()) this.send(actor, message);
  }
  private receive(actor: Actor, raw: string, binary: boolean) {
    if (actor.socket.readyState !== WebSocket.OPEN) return;
    const bytes = Buffer.byteLength(raw);
    this.metrics.messagesIn++;
    this.metrics.bytesIn += bytes;
    if (this.now() >= actor.expiresAt) {
      actor.socket.close(4003, 'Session expired');
      return;
    }
    // Every frame consumes this budget before JSON parsing, including malformed
    // chat. Chat retains its separate pacing and movement allowance below.
    if (this.now() - actor.frameStart >= 1000) {
      actor.frameStart = this.now();
      actor.frameCount = 0;
      actor.frameBytes = 0;
    }
    actor.frameCount++;
    actor.frameBytes += bytes;
    if (bytes > 2048 || binary || actor.frameCount > 60 || actor.frameBytes > 32 * 1024) {
      this.metrics.rejectedMessages++;
      actor.socket.close(4008, 'Input rate or size exceeded');
      return;
    }
    let parsed: ReturnType<typeof clientMessageSchema.safeParse>;
    let isChat = false;
    try {
      const value: unknown = JSON.parse(raw);
      isChat = typeof value === 'object' && value !== null && 'type' in value && value.type === 'chat';
      parsed = clientMessageSchema.safeParse(value);
    } catch {
      parsed = { success: false } as ReturnType<typeof clientMessageSchema.safeParse>;
    }
    // Typing in chat must not consume the movement/action packet allowance.
    if (!isChat) {
      if (this.now() - actor.rateStart >= 1000) {
        actor.rateStart = this.now();
        actor.rateCount = 0;
      }
      if (++actor.rateCount > 45) {
        this.metrics.rejectedMessages++;
        actor.socket.close(4008, 'Input rate or size exceeded');
        return;
      }
    }
    if (!parsed.success) {
      this.metrics.rejectedMessages++;
      if (isChat) {
        this.chatError(actor, { code: 'INVALID_CHAT', message: 'Write a message of 1–280 characters.' });
        return;
      }
      this.send(actor, {
        type: 'error',
        code: 'INVALID_INPUT',
        message: 'Only bounded input intent and approved actions are accepted.',
      });
      return;
    }
    const message = parsed.data;
    if (message.seq <= actor.seq || message.seq > actor.seq + 120) {
      this.metrics.rejectedMessages++;
      return;
    }
    actor.seq = message.seq;
    if (message.type === 'chat') this.chat(actor, message.text);
    if (message.type === 'input') {
      actor.input = message;
      actor.lastInputAt = this.now();
    }
    if (message.type === 'emote') {
      if (this.now() - actor.lastEmote < 1000) return;
      actor.lastEmote = this.now();
      actor.pose.emote = {
        id: message.id,
        startedAt: this.now(),
        endsAt: this.now() + (message.id === 'wave' ? 2400 : 4000),
      };
    }
    if (message.type === 'diagnostic') {
      if (actor.diagnostics.has(message.stage)) return;
      actor.diagnostics.add(message.stage);
      if (message.stage === 'scene-ready') this.metrics.sceneReady++;
      else this.metrics.roomJoined++;
    }
    if (message.type === 'interact') this.interact(actor, message.id);
  }
  private chatError(actor: Actor, error: ChatError) {
    // Bound error traffic as well as successful chat broadcasts.
    if (this.now() - actor.lastChatErrorAt < 1000) return;
    actor.lastChatErrorAt = this.now();
    this.send(actor, { type: 'chat-error', ...error });
  }
  private chat(actor: Actor, text: string) {
    const now = this.now();
    let limit = this.chatLimits.get(actor.playerId);
    if (!limit || now - limit.windowStart >= 30000) {
      limit = { nextAt: limit?.nextAt ?? 0, windowStart: now, count: 0 };
      this.chatLimits.set(actor.playerId, limit);
    }
    const retryAfterMs = Math.max(limit.nextAt, limit.count >= 10 ? limit.windowStart + 30000 : 0) - now;
    if (retryAfterMs > 0) {
      this.metrics.rejectedMessages++;
      this.chatError(actor, {
        code: 'CHAT_RATE_LIMIT',
        message: 'Give others a moment. You can send another message shortly.',
        retryAfterMs,
      });
      return;
    }
    limit.nextAt = now + 1200;
    limit.count++;
    const message: ChatMessage = {
      id: randomUUID(),
      actorId: actor.id,
      name: actor.appearance.player.name,
      color: actor.appearance.player.color,
      text,
      time: now,
    };
    this.chatHistory.push(message);
    if (this.chatHistory.length > 50) this.chatHistory.shift();
    this.broadcast({ type: 'chat', message });
  }
  private interact(actor: Actor, id: string) {
    if (id === 'respawn') {
      const racer = this.race.racers[actor.id];
      const position =
        racer && racer.checkpoint > 0 ? this.race.checkpoints[racer.checkpoint - 1] : this.definition.spawn;
      Object.assign(actor.pose, spawnMotion(position));
      actor.input = neutralInput();
      return;
    }
    if (id === 'race-reset') {
      if (this.race.phase === 'results') {
        this.race.phase = 'reset';
        this.race.phaseEndsAt = this.now() + 1000;
      }
      return;
    }
    const target = this.definition.interactions.find((i) => i.id === id);
    if (
      !target ||
      Math.hypot(actor.pose.x - target.position.x, actor.pose.z - target.position.z) > target.radius
    )
      return;
    if (target.kind === 'switch') {
      this.switchOn = !this.switchOn;
      this.broadcast(this.snapshot());
    }
    if (target.kind === 'race-ready' && this.race.phase === 'lobby') {
      if (!this.race.ready.includes(actor.id)) this.race.ready.push(actor.id);
      if (this.race.ready.length === this.actors.size) {
        this.race.phase = 'countdown';
        this.race.phaseEndsAt = this.now() + 3000;
        this.race.racers = Object.fromEntries(
          [...this.actors.values()].map((a) => [a.id, { checkpoint: 0, finishedMs: null, dnf: false }]),
        );
        for (const a of this.actors.values()) Object.assign(a.pose, spawnMotion(this.definition.spawn));
      }
      this.broadcast(this.snapshot());
    }
  }
  snapshot(): RoomSnapshot {
    return {
      type: 'snapshot',
      tick: this.tick,
      time: this.now(),
      actors: [...this.actors.values()].map((a) => ({ ...a.pose })),
      game: { switchOn: this.switchOn, race: structuredClone(this.race) },
    };
  }
  advance() {
    const at = this.now(),
      elapsed = Math.max(0, Math.min(at - this.lastAt, 250));
    this.lastAt = at;
    this.accumulated += elapsed;
    if (at - this.lastChatCleanup >= 30000) {
      this.lastChatCleanup = at;
      for (const [playerId, limit] of this.chatLimits)
        if (at >= Math.max(limit.nextAt, limit.windowStart + 30000)) this.chatLimits.delete(playerId);
    }
    const stepMs = 1000 / this.tickHz;
    let work = 0;
    while (this.accumulated >= stepMs && work++ < 5) {
      const started = performance.now();
      this.step(stepMs / 1000);
      this.accumulated -= stepMs;
      this.metrics.steps.push(performance.now() - started);
      this.metrics.simulationSteps++;
      if (this.metrics.steps.length > 12000) this.metrics.steps.splice(0, 1000);
    }
    for (const actor of this.actors.values()) {
      if (at >= actor.expiresAt) {
        actor.socket.close(4003, 'Session expired');
        continue;
      }
      if (at - actor.lastPong > 30000) {
        actor.socket.terminate();
        continue;
      }

    }
  }
  private step(dt: number) {
    this.tick++;
    const now = this.now();
    if (this.race.phase === 'countdown' && now >= this.race.phaseEndsAt) {
      this.race.phase = 'running';
      this.race.startedAt = now;
      this.race.phaseEndsAt = now + 90000;
    }
    if (this.race.phase === 'results' && now >= this.race.phaseEndsAt) {
      this.race.phase = 'reset';
      this.race.phaseEndsAt = now + 1000;
    }
    if (this.race.phase === 'reset' && now >= this.race.phaseEndsAt) {
      this.race = {
        ...this.race,
        round: this.race.round + 1,
        phase: 'lobby',
        ready: [],
        racers: {},
        startedAt: 0,
        phaseEndsAt: 0,
      };
    }
    for (const actor of this.actors.values()) {
      if (now >= actor.expiresAt) continue;
      const frozen = this.definition.scene === 'race' && this.race.phase === 'countdown';
      const input = now - actor.lastInputAt > 500 || frozen ? neutralInput() : actor.input;
      const definition = this.switchOn
        ? {
            ...this.definition,
            collisions: this.definition.collisions.filter((c) => c.id !== 'showroom-door'),
          }
        : this.definition;
      Object.assign(actor.pose, stepMotion(actor.pose, input, dt, definition), { ack: actor.seq });
      actor.input.jump = false;
      if (actor.pose.emote && actor.pose.emote.endsAt <= now) actor.pose.emote = null;
      const racer = this.race.racers[actor.id];
      if (this.race.phase === 'running' && racer && !racer.dnf && racer.finishedMs === null) {
        const checkpoint = this.race.checkpoints[racer.checkpoint];
        if (
          checkpoint &&
          Math.hypot(actor.pose.x - checkpoint.x, actor.pose.z - checkpoint.z) < 1 &&
          actor.pose.y < 1.2
        ) {
          racer.checkpoint++;
          if (racer.checkpoint === this.race.checkpoints.length) racer.finishedMs = now - this.race.startedAt;
        }
      }
    }
    if (
      this.race.phase === 'running' &&
      (now >= this.race.phaseEndsAt ||
        Object.values(this.race.racers).every((r) => r.dnf || r.finishedMs !== null))
    ) {
      this.race.phase = 'results';
      this.race.phaseEndsAt = now + 10000;
      for (const r of Object.values(this.race.racers)) if (r.finishedMs === null) r.dnf = true;
    }
    if (++this.stepsSinceSnapshot >= this.tickHz / this.snapshotHz) {
      this.stepsSinceSnapshot = 0;
      this.broadcast(this.snapshot());
    }
  }
  heartbeat() {
    for (const actor of this.actors.values())
      if (actor.socket.readyState === WebSocket.OPEN) actor.socket.ping();
  }
  close() {
    for (const actor of this.actors.values()) actor.socket.close(4002, 'World restarted');
    this.actors.clear();
    this.chatHistory = [];
    this.chatLimits.clear();
  }
}
export function installRoom(
  app: FastifyInstance,
  options: {
    origin: string | (() => string);
    definition: WorldDefinition;
    admit: (req: IncomingMessage) => Promise<Admission>;
    now?: () => number;
    tickHz?: number;
  },
) {
  const room = new WorldRoom(
    options.definition,
    options.now ?? Date.now,
    options.tickHz ?? 20,
    10,
  );
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2048, perMessageDeflate: false });
  let pending = 0;
  const upgrade = (req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => {
    if (
      req.url !== '/room' ||
      req.headers.origin !== (typeof options.origin === 'function' ? options.origin() : options.origin) ||
      pending >= 32
    ) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    pending++;
    socket.on('error', () => socket.destroy());
    void options
      .admit(req)
      .then((identity) => {
        if (!socket.destroyed) wss.handleUpgrade(req, socket, head, (ws) => room.admit(ws, identity));
      })
      .catch(() => {
        if (!socket.destroyed) socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      })
      .finally(() => {
        pending--;
      });
  };
  app.server.on('upgrade', upgrade);
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  const timer = setInterval(() => room.advance(), 1000 / (options.tickHz ?? 20)).unref();
  const heartbeat = setInterval(() => room.heartbeat(), 10000).unref();
  app.addHook('preClose', async () => {
    clearInterval(timer);
    clearInterval(heartbeat);
    loop.disable();
    room.close();
    app.server.off('upgrade', upgrade);
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });
  return {
    room,
    diagnostics: () => ({
      ...room.metrics,
      actors: room.actors.size,
      pending,
      eventLoopP95Ms: loop.percentile(95) / 1e6,
    }),
  };
}
