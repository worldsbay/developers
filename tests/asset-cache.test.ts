import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorldAssetCache } from '../apps/world/asset-cache.js';
import type { Appearance } from '../packages/core/contract.js';
import { PROFILE } from '../packages/core/profile.js';

const bytes = Buffer.from('synthetic, approved avatar test bytes');
const hash = createHash('sha256').update(bytes).digest('hex');
const key = `${hash}.glb`;
const avatar: Appearance = {
  player: { id: 'test-player', name: 'Test player', color: '#336699' },
  profile: PROFILE,
  bodyAsset: `https://central.example/assets/versions/${key}`,
  animations: ['idle'],
  equipped: [],
};

test('a missing local asset directory falls back to approved central assets and deduplicates verified downloads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'worldsbay-assets-'));
  let downloads = 0;
  const fetcher: typeof fetch = async (url, options) => {
    downloads++;
    assert.equal(url, avatar.bodyAsset);
    assert.equal(options?.redirect, 'error');
    return new Response(bytes);
  };
  const cache = new WorldAssetCache(
    'https://central.example',
    'https://world.example',
    fetcher,
    join(directory, 'missing'),
  );
  try {
    assert.equal(cache.appearance(avatar).bodyAsset, `https://world.example/avatar-assets/${key}`);
    const results = await Promise.all([cache.get(key), cache.get(key)]);
    assert.deepEqual(results, [bytes, bytes]);
    assert.deepEqual(await cache.get(key), bytes);
    assert.equal(downloads, 1);
    await assert.rejects(cache.get(`${'0'.repeat(64)}.glb`), { statusCode: 404 });
    for (const bodyAsset of [
      'http://169.254.169.254/latest/meta-data',
      `https://unapproved.example/assets/versions/${key}`,
      `${avatar.bodyAsset}?unapproved=1`,
      `${avatar.bodyAsset}#unapproved`,
    ])
      assert.throws(() => cache.appearance({ ...avatar, bodyAsset }), { statusCode: 502 });
    assert.equal(downloads, 1);
    cache.clear();
    await assert.rejects(cache.get(key), { statusCode: 404 });
  } finally {
    cache.clear();
    await rmdir(directory);
  }
});

test('downloaded or bundled bytes with the wrong content hash are rejected', async () => {
  const downloaded = new WorldAssetCache(
    'https://central.example',
    'https://world.example',
    async () => new Response('tampered bytes'),
  );
  downloaded.appearance(avatar);
  await assert.rejects(downloaded.get(key), { statusCode: 502 });
  const directory = await mkdtemp(join(tmpdir(), 'worldsbay-assets-'));
  const filename = join(directory, key);
  let remoteCalls = 0;
  const bundled = new WorldAssetCache(
    'https://central.example',
    'https://world.example',
    async () => {
      remoteCalls++;
      return new Response(bytes);
    },
    directory,
  );
  try {
    await writeFile(filename, 'tampered local bytes');
    bundled.appearance(avatar);
    await assert.rejects(bundled.get(key), { statusCode: 502 });
    assert.equal(remoteCalls, 0, 'Integrity failures must not be hidden by a network fallback');
  } finally {
    await unlink(filename);
    await rmdir(directory);
  }
});
