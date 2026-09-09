import type { World } from './contract.js';

/** Configuration needed by an independent world; player accounts remain at WorldsBay. */
export interface Config {
  centralUrl: string;
  worlds: World[];
  worldSecrets: Record<string, string>;
  production: boolean;
  trustProxy: string[];
  assetPath: string;
  clientPath: string;
}
