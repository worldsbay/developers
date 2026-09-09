import type { Appearance } from '../core/contract.js';
import { avatarPreview } from '../three/preview.js';
import {
  CHARACTER_PROFILE,
  characterAppearance,
  characterPartIssue,
  characterHiddenSlots,
  reconcileCharacterParts,
  characterSlots,
  defaultCharacterRecipe,
  validateCharacterRecipe,
  type CharacterPack,
  type CharacterRecipe,
  type CharacterSlot,
} from './contract.js';
import './style.css';

export type CharacterCreatorOptions = {
  pack: CharacterPack;
  appearance: Appearance;
  recipe?: CharacterRecipe;
  /** Save through the central browser session; worlds must redirect there for writes. */
  save: (recipe: CharacterRecipe, expectedRevision: number) => Promise<Appearance>;
  onSaved?: (appearance: Appearance) => void;
  preview?: ReturnType<typeof avatarPreview>;
};
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const labels: Record<CharacterSlot, string> = {
  head: 'Face',
  hair: 'Hair',
  headwear: 'Headwear',
  top: 'Top',
  outerwear: 'Armor',
  arms: 'Arms',
  armwear: 'Bracers',
  legs: 'Legs',
  feet: 'Footwear',
  belt: 'Belt',
  shoulders: 'Shoulders',
  neck: 'Neckwear',
  back: 'Back',
  weapon: 'Held item',
};
const partOrder: CharacterSlot[] = [
  'head',
  'hair',
  'headwear',
  'top',
  'outerwear',
  'shoulders',
  'neck',
  'back',
  'arms',
  'armwear',
  'weapon',
  'belt',
  'legs',
  'feet',
];
let creatorSequence = 0;

/** Framework-independent, disposable creator. All drafts remain local until save(). */
export function mountCharacterCreator(container: HTMLElement, options: CharacterCreatorOptions) {
  const pack = options.pack;
  const sectionGroup = `character-parts-${++creatorSequence}`;
  let saved = options.appearance;
  let savedRecipe = options.recipe ?? saved.character?.recipe;
  let fitNotice = '';
  function restoreRecipe() {
    if (savedRecipe)
      try {
        const restored = reconcileCharacterParts(
          { ...structuredClone(savedRecipe), packRevision: pack.revision },
          pack,
        );
        fitNotice = restored.removed.length
          ? `Removed pieces that no longer fit: ${restored.removed.join(', ')}.`
          : '';
        return restored.recipe;
      } catch {}
    return defaultCharacterRecipe(pack);
  }
  let draft = restoreRecipe();
  let disposed = false,
    generation = 0,
    busy = false,
    ready = false;
  container.innerHTML = `<section class="character-creator" aria-label="Character builder"><div class="character-stage" data-character-stage></div><div class="character-controls"><p class="character-kicker">YOUR LOOK. YOUR WORLDS.</p><h2>A character of your own.</h2><p>Mix the parts, find your colors, and take your character into every connected world.</p><label>Collection <select data-character-rig>${pack.rigs.map((r) => `<option value="${r.id}">${escape(r.name)}</option>`).join('')}</select></label><div class="character-parts" data-character-parts></div><div class="character-colors">${['skin', 'hair', 'cloth'].map((channel) => `<label>${channel === 'cloth' ? 'Clothing' : channel === 'skin' ? 'Skin' : 'Hair color'}<input type="color" data-character-color="${channel}" aria-label="${channel === 'cloth' ? 'Clothing color' : channel === 'skin' ? 'Skin color' : 'Hair color'}"></label>`).join('')}</div><div class="character-motion"><label>Find animation<input type="search" data-character-search placeholder="Walk, dance, swim…"></label><label>Preview animation<select data-character-animation></select></label><button type="button" data-character-play>Play animation</button></div><p class="character-status" data-character-status role="status" aria-live="polite"></p><div class="character-actions"><button type="button" data-character-cancel>Reset changes</button><button type="button" data-character-save class="primary">Save character</button></div></div></section>`;
  const query = <E extends HTMLElement = HTMLElement>(selector: string) =>
    container.querySelector<E>(selector)!;
  query('[data-character-parts]').insertAdjacentHTML(
    'beforebegin',
    `<div class="character-palette"><label>Color palette<select data-character-palette aria-label="Color palette"><option value="original">Original item colors</option><option value="custom">Custom colors</option></select></label><p>Thumbnails show original colors. Keep individual pieces original with their checkbox.</p></div><p class="character-fit-notice" data-character-fit-notice role="status" aria-live="polite"></p>`,
  );
  const stage = query('[data-character-stage]');
  const preview = options.preview ?? avatarPreview(stage);
  if (options.preview) stage.remove();
  const status = query('[data-character-status]'),
    saveButton = query<HTMLButtonElement>('[data-character-save]');
  function setStatus(message: string) {
    if (!disposed) status.textContent = message;
  }
  function fillAnimations() {
    const search = query<HTMLInputElement>('[data-character-search]').value.toLowerCase();
    const rig = pack.rigs.find((r) => r.id === draft.rig)!;
    query<HTMLSelectElement>('[data-character-animation]').innerHTML = rig.clips
      .filter((c) => `${c.name} ${c.library}`.toLowerCase().includes(search))
      .map((c) => `<option value="${c.id}">${escape(c.name)} · ${escape(c.library)}</option>`)
      .join('');
    if (!search) query<HTMLSelectElement>('[data-character-animation]').value = rig.aliases.idle;
  }
  function renderParts() {
    const rig = pack.rigs.find((r) => r.id === draft.rig)!;
    const hidden = characterHiddenSlots(draft, pack);
    const partsContainer = query('[data-character-parts]');
    const openSlot = partsContainer.children.length
      ? partsContainer.querySelector<HTMLElement>('details[open]')?.dataset.characterSection
      : 'head';
    query('[data-character-fit-notice]').textContent = fitNotice;
    partsContainer.innerHTML = partOrder
      .flatMap((slot) => {
        const parts = pack.parts.filter((p) => p.rig === rig.id && p.slot === slot);
        if (!parts.length) return [];
        const selected = parts.find((p) => p.id === draft.parts[slot]);
        const covered = hidden.get(slot);
        const original = (draft.partColorModes?.[slot] ?? draft.colorMode ?? 'custom') === 'original';
        const thumbnail = (p: typeof selected) =>
          p?.thumbnail?.url
            ? `<img src="${escape(p.thumbnail.url)}" alt="" width="96" height="96" loading="lazy">`
            : '<span class="character-part-empty" aria-hidden="true">—</span>';
        return [
          `<details class="character-part-picker" data-character-section="${slot}" name="${sectionGroup}" ${openSlot === slot ? 'open' : ''}><summary aria-label="${labels[slot]} parts">${thumbnail(selected)}<span class="character-part-heading"><strong>${labels[slot]}</strong><span>${covered ? `Covered by ${escape(covered)}` : escape(selected?.name.replace(/^Male |^Female /, '') ?? 'None')}</span></span><span class="character-part-chevron" aria-hidden="true"></span></summary><div class="character-part-content">${covered ? `<p class="character-fit-note">Your ${labels[slot].toLowerCase()} selection returns when ${escape(covered)} is removed.</p>` : ''}<div class="character-part-grid" role="group" aria-label="${labels[slot]} options">${rig.requiredSlots.includes(slot) ? '' : `<button type="button" data-character-pick="" data-pick-slot="${slot}" aria-label="None" aria-pressed="${!selected}" ${covered ? 'disabled' : ''}><span class="character-part-empty">—</span><span>None</span></button>`}${parts
            .map((p) => {
              const issue = characterPartIssue(p, draft, pack);
              return `<button type="button" data-character-pick="${p.id}" data-pick-slot="${slot}" aria-label="${escape(p.name)}" aria-pressed="${p.id === selected?.id}" ${issue || covered ? 'disabled' : ''}>${thumbnail(p)}<span>${escape(p.name.replace(/^Male |^Female /, ''))}</span><small>${escape(p.collection ?? '')}${p.adaptedFrom ? ' · Fitted' : ''}</small>${issue ? `<small class="character-fit-reason">${escape(issue)}</small>` : ''}</button>`;
            })
            .join(
              '',
            )}</div>${selected && !covered ? `<label class="character-original-toggle"><input type="checkbox" data-character-original="${slot}" aria-label="${labels[slot]} original colors" ${original ? 'checked' : ''}>Original colors</label>` : ''}</div></details>`,
        ];
      })
      .join('');
  }
  function renderColors() {
    query<HTMLSelectElement>('[data-character-palette]').value = draft.colorMode ?? 'custom';
    const custom = characterSlots.some(
      (slot) =>
        draft.parts[slot] && (draft.partColorModes?.[slot] ?? draft.colorMode ?? 'custom') === 'custom',
    );
    for (const input of container.querySelectorAll<HTMLInputElement>('[data-character-color]')) {
      input.value = draft.colors[input.dataset.characterColor as keyof typeof draft.colors];
      input.disabled = busy || !custom;
    }
  }
  function render() {
    query<HTMLSelectElement>('[data-character-rig]').value = draft.rig;
    renderParts();
    renderColors();
    fillAnimations();
  }
  function choosePart(slot: CharacterSlot, id: string | null) {
    const part = pack.parts.find((p) => p.id === id);
    const issue = part && characterPartIssue(part, draft, pack);
    if (issue || characterHiddenSlots(draft, pack).has(slot)) return;
    const result = reconcileCharacterParts({ ...draft, parts: { ...draft.parts, [slot]: id } }, pack);
    draft = result.recipe;
    fitNotice = result.removed.length
      ? `Removed pieces that no longer fit: ${result.removed.join(', ')}.`
      : '';
    renderParts();
    renderColors();
    void show();
  }
  async function show() {
    const current = ++generation;
    ready = false;
    saveButton.disabled = true;
    setStatus('Loading your character…');
    try {
      validateCharacterRecipe(draft, pack);
      const appearance: Appearance = {
        ...saved,
        profile: CHARACTER_PROFILE,
        bodyAsset: pack.rigs.find((r) => r.id === draft.rig)!.asset.url!,
        equipped: [],
        character: characterAppearance(structuredClone(draft), pack),
      };
      const loaded = await preview.show(appearance);
      if (disposed || current !== generation) return;
      ready = loaded;
      saveButton.disabled = !ready || busy;
      setStatus(
        loaded
          ? 'Preview only · Save to take this look with you.'
          : 'The preview could not load. Change a part or reset to retry.',
      );
    } catch (error) {
      if (current === generation)
        setStatus(error instanceof Error ? error.message : 'Unable to preview character.');
    }
  }
  const change = (event: Event) => {
    if (busy) return;
    const target = event.target as HTMLInputElement;
    if (target.matches('[data-character-rig]')) {
      draft = defaultCharacterRecipe(pack, target.value);
      fitNotice = '';
      render();
      void show();
    }
    if (target.matches('[data-character-palette]')) {
      draft.colorMode = target.value as 'original' | 'custom';
      delete draft.partColorModes;
      renderParts();
      renderColors();
      void show();
    }
    if (target.dataset.characterOriginal) {
      draft.partColorModes = {
        ...draft.partColorModes,
        [target.dataset.characterOriginal]: target.checked ? 'original' : 'custom',
      };
      renderColors();
      void show();
    }
    if (target.dataset.characterColor) {
      draft.colors[target.dataset.characterColor as keyof typeof draft.colors] = target.value;
      void show();
    }
  };
  container.addEventListener('change', change);
  const pick = (event: Event) => {
    const summary = (event.target as HTMLElement).closest<HTMLElement>('[data-character-section] > summary');
    if (summary) {
      requestAnimationFrame(() => {
        if (!disposed && summary.parentElement?.hasAttribute('open'))
          summary.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      });
      return;
    }
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-character-pick]');
    if (!button || button.disabled || busy) return;
    const slot = button.dataset.pickSlot as CharacterSlot;
    choosePart(slot, button.dataset.characterPick || null);
    query<HTMLElement>(`[data-character-section="${slot}"] [aria-pressed="true"]`).focus({
      preventScroll: true,
    });
  };
  container.addEventListener('click', pick);
  query<HTMLInputElement>('[data-character-search]').oninput = fillAnimations;
  query<HTMLButtonElement>('[data-character-play]').onclick = async () => {
    const id = query<HTMLSelectElement>('[data-character-animation]').value;
    const clip = pack.rigs.find((r) => r.id === draft.rig)!.clips.find((c) => c.id === id);
    if (!clip || !ready) return;
    try {
      await preview.playClip(clip.asset, clip.id, clip.loop);
      setStatus(`Playing ${clip.name}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Animation could not load.');
    }
  };
  query<HTMLButtonElement>('[data-character-cancel]').onclick = () => {
    if (busy) return;
    draft = restoreRecipe();
    render();
    void show();
  };
  saveButton.onclick = async () => {
    if (busy || !ready) return;
    busy = true;
    saveButton.disabled = true;
    const submitting = structuredClone(draft);
    container
      .querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select')
      .forEach((e) => (e.disabled = true));
    try {
      saved = await options.save(submitting, saved.revision ?? 1);
      if (disposed) return;
      savedRecipe = saved.character!.recipe;
      draft = structuredClone(savedRecipe);
      setStatus('Character saved. Ready for every world.');
      options.onSaved?.(saved);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Saving failed. Your draft is still here.');
    } finally {
      busy = false;
      if (!disposed) {
        saveButton.disabled = !ready;
        container
          .querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select')
          .forEach((e) => (e.disabled = false));
        renderParts();
        renderColors();
      }
    }
  };
  render();
  void show();
  return {
    getRecipe: () => structuredClone(draft),
    dispose() {
      disposed = true;
      generation++;
      container.removeEventListener('change', change);
      container.removeEventListener('click', pick);
      if (!options.preview) preview.dispose();
      container.replaceChildren();
    },
  };
}
