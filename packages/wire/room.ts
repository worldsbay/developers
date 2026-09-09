import { z } from 'zod';
import type { Appearance } from '../core/contract.js';
export const animationIds = ['idle', 'walk', 'run', 'jump', 'fall', 'land', 'wave', 'dance'] as const;
export type AnimationId = (typeof animationIds)[number];
const sequence = z.number().int().min(0).max(2_147_483_647);
export const chatTextSchema = z
  .string()
  .max(2048)
  .transform((text) =>
    text
      .replace(/[\p{Cc}\u200b\u200e\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim(),
  )
  .pipe(
    z
      .string()
      .min(1)
      .max(280)
      .regex(/[\p{L}\p{N}\p{P}\p{S}]/u),
  );
export const intentSchema = z
  .object({
    type: z.literal('input'),
    seq: sequence,
    x: z.number().finite().min(-1).max(1),
    z: z.number().finite().min(-1).max(1),
    facing: z.number().finite().min(-Math.PI).max(Math.PI),
    jump: z.boolean(),
    run: z.boolean(),
  })
  .strict();
export const clientMessageSchema = z.discriminatedUnion('type', [
  intentSchema,
  z.object({ type: z.literal('chat'), seq: sequence, text: chatTextSchema }).strict(),
  z.object({ type: z.literal('emote'), seq: sequence, id: z.enum(['wave', 'dance']) }).strict(),
  z
    .object({
      type: z.literal('interact'),
      seq: sequence,
      id: z.enum(['showroom-switch', 'race-ready', 'respawn', 'race-reset']),
    })
    .strict(),
  z
    .object({ type: z.literal('diagnostic'), seq: sequence, stage: z.enum(['scene-ready', 'room-joined']) })
    .strict(),
]);
export type InputIntent = z.infer<typeof intentSchema>;
export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type Motion = {
  x: number;
  y: number;
  z: number;
  vy: number;
  facing: number;
  grounded: boolean;
  locomotion: AnimationId;
};
export type Pose = Motion & {
  id: string;
  name: string;
  color: string;
  ack: number;
  revision: number;
  emote: { id: 'wave' | 'dance'; startedAt: number; endsAt: number } | null;
};
export type RaceState = {
  round: number;
  phase: 'lobby' | 'countdown' | 'running' | 'results' | 'reset';
  startedAt: number;
  phaseEndsAt: number;
  ready: string[];
  checkpoints: { x: number; y: number; z: number }[];
  racers: Record<string, { checkpoint: number; finishedMs: number | null; dnf: boolean }>;
};
export type GameState = { switchOn: boolean; race: RaceState };
export type RoomSnapshot = { type: 'snapshot'; tick: number; time: number; actors: Pose[]; game: GameState };
export type ChatMessage = {
  id: string;
  actorId: string;
  name: string;
  color: string;
  text: string;
  time: number;
};
export type ChatError = { code: string; message: string; retryAfterMs?: number };
export type RoomMessage =
  | RoomSnapshot
  | {
      type: 'welcome';
      actorId: string;
      generation: number;
      time: number;
      expiresAt: number;
      appearances: Record<string, Appearance>;
      snapshot: RoomSnapshot;
      chatHistory: ChatMessage[];
    }
  | { type: 'chat'; message: ChatMessage }
  | ({ type: 'chat-error' } & ChatError)
  | { type: 'appearance'; actorId: string; appearance: Appearance }
  | { type: 'error'; code: string; message: string }
  | { type: 'central'; available: boolean };
export type ConnectionState =
  | 'handshaking'
  | 'appearance-loading'
  | 'asset-loading'
  | 'connecting'
  | 'ready'
  | 'reconnecting'
  | 'offline'
  | 'expired';
export const neutralInput = (): InputIntent => ({
  type: 'input',
  seq: 0,
  x: 0,
  z: 0,
  facing: 0,
  jump: false,
  run: false,
});
