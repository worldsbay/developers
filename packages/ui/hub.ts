import type { World } from '../core/contract.js';
import type { RoomConnection } from '@worldsbay/api/room';
import type { ChatMessage, ConnectionState, Pose } from '../wire/room.js';
import { brandMark } from './brand.js';
import { escapeHtml as esc } from './dom.js';
import './hub.css';

type QualityMode = 'auto' | 'low' | 'medium' | 'high';
type QualityTier = Exclude<QualityMode, 'auto'>;
type Panel = 'chat' | 'people' | 'worlds' | 'settings' | 'character';
const paths = {
  chat: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z"/><path d="M8 11h8M8 15h5"/>',
  people:
    '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M17 5a3 3 0 0 1 0 6M21 21v-3a6 6 0 0 0-3-5"/>',
  worlds:
    '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18M5 6.5h14M5 17.5h14"/>',
  settings:
    '<path d="m9 3-.7 2.1-2 .9-2-.4-2 3.5 1.5 1.5v2.8l-1.5 1.5 2 3.5 2-.4 2 .9L9 21h4l.7-2.1 2-.9 2 .4 2-3.5-1.5-1.5v-2.8l1.5-1.5-2-3.5-2 .4-2-.9L13 3Z"/><circle cx="11" cy="12" r="3"/>',
  character: '<circle cx="12" cy="7" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
  wave: '<path d="M8 13V6a1.5 1.5 0 0 1 3 0v6-8a1.5 1.5 0 0 1 3 0v8-6a1.5 1.5 0 0 1 3 0v7-4a1.5 1.5 0 0 1 3 0v6a7 7 0 0 1-13 4l-4-5a1.5 1.5 0 0 1 2-2l3 2M3 6l-1-2M20 3l1-2"/>',
  dance: '<circle cx="14" cy="4" r="2"/><path d="m4 8 5 2 4-3 4 4 4-2M12 8l-3 7-5 4M9 15l7 1 2 5"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  sparkle: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z"/>',
  send: '<path d="m22 2-7 20-4-9L2 9 22 2ZM11 13 22 2"/>',
};
const icon = (name: keyof typeof paths) =>
  `<svg class="hub-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
const color = (value: string) => (/^#[0-9a-f]{6}$/i.test(value) ? value : '#c6f5a1');
const panelHead = (name: Panel, title: string, eyebrow: string) =>
  `<header class="hub-panel-head"><div><p class="hub-eyebrow">${eyebrow}</p><h2 id="hub-${name}-title">${title}</h2></div><button class="hub-icon-button" data-close-panel aria-label="Close ${name}">${icon('close')}</button></header>`;
const dockButton = (name: Panel, title: string) =>
  `<button class="hub-dock-button" data-panel="${name}" aria-label="${title}" aria-expanded="false" aria-controls="hub-panel-${name}">${icon(name)}<span>${title}</span>${name === 'chat' ? '<span class="hub-unread" id="chat-unread" hidden></span>' : ''}</button>`;

export function hubMarkup(options: {
  homeUrl: string;
  worldName: string;
  playerName: string;
  isRace: boolean;
  destinations: World[];
}) {
  const { homeUrl, worldName, playerName, isRace, destinations } = options;
  const initial = destinations[0];
  const activity = `<div class="hub-activity"><p class="hub-eyebrow">${isRace ? 'Meet at the starting line' : 'Around the plaza'}</p><h3>${isRace ? 'Checkpoint race' : 'The showroom'}</h3><p id="game-state">${isRace ? 'Meet at the gold start marker.' : 'Discover the collection and explore together.'}</p><div class="hub-button-row"><button id="shared-interact">${isRace ? 'Ready to race' : 'Toggle showroom door'}</button><button id="inspect-display" aria-label="Inspect shop display">Browse display</button></div><div id="race-results" role="status"></div></div>`;
  return `<div class="hub-shell" data-open-panel="" data-connection="connecting">
    <header class="hub-topbar">
      <section class="hub-location" aria-label="Current world">
        <button type="button" class="hub-home" data-panel="settings" aria-label="World menu" aria-expanded="false" aria-controls="hub-panel-settings">${brandMark}</button>
        <div class="hub-location-copy"><p class="hub-eyebrow">WORLDSBAY <span>/</span> LIVE TOGETHER</p><h1>${esc(worldName)}</h1><div class="hub-presence"><span class="hub-status-dot" aria-hidden="true"></span><span id="room-count">Joining the room</span><span class="hub-location-divider">·</span><span id="connection-state" role="status">Connecting…</span></div></div>
      </section>
      <div class="hub-account"><button class="hub-player" data-panel="character" aria-expanded="false" aria-controls="hub-panel-character" aria-label="Your character"><span class="hub-avatar" aria-hidden="true">${esc(playerName.slice(0, 1).toUpperCase())}</span><span><strong id="player-name">${esc(playerName)}</strong><span class="hub-player-subtitle">Your character and account</span></span></button><button id="hub-save-account" class="hub-save-account">Save account</button><button class="hub-icon-button hub-settings-button" data-panel="settings" aria-label="Settings" aria-expanded="false" aria-controls="hub-panel-settings">${icon('settings')}</button></div>
    </header>
    <p id="central-state" class="hub-service-note" role="status"></p>
    <div class="hub-world-caption" aria-hidden="true"><span>YOUR NEXT GOOD CONNECTION</span><p>Starts with a hello.</p></div>
    ${isRace ? `<aside class="hub-race-widget">${activity}</aside>` : ''}
    <div class="hub-panel-layer">
      <section id="hub-panel-chat" class="hub-panel hub-social-panel hub-chat-panel" role="dialog" aria-labelledby="hub-chat-title" tabindex="-1" hidden>
        ${panelHead('chat', 'Room chat', '')}
        <div class="hub-chat-tools"><span id="chat-room-status">Connecting to the conversation…</span><button id="chat-mute" class="hub-text-button" aria-pressed="false">Mute notifications</button><button id="chat-clear" class="hub-text-button">Clear</button></div>
        <div class="hub-chat-messages" id="chat-messages" role="log" aria-label="Room messages" aria-live="polite" aria-relevant="additions text"><div class="hub-chat-empty">${icon('chat')}<strong>Say hello.</strong><p>Everyone in this room can join in.</p></div></div>
        <button id="chat-latest" class="hub-latest" hidden>New messages ↓</button>
        <form id="chat-form" class="hub-chat-form"><label class="hub-sr-only" for="chat-input">Message the room</label><div class="hub-compose"><input id="chat-input" name="message" type="text" maxlength="280" placeholder="Say something nice…" autocomplete="off" enterkeyhint="send" aria-describedby="chat-error chat-counter" disabled><button type="submit" id="chat-send" aria-label="Send message" disabled>${icon('send')}</button></div><div class="hub-compose-footer"><span>Enter to send <span aria-hidden="true">·</span> Esc to return</span><span id="chat-counter">0 / 280</span></div><p id="chat-error" class="hub-chat-error" role="status"></p></form>
      </section>
      <section id="hub-panel-people" class="hub-panel hub-social-panel hub-people-panel" role="dialog" aria-labelledby="hub-people-title" tabindex="-1" hidden>
        ${panelHead('people', 'People here', '')}
        <div class="hub-section-heading"><span id="hub-people-count">0 explorers</span><span class="hub-live-label">In this room</span></div><div id="nearby-actors" class="hub-people-list" role="list" aria-label="People in this room"></div>
      </section>
      <section id="hub-panel-worlds" class="hub-panel hub-worlds-panel" role="dialog" aria-labelledby="hub-worlds-title" tabindex="-1" hidden>
        ${panelHead('worlds', 'Where to next?', 'A WORLD OF POSSIBILITIES')}
        <p class="hub-panel-intro">A new place, a familiar you. Pick a destination and take your look along.</p><div class="hub-destinations">${destinations.length ? '' : '<p class="hub-panel-intro">More worlds are on their way. For now, enjoy a little company here in the plaza.</p>'}${destinations.map((world, index) => `<button class="hub-destination" data-destination="${esc(world.id)}" aria-pressed="${index === 0}" style="--destination-accent:${color(world.accent)}"><span class="hub-destination-art" aria-hidden="true"><span class="hub-orbit"></span><span class="hub-planet"></span><span class="hub-world-number">0${index + 1}</span></span><span class="hub-destination-copy"><strong>${esc(world.name)}</strong><span>${esc(world.description)}</span></span><span class="hub-destination-arrow">${icon('arrow')}</span></button>`).join('')}</div>
        <a class="hub-home-link" href="${esc(homeUrl)}/worlds">Browse all worlds ↗</a><div class="hub-travel-footer"><p id="portal-hint">Explore the portals in the plaza, or choose your next world here.</p><p id="destination-description">${esc(initial?.description ?? 'More worlds are on their way.')}</p><button id="travel" class="hub-primary"${initial ? '' : ' disabled'}>Travel to ${esc(initial?.name ?? 'another world')} ${icon('arrow')}</button></div>
      </section>
      <section id="hub-panel-settings" class="hub-panel" role="dialog" aria-labelledby="hub-settings-title" tabindex="-1" hidden>
        ${panelHead('settings', 'Your kind of world.', 'MAKE YOURSELF COMFORTABLE')}
        <div class="hub-setting-block"><label class="hub-setting-label" for="graphics-quality"><span>${icon('sparkle')} Graphics quality</span><span id="graphics-tier" class="hub-quality-pill">Auto</span></label><select id="graphics-quality"><option value="auto">Auto · adapts to your device</option><option value="low">Low · keep it smooth</option><option value="medium">Medium · a little of everything</option><option value="high">High · all the atmosphere</option></select><p>Auto balances crisp detail, soft shadows and atmosphere as you explore.</p></div>
        <div class="hub-setting-block"><h3>Find your feet</h3><dl class="hub-controls-guide"><div><dt><kbd>W A S D</kbd> <span>or</span> <kbd>↑ ← ↓ →</kbd></dt><dd>Move around</dd></div><div><dt><kbd>Shift</kbd> <kbd>Space</kbd></dt><dd>Run & jump</dd></div><div><dt><kbd>E</kbd> <kbd>Enter</kbd></dt><dd>Wave & chat</dd></div><div><dt><kbd>Esc</kbd></dt><dd>Back to the world</dd></div></dl></div><div class="hub-button-row"><button id="respawn">Back to the plaza</button><button id="refresh-appearance">Refresh my look</button></div>
        ${!isRace ? `<details id="hub-showroom-controls" class="hub-showroom-controls"><summary>Showroom controls</summary>${activity}</details>` : ''}
        <details class="hub-technical"><summary>Connection & performance</summary><div id="avatar-stats"></div><div id="position-label"></div><div id="render-stats"></div></details><a class="hub-home-link" href="${esc(homeUrl)}">Return to WorldsBay home ${icon('arrow')}</a>
      </section>
      <section id="hub-panel-character" class="hub-panel hub-character-panel" role="dialog" aria-labelledby="hub-character-title" tabindex="-1" hidden>
        ${panelHead('character', 'Unmistakably you.', 'YOUR EXPLORER')}
        <div class="hub-account-card"><p id="hub-account-status" role="status">Checking your account…</p><div class="hub-button-row"><button id="hub-account-signup">Create account</button><button id="hub-account-signin">Sign in</button><button id="hub-account-logout" hidden>Sign out</button></div></div>
        <div class="hub-character-art" aria-hidden="true">${icon('character')}<span>${icon('sparkle')}</span></div><p class="hub-panel-intro">Your public name, character and outfit travel with you. Edit them on WorldsBay in this tab, then use Return to this world to resume playing.</p><div class="hub-look"><span class="hub-eyebrow">CURRENTLY WEARING</span><p id="outfit-label">Your signature look</p></div><button id="edit-character" class="hub-primary">Edit name &amp; character ${icon('arrow')}</button><button id="store" class="hub-wardrobe">Open wardrobe ${icon('sparkle')}</button>
      </section>
    </div>
    <div id="wave-status" class="hub-wave-status" role="status"></div>
    <div class="hub-touch-controls touch-controls" aria-label="Movement controls"><button data-key="w" aria-label="Move forward">↑</button><button data-key="a" aria-label="Move left">←</button><button data-key="s" aria-label="Move backward">↓</button><button data-key="d" aria-label="Move right">→</button><button id="touch-wave" aria-label="Wave hello">${icon('wave')}</button><button data-key=" " aria-label="Jump">↟</button></div>
    <footer class="hub-bottom"><p class="hub-movement-hint"><kbd>W A S D</kbd> to wander <span>·</span> <kbd>Enter</kbd> to say hello</p><nav class="hub-dock" aria-label="World actions">${dockButton('chat', 'Chat')}${dockButton('people', 'People')}${dockButton('worlds', 'Worlds')}<span class="hub-dock-divider"></span><button class="hub-dock-button" id="wave" aria-label="Wave">${icon('wave')}<span>Wave</span></button><button class="hub-dock-button" id="dance" aria-label="Dance">${icon('dance')}<span>Dance</span></button>${dockButton('character', 'Character')}</nav></footer>
  </div><dialog id="inspection" class="hub-inspection" aria-labelledby="inspection-title"><p class="hub-eyebrow">A LOOK WORTH SHARING</p><h2 id="inspection-title">Inspect collection</h2><div id="inspection-items"></div><button id="close-inspection" aria-label="Close">Back to the world</button></dialog>`;
}

export function mountHub(options: {
  connection: RoomConnection;
  clearMovement: () => void;
  quality: { mode: QualityMode; tier: QualityTier; setMode: (mode: QualityMode) => void };
  actorId: () => string;
}) {
  const shell = document.querySelector<HTMLElement>('.hub-shell')!;
  const query = <T extends HTMLElement = HTMLElement>(selector: string) => shell.querySelector<T>(selector)!;
  const abort = new AbortController();
  const events = { signal: abort.signal };
  const input = query<HTMLInputElement>('#chat-input');
  const send = query<HTMLButtonElement>('#chat-send');
  const log = query('#chat-messages');
  const error = query('#chat-error');
  const seen = new Set<string>();
  let active: Panel | undefined;
  let opener: HTMLElement | undefined;
  let unread = 0;
  let connected = false;
  let muted = false;
  let pendingDraft = '';
  let pendingTimer = 0;
  let retryTimer = 0;
  let retryAt = 0;
  let peopleMarkup = '';
  let keyboardOpen = false;
  let viewportFrame = 0;
  const viewport = window.visualViewport;
  const closingTimers = new Map<HTMLElement, number>();
  try {
    muted = localStorage.getItem('worldsbay.chat-muted') === 'true';
  } catch {
    /* Storage can be unavailable in private sessions. */
  }

  const refreshUnread = () => {
    const badge = query('#chat-unread');
    badge.textContent = unread > 99 ? '99+' : String(unread);
    badge.hidden = muted || !unread;
    query<HTMLButtonElement>('[data-panel="chat"]').setAttribute(
      'aria-description',
      unread && !muted ? `${unread} unread messages` : 'Chat with everyone in this room',
    );
  };
  const latest = () => {
    log.scrollTop = log.scrollHeight;
    query('#chat-latest').hidden = true;
  };
  const syncViewport = () => {
    if (abort.signal.aborted || !viewport) return;
    const wasAtBottom = log.scrollHeight - log.clientHeight - log.scrollTop < 60;
    const composerFocused = query('#chat-form').contains(document.activeElement);
    // Keep the sheet stable while focus moves from the input to Send. The
    // visual viewport restores the normal layout when the keyboard retracts.
    keyboardOpen =
      active === 'chat' && innerHeight - viewport.height > 120 && (composerFocused || keyboardOpen);
    shell.dataset.keyboardOpen = String(keyboardOpen);
    shell.style.setProperty('--hub-visible-height', `${viewport.height}px`);
    shell.style.setProperty('--hub-visible-top', `${viewport.offsetTop}px`);
    if (wasAtBottom && keyboardOpen) log.scrollTop = log.scrollHeight;
  };
  viewport?.addEventListener('resize', syncViewport, events);
  viewport?.addEventListener('scroll', syncViewport, events);
  window.addEventListener('resize', syncViewport, events);
  shell.addEventListener('focusin', syncViewport, events);
  shell.addEventListener(
    'focusout',
    () => {
      cancelAnimationFrame(viewportFrame);
      viewportFrame = requestAnimationFrame(syncViewport);
    },
    events,
  );
  const closePanel = (restoreFocus = true) => {
    if (!active) return;
    const panel = query(`#hub-panel-${active}`);
    panel.classList.add('hub-panel-closing');
    panel.inert = true;
    closingTimers.set(
      panel,
      window.setTimeout(
        () => {
          panel.hidden = true;
          panel.classList.remove('hub-panel-closing');
          closingTimers.delete(panel);
        },
        matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 160,
      ),
    );
    active = undefined;
    shell.dataset.openPanel = '';
    shell.querySelectorAll('[data-panel]').forEach((button) => button.setAttribute('aria-expanded', 'false'));
    if (restoreFocus && opener?.isConnected) opener.focus({ preventScroll: true });
    syncViewport();
    options.clearMovement();
  };
  const openPanel = (name: Panel, button?: HTMLElement) => {
    if (name === active) {
      closePanel();
      return;
    }
    closePanel(false);
    opener = button ?? (document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
    active = name;
    const panel = query(`#hub-panel-${name}`);
    clearTimeout(closingTimers.get(panel));
    closingTimers.delete(panel);
    panel.classList.remove('hub-panel-closing');
    panel.hidden = false;
    panel.inert = false;
    shell.dataset.openPanel = name;
    shell
      .querySelectorAll<HTMLElement>('[data-panel]')
      .forEach((item) => item.setAttribute('aria-expanded', String(item.dataset.panel === name)));
    options.clearMovement();
    if (name === 'chat') {
      unread = 0;
      refreshUnread();
      latest();
      (connected ? input : panel).focus({ preventScroll: true });
    } else panel.focus({ preventScroll: true });
    if (name === 'settings') setQuality(options.quality.mode, options.quality.tier);
    syncViewport();
  };
  const updateComposer = () => {
    query('#chat-counter').textContent = `${input.value.length} / 280`;
    send.disabled = !connected || !input.value.trim() || !!pendingDraft || Date.now() < retryAt;
  };
  const setQuality = (mode: QualityMode, tier: QualityTier) => {
    query<HTMLSelectElement>('#graphics-quality').value = mode;
    query('#graphics-tier').textContent = mode === 'auto' ? `Auto · ${tier}` : tier;
  };
  const showMute = () => {
    const button = query<HTMLButtonElement>('#chat-mute');
    button.setAttribute('aria-pressed', String(muted));
    button.textContent = muted ? 'Notifications muted' : 'Mute notifications';
    log.setAttribute('aria-live', muted ? 'off' : 'polite');
    refreshUnread();
  };
  shell.addEventListener(
    'click',
    (event) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>('[data-panel],[data-close-panel]');
      if (target?.hasAttribute('data-close-panel')) closePanel();
      else if (target?.dataset.panel) openPanel(target.dataset.panel as Panel, target);
    },
    events,
  );
  document.addEventListener(
    'keydown',
    (event) => {
      const target = event.target as HTMLElement;
      if (event.key === 'Escape' && active && !document.querySelector('dialog[open]')) {
        event.preventDefault();
        closePanel();
        return;
      }
      if (
        (event.key === 'Enter' || event.key === '/') &&
        !event.repeat &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !active &&
        !target.closest('input,textarea,select,button,a,dialog,[contenteditable="true"]')
      ) {
        event.preventDefault();
        openPanel('chat', query('[data-panel="chat"]'));
      }
    },
    events,
  );
  input.addEventListener(
    'input',
    () => {
      error.textContent = '';
      updateComposer();
    },
    events,
  );
  input.addEventListener('focus', options.clearMovement, events);
  query('#chat-form').addEventListener(
    'submit',
    (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text || !connected || pendingDraft || Date.now() < retryAt) return;
      if (!options.connection.send({ type: 'chat', text })) {
        error.textContent = 'The connection is busy. Your message is saved here; try again in a moment.';
        return;
      }
      pendingDraft = text;
      input.value = '';
      error.textContent = '';
      updateComposer();
      pendingTimer = window.setTimeout(() => {
        if (!input.value) input.value = pendingDraft;
        pendingDraft = '';
        error.textContent = 'Your message has not been confirmed. Check your connection before trying again.';
        updateComposer();
      }, 8000);
    },
    events,
  );
  query('#chat-mute').addEventListener(
    'click',
    () => {
      muted = !muted;
      try {
        localStorage.setItem('worldsbay.chat-muted', String(muted));
      } catch {
        /* The setting still works for this visit. */
      }
      showMute();
    },
    events,
  );
  query('#chat-clear').addEventListener(
    'click',
    () => {
      log.replaceChildren();
      const notice = document.createElement('p');
      notice.className = 'hub-chat-cleared';
      notice.textContent = 'Conversation cleared on your screen. New messages will appear here.';
      log.append(notice);
      unread = 0;
      refreshUnread();
      query('#chat-latest').hidden = true;
    },
    events,
  );
  query('#chat-latest').addEventListener('click', latest, events);
  log.addEventListener(
    'scroll',
    () => {
      if (log.scrollHeight - log.clientHeight - log.scrollTop < 50) query('#chat-latest').hidden = true;
    },
    events,
  );
  query<HTMLSelectElement>('#graphics-quality').addEventListener(
    'change',
    (event) => {
      const mode = (event.target as HTMLSelectElement).value as QualityMode;
      options.quality.setMode(mode);
      setQuality(mode, options.quality.tier);
    },
    events,
  );
  const offError = options.connection.on('chatError', (message) => {
    clearTimeout(pendingTimer);
    if (!input.value) input.value = pendingDraft;
    pendingDraft = '';
    error.textContent = message.message;
    retryAt = Date.now() + Math.max(0, Math.min(message.retryAfterMs ?? 0, 60000));
    clearTimeout(retryTimer);
    retryTimer = window.setTimeout(updateComposer, Math.max(0, retryAt - Date.now()) + 10);
    updateComposer();
  });
  const appendMessage = (message: ChatMessage, history = false) => {
    if (seen.has(message.id)) return;
    seen.add(message.id);
    // Both the room history and the local transcript are intentionally bounded.
    if (seen.size > 300) seen.delete(seen.values().next().value!);
    const own = message.actorId === options.actorId();
    if (own && pendingDraft) {
      clearTimeout(pendingTimer);
      pendingDraft = '';
      error.textContent = '';
      updateComposer();
    }
    const atBottom = log.scrollHeight - log.clientHeight - log.scrollTop < 60;
    log.querySelector('.hub-chat-empty')?.remove();
    log.querySelector('.hub-chat-cleared')?.remove();
    const row = document.createElement('article');
    row.className = `hub-message${own ? ' hub-message-self' : ''}`;
    const timestamp = new Date(message.time);
    const validTime = Number.isFinite(timestamp.getTime());
    row.innerHTML = `<span class="hub-message-avatar" style="--person-color:${color(message.color)}" aria-hidden="true">${esc(message.name.slice(0, 1).toUpperCase())}</span><div class="hub-message-content"><div class="hub-message-meta"><strong>${esc(message.name)}${own ? ' <span>you</span>' : ''}</strong><time${validTime ? ` datetime="${timestamp.toISOString()}"` : ''}>${validTime ? esc(timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) : ''}</time></div><p>${esc(message.text)}</p></div>`;
    log.append(row);
    while (log.children.length > 100) log.firstElementChild?.remove();
    if (history || atBottom || own) latest();
    else query('#chat-latest').hidden = false;
    if (!history && active !== 'chat' && !own) {
      unread++;
      refreshUnread();
    }
  };
  const setConnection = (state: ConnectionState) => {
    connected = state === 'ready';
    const empty = log.querySelector('.hub-chat-empty');
    if (empty) {
      empty.querySelector('strong')!.textContent = connected ? 'Say hello.' : 'Joining the conversation…';
      empty.querySelector('p')!.textContent = connected
        ? 'Everyone in this room can join in.'
        : state === 'expired'
          ? 'Reconnect to join the conversation again.'
          : state === 'offline'
            ? 'The conversation is paused while you are offline.'
            : 'Connecting you with this room…';
    }
    shell.dataset.connection = state;
    query('#connection-state').textContent = connected
      ? 'Live'
      : state === 'expired'
        ? 'Session ended'
        : state === 'offline'
          ? 'Offline'
          : state === 'reconnecting'
            ? 'Reconnecting…'
            : 'Connecting…';
    query('#chat-room-status').textContent = connected
      ? 'Live · this room'
      : state === 'expired'
        ? 'Reconnect to join again'
        : state === 'offline'
          ? 'Offline · messages paused'
          : 'Reconnecting to the conversation…';
    input.disabled = !connected;
    input.placeholder = connected ? 'Say something nice…' : 'Waiting for connection…';
    if (!connected && pendingDraft) {
      clearTimeout(pendingTimer);
      if (!input.value) input.value = pendingDraft;
      pendingDraft = '';
      error.textContent = 'Connection interrupted. Your message is saved here.';
    }
    updateComposer();
  };
  const setPeople = (poses: Pose[]) => {
    query('#hub-people-count').textContent =
      `${poses.length} ${poses.length === 1 ? 'explorer' : 'explorers'}`;
    query('#room-count').textContent = query('#hub-people-count').textContent;
    const rows = [...poses].sort(
      (a, b) =>
        Number(b.id === options.actorId()) - Number(a.id === options.actorId()) ||
        a.name.localeCompare(b.name),
    );
    const markup = rows
      .map((person) => {
        const self = person.id === options.actorId();
        return `<div class="hub-person" role="listitem"><span class="hub-person-avatar" style="--person-color:${color(person.color)}" aria-hidden="true">${esc(person.name.slice(0, 1).toUpperCase())}</span><div><strong>${esc(person.name)}${self ? '<span class="hub-you">you</span>' : ''}</strong><span${person.emote ? ' class="hub-person-emote"' : ''}>${person.emote?.id === 'wave' ? 'Waving hello' : person.emote?.id === 'dance' ? 'Dancing' : 'Here now'}</span></div><span class="hub-person-online" aria-label="Online"></span></div>`;
      })
      .join('');
    if (markup !== peopleMarkup) {
      query('#nearby-actors').innerHTML = markup || '<p class="hub-roster-empty">Waiting for explorers…</p>';
      peopleMarkup = markup;
    }
  };
  showMute();
  setQuality(options.quality.mode, options.quality.tier);
  setConnection(options.connection.state);
  return {
    setConnection,
    setPeople,
    receiveChat: (message: ChatMessage) => appendMessage(message),
    setChatHistory: (messages: ChatMessage[]) => {
      const live = log.getAttribute('aria-live');
      log.setAttribute('aria-live', 'off');
      messages.forEach((message) => appendMessage(message, true));
      log.setAttribute('aria-live', live ?? 'polite');
    },
    setQuality,
    isPanelOpen: () => !!active,
    isSocialPanelOpen: () => active === 'chat' || active === 'people',
    closePanels: () => closePanel(),
    dispose: () => {
      abort.abort();
      offError();
      clearTimeout(pendingTimer);
      clearTimeout(retryTimer);
      cancelAnimationFrame(viewportFrame);
      delete shell.dataset.keyboardOpen;
      shell.style.removeProperty('--hub-visible-height');
      shell.style.removeProperty('--hub-visible-top');
      for (const timer of closingTimers.values()) clearTimeout(timer);
      closingTimers.clear();
    },
  };
}
