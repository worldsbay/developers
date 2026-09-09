import type { Appearance } from '../../packages/core/contract.js';
import { createHash } from 'node:crypto';
import { HttpError } from '../../packages/core/http.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Only assets named in central-authorized appearances enter this bounded cache. */
export class WorldAssetCache {
  private allowed = new Map<string, string>();
  private cache = new Map<string, Buffer>();
  private pending = new Map<string, Promise<Buffer>>();
  private bytes = 0;
  constructor(
    private centralUrl: string,
    private worldUrl: string,
    private read: typeof fetch = fetch,
    private bundledAssetRoot?: string,
  ) {}
  appearance(value: Appearance): Appearance {
    const rewrite = (url: string) => {
      const source = new URL(url);
      const match = /^\/assets\/versions\/([a-f0-9]{64}\.glb)$/.exec(source.pathname);
      if (source.origin !== this.centralUrl || !match || source.search || source.hash)
        throw new HttpError(502, 'Central returned an unsupported avatar asset.');
      const key = match[1];
      if (!this.allowed.has(key) && this.allowed.size >= 256) {
        const expired = this.allowed.keys().next().value!;
        this.allowed.delete(expired);
      }
      this.allowed.set(key, source.href);
      return `${this.worldUrl}/avatar-assets/${key}`;
    };
    return {
      ...value,
      bodyAsset: rewrite(value.bodyAsset),
      equipped: value.equipped.map((item) => ({ ...item, assetUrl: rewrite(item.assetUrl) })),
      ...(value.character
        ? {
            character: {
              ...value.character,
              rig: { ...value.character.rig, url: rewrite(value.character.rig.url!) },
              defaultAnimations: {
                ...value.character.defaultAnimations,
                url: rewrite(value.character.defaultAnimations.url!),
              },
              parts: value.character.parts.map((part) => ({
                ...part,
                asset: { ...part.asset, url: rewrite(part.asset.url!) },
              })),
            },
          }
        : {}),
    };
  }
  async get(key: string) {
    const url = this.allowed.get(key);
    if (!url) throw new HttpError(404, 'Avatar revision not found in this world.');
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }
    let pending = this.pending.get(key);
    if (pending) return pending;
    if (this.pending.size >= 4) throw new HttpError(503, 'Avatar downloads are busy. Please retry.');
    pending = this.download(key, url);
    this.pending.set(key, pending);
    try {
      return await pending;
    } finally {
      this.pending.delete(key);
    }
  }
  private async download(key: string, url: string) {
    if (this.bundledAssetRoot) {
      try {
        // key was admitted from the authority and matched the exact hash.glb pattern.
        const bundled = await readFile(resolve(this.bundledAssetRoot, key));
        if (createHash('sha256').update(bundled).digest('hex') !== key.slice(0, 64))
          throw new HttpError(502, 'Bundled character integrity verification failed.');
        return bundled;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    const response = await this.read(url, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (!response.ok || !response.body) throw new HttpError(502, 'Avatar download failed.');
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 16 * 1024 * 1024) {
          await reader.cancel();
          throw new HttpError(502, 'Avatar exceeds the download budget.');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const data = Buffer.concat(chunks);
    if (createHash('sha256').update(data).digest('hex') !== key.slice(0, 64))
      throw new HttpError(502, 'Avatar integrity verification failed.');
    while (this.cache.size && (this.bytes + size > 32 * 1024 * 1024 || this.cache.size >= 16)) {
      const old = this.cache.keys().next().value!;
      this.bytes -= this.cache.get(old)!.length;
      this.cache.delete(old);
    }
    this.cache.set(key, data);
    this.bytes += size;
    return data;
  }
  clear() {
    this.allowed.clear();
    this.cache.clear();
    this.bytes = 0;
  }
}
