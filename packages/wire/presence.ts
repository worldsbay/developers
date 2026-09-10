import { z } from 'zod';
import { portalTargetSchema } from './world-metadata.js';

export const WORLD_HEARTBEAT_MS = 10_000;
export const WORLD_OFFLINE_MS = 35_000;
export const WORLD_CONNECTING_MS = 60_000;
export const worldHeartbeatSchema = z
  .object({
    online: z.boolean(),
    connectedPlayers: z.number().int().min(0).max(100_000),
    connectingPlayers: z.number().int().min(0).max(100_000),
    maxPlayers: z.number().int().min(1).max(100_000),
    ports: z
      .array(
        z
          .object({
            protocol: z.enum(['http', 'https', 'ws', 'wss']),
            port: z.number().int().min(1).max(65535),
          })
          .strict(),
      )
      .max(8),
    portals: z.array(portalTargetSchema).max(64),
  })
  .strict()
  .refine(
    (value) => value.online || (value.connectedPlayers === 0 && value.connectingPlayers === 0),
    'Offline worlds cannot report active players.',
  );
export type WorldHeartbeat = z.infer<typeof worldHeartbeatSchema>;
export type WorldDirectoryEntry = {
  id: string;
  name: string;
  description: string;
  url: string;
  thumbnail: string;
  tags?: string[];
  group?: string;
  online: boolean;
  lastSeenAt: number | null;
  connectedPlayers: number;
  connectingPlayers: number;
  activePlayers: number;
  maxPlayers: number | null;
  full: boolean;
  ports: WorldHeartbeat['ports'];
  portals: string[];
};
export type WorldDirectory = {
  worlds: WorldDirectoryEntry[];
  updatedAt: number;
  offlineAfterMs: number;
};
