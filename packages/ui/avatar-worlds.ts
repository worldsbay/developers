import type { World } from '../core/contract.js';
import type { AvatarStyle } from '../wire/avatar-support.js';
import { escapeHtml as esc } from './dom.js';

export function avatarWorlds(worlds: World[], style: AvatarStyle) {
  const label = style === 'low-poly' ? 'Low poly' : 'Detailed';
  return `<section class="avatar-worlds" aria-label="World support for ${label}"><h3>Where this look works <span>${label}</span></h3><div class="avatar-world-list">${worlds
    .map((world) => {
      const supported = world.avatarSupport?.includes(style);
      const state = supported === undefined ? 'unknown' : supported ? 'supported' : 'unsupported';
      const message =
        supported === undefined
          ? 'Not specified'
          : supported
            ? 'Supported'
            : world.avatarSupport?.length === 0
              ? 'World avatar'
              : 'Other style only';
      const source =
        world.thumbnail && /^https?:\/\//.test(world.thumbnail)
          ? world.thumbnail
          : 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 88 56%22%3E%3Crect width=%2288%22 height=%2256%22 fill=%22%23edf2ff%22/%3E%3C/svg%3E';
      return `<div class="avatar-world" data-world-support="${state}" aria-label="${esc(world.name)}: ${message}"><div class="avatar-world-picture"><img ${`src="${esc(source)}"`} alt="" width="88" height="56" loading="lazy" referrerpolicy="no-referrer"><span class="avatar-world-mark" aria-hidden="true">${supported === undefined ? '?' : supported ? '✓' : '×'}</span></div><strong>${esc(world.name)}</strong><small>${message}</small></div>`;
    })
    .join(
      '',
    )}</div>${worlds.length ? '' : '<p>No connected worlds yet.</p>'}<p class="avatar-world-hint">✓ Accepts this style · × Uses another avatar · ? Support not specified</p></section>`;
}
