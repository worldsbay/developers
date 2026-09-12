import { avatarWorlds } from '../ui/avatar-worlds.js';
import { characterStyle } from '../wire/avatar-support.js';
import { clothingRegions } from './color-regions.js';
import type { Appearance } from '../core/contract.js';
import { avatarPreview } from '../three/preview.js';
import {
  CHARACTER_PROFILE,
  characterAppearance,
  characterPartIssue,
  characterHiddenSlots,
  characterRequiredSlots,
  reconcileCharacterParts,
  restoreCharacterRecipe,
  characterSlots,
  defaultCharacterRecipe,
  validateCharacterRecipe,
  type CharacterPack,
  type CharacterRecipe,
  type CharacterSlot,
} from './contract.js';
import './style.css';
import {
  wardrobeChoices,
  wardrobeOutfits,
  changeClothingStyle,
  chooseOutfit,
  selectedOutfit,
  outfitLabel,
  characterPartLabel,
  selectableCharacterParts,
} from './wardrobe.js';

export type CharacterCreatorOptions = {
  pack: CharacterPack;
  appearance: Appearance;
  worlds?: import('../core/contract.js').World[];
  recipe?: CharacterRecipe;
  avatarSlots?: Partial<Record<'low-poly' | 'detailed', CharacterRecipe>>;
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
const partLabels: Record<CharacterSlot, string> = {
  head: 'Face',
  hair: 'Hair',
  beard: 'Facial hair',
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
  'beard',
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
        const restored = restoreCharacterRecipe(savedRecipe, pack);
        fitNotice = [
          restored.replaced.length
            ? `Updated unavailable pieces: ${restored.replaced.map((slot) => partLabels[slot]).join(', ')}.`
            : '',
          restored.removed.length ? `Removed pieces that no longer fit: ${restored.removed.join(', ')}.` : '',
        ]
          .filter(Boolean)
          .join(' ');
        return restored.recipe;
      } catch {}
    return defaultCharacterRecipe(pack);
  }
  let draft = restoreRecipe();
  let disposed = false,
    generation = 0,
    busy = false,
    ready = false;
  container.innerHTML = `<section class="character-creator" aria-label="Character builder"><div class="character-stage" data-character-stage></div><div class="character-controls"><header class="character-editor-header"><div><p class="character-kicker">THE DETAILS</p><h2>Your two avatars</h2></div><div class="character-actions"><button type="button" data-character-cancel>Reset changes</button><button type="button" data-character-save class="primary">Save character</button></div><p class="character-status" data-character-status role="status" aria-live="polite"></p></header><p class="avatar-support-note">One identity, two saved looks. Worlds may accept either style, both, or provide their own avatar. Save each look separately; your last saved look is preferred where both work.</p><div class="avatar-slot-cards" data-avatar-slots role="group" aria-label="Your avatar slots"></div><div data-avatar-worlds aria-live="polite"></div><div class="character-settings"><label class="character-detail-selector">Visual style<select data-character-detail aria-label="Visual style"><option value="low-poly">Low poly</option><option value="detailed">Detailed</option></select></label><label>Character<select data-character-person aria-label="Character"></select></label><label>Clothing style<select data-character-style aria-label="Clothing style"></select></label><label>Outfit<select data-character-outfit aria-label="Outfit"></select></label><label>Color palette<select data-character-palette aria-label="Color palette"><option value="original">Original item colors</option><option value="custom">Custom colors</option></select></label></div><p class="character-palette-note">Keep the original colors, or choose a palette of your own.</p><div class="character-colors">${['skin', 'hair', 'cloth'].map((channel) => `<label>${channel === 'cloth' ? 'Clothing' : channel === 'skin' ? 'Skin' : 'Hair color'}<input type="color" data-character-color="${channel}" aria-label="${channel === 'cloth' ? 'Clothing color' : channel === 'skin' ? 'Skin color' : 'Hair color'}"></label>`).join('')}</div><p class="character-fit-notice" data-character-fit-notice role="status" aria-live="polite"></p><div class="character-parts" data-character-parts></div><details class="character-motion-panel"><summary>Preview animations <span>Try a pose or a move</span></summary><div class="character-motion"><label>Find animation<input type="search" data-character-search placeholder="Walk, dance, swim…"></label><label>Preview animation<select data-character-animation></select></label><button type="button" data-character-play>Play animation</button></div></details><details class="character-motion-panel"><summary>Asset credits</summary><p>Character models and animations by Quaternius. Source collections: ${[...new Set(pack.parts.map((p) => p.collection).filter(Boolean))].map((name) => escape(name!)).join(', ')}.</p></details></div></section>`;
  const query = <E extends HTMLElement = HTMLElement>(selector: string) =>
    container.querySelector<E>(selector)!;
  const worldPictures = query('[data-avatar-worlds]');
  const pictureError = (event: Event) => {
    const image = event.target;
    if (image instanceof HTMLImageElement && !image.src.startsWith('data:image/svg+xml')) {
      image.removeAttribute('srcset');
      image.src = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 88 56%22%3E%3Crect width=%2288%22 height=%2256%22 fill=%22%23edf2ff%22/%3E%3C/svg%3E';
    }
  };
  worldPictures.addEventListener('error', pictureError, true);
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
    query<HTMLSelectElement>('[data-character-outfit]').value = selectedOutfit(draft, pack);
    const rig = pack.rigs.find((r) => r.id === draft.rig)!;
    const fullBody = !rig.requiredSlots.includes('head') && !rig.id.startsWith('universal-');
    const requiredSlots = characterRequiredSlots(draft, pack);
    const labels = fullBody
      ? { ...partLabels, top: 'Body', legs: 'Clothing', outerwear: 'Accessories', headwear: 'Features' }
      : partLabels;
    const hidden = characterHiddenSlots(draft, pack);
    const partsContainer = query('[data-character-parts]');
    const openSlot = partsContainer.children.length
      ? partsContainer.querySelector<HTMLElement>('details[open]')?.dataset.characterSection
      : rig.requiredSlots.includes('head')
        ? 'head'
        : 'top';
    query('[data-character-fit-notice]').textContent = fitNotice;
    partsContainer.innerHTML = partOrder
      .flatMap((slot) => {
        const parts = selectableCharacterParts(pack, rig.id, slot);
        if (!parts.length) return [];
        const selected = pack.parts.find((p) => p.id === draft.parts[slot]);
        const covered = hidden.get(slot);
        const original = (draft.partColorModes?.[slot] ?? draft.colorMode ?? 'custom') === 'original';
        const regions = selected ? clothingRegions(selected) : [];
        const regionControls =
          selected && !covered && regions.length
            ? `<div class="character-colors character-region-colors">${regions.map((region) => `<label>${region.label}<input type="color" aria-label="${region.label} color" data-region-part="${selected.id}" data-region-id="${region.id}" value="${escape(!original ? (draft.partColors?.[selected.id]?.[region.id as 'fabric' | 'trim' | 'leather'] ?? region.color) : region.color)}"></label>`).join('')}</div><p class="character-fit-note">Change one color while keeping the other original colors.</p><button type="button" data-region-reset="${selected.id}">Reset item colors</button>`
            : '';
        const thumbnail = (p: typeof selected) =>
          p?.thumbnail?.url
            ? `<img src="${escape(p.thumbnail.url)}" alt="" width="96" height="96" loading="lazy">`
            : '<span class="character-part-empty" aria-hidden="true">—</span>';
        return [
          `<details class="character-part-picker" data-character-section="${slot}" name="${sectionGroup}" ${openSlot === slot ? 'open' : ''}><summary aria-label="${labels[slot]} parts">${thumbnail(selected)}<span class="character-part-heading"><strong>${labels[slot]}</strong><span>${covered ? `Covered by ${escape(covered)}` : escape(characterPartLabel(selected?.name.replace(/^Male |^Female /, '') ?? 'None'))}</span></span><span class="character-part-chevron" aria-hidden="true"></span></summary><div class="character-part-content">${covered ? `<p class="character-fit-note">Your ${labels[slot].toLowerCase()} selection returns when ${escape(covered)} is removed.</p>` : ''}<div class="character-part-grid" role="group" aria-label="${labels[slot]} options">${requiredSlots.includes(slot) ? '' : `<button type="button" data-character-pick="" data-pick-slot="${slot}" aria-label="None" aria-pressed="${!selected}" ${covered ? 'disabled' : ''}><span class="character-part-empty">—</span><span>None</span></button>`}${parts
            .map((p) => {
              const issue = characterPartIssue(p, draft, pack);
              return `<button type="button" data-character-pick="${p.id}" data-pick-slot="${slot}" aria-label="${escape(characterPartLabel(p.name))}" aria-pressed="${p.id === selected?.id}" ${issue || covered ? 'disabled' : ''}>${thumbnail(p)}<span>${escape(characterPartLabel(p.name.replace(/^Male |^Female /, '')))}</span>${p.adaptedFrom ? '<small>Fitted</small>' : ''}${issue ? `<small class="character-fit-reason">${escape(issue)}</small>` : ''}</button>`;
            })
            .join(
              '',
            )}</div>${regionControls}${selected && !covered && !fullBody ? `<label class="character-original-toggle"><input type="checkbox" data-character-original="${slot}" aria-label="${labels[slot]} original colors" ${original ? 'checked' : ''}>Original colors</label>` : ''}</div></details>`,
        ];
      })
      .join('');
  }
  function renderColors() {
    const rig = pack.rigs.find((r) => r.id === draft.rig)!;
    const channels =
      rig.colorChannels ?? (rig.requiredSlots.includes('head') ? ['skin', 'hair', 'cloth'] : []);
    query<HTMLSelectElement>('[data-character-palette]').parentElement!.hidden = channels.length === 0;
    query('.character-palette-note').hidden = channels.length === 0;
    query('.character-palette-note').textContent = rig.colorChannels
      ? 'Choose an outfit above, then mix its parts below. Skin tone is included in each top. Custom colors change hair, eyebrows and supported clothing.'
      : 'Keep the original colors, or choose a palette of your own.';
    query<HTMLSelectElement>('[data-character-palette]').value = draft.colorMode ?? 'custom';
    const custom =
      channels.length > 0 &&
      characterSlots.some(
        (slot) =>
          draft.parts[slot] && (draft.partColorModes?.[slot] ?? draft.colorMode ?? 'custom') === 'custom',
      );
    query('.character-colors').hidden = !custom;
    for (const input of container.querySelectorAll<HTMLInputElement>('[data-character-color]')) {
      input.parentElement!.hidden = !channels.includes(
        input.dataset.characterColor as keyof CharacterRecipe['colors'],
      );
      input.value = draft.colors[input.dataset.characterColor as keyof typeof draft.colors];
      input.disabled = busy || !custom;
    }
  }
  const detailFor = characterStyle;
  const slotRecipes = { ...options.avatarSlots };
  if (savedRecipe) slotRecipes[detailFor(savedRecipe.rig)] = savedRecipe;
  const detailDrafts = new Map<string, CharacterRecipe>(
    Object.entries(slotRecipes).map(([style, recipe]) => [
      style,
      restoreCharacterRecipe(recipe!, pack).recipe,
    ]),
  );
  function render() {
    const detail = detailFor(draft.rig);
    query('[data-avatar-worlds]').innerHTML = avatarWorlds(options.worlds ?? [], detail);
    query('[data-avatar-slots]').innerHTML = (['low-poly', 'detailed'] as const)
      .map(
        (style) =>
          `<button type="button" data-avatar-style="${style}" aria-pressed="${style === detail}"><strong>${style === 'low-poly' ? 'Low poly' : 'Detailed'}</strong><span>${slotRecipes[style] ? 'Saved look' : 'Create this look'}${style === detail ? ' · Editing' : ''}</span></button>`,
      )
      .join('');
    query<HTMLSelectElement>('[data-character-detail]').value = detail;
    const choices = wardrobeChoices(pack).filter((c) => detailFor(c.rig) === detail);
    const current = choices.find((c) => c.rig === draft.rig)!;
    const people = [...new Set(choices.map((c) => c.character))];
    const person = query<HTMLSelectElement>('[data-character-person]');
    person.innerHTML = people
      .map((name) => `<option value="${escape(name)}">${escape(name)}</option>`)
      .join('');
    person.value = current.character;
    const style = query<HTMLSelectElement>('[data-character-style]');
    style.innerHTML = choices
      .filter((c) => c.character === current.character)
      .map((c) => `<option value="${escape(c.style)}">${escape(c.style)}</option>`)
      .join('');
    style.value = current.style;
    style.parentElement!.hidden = choices.filter((c) => c.character === current.character).length === 1;
    query<HTMLSelectElement>('[data-character-outfit]').parentElement!.hidden =
      wardrobeOutfits(pack, draft.rig).length < 2;
    query<HTMLSelectElement>('[data-character-outfit]').innerHTML =
      '<option value="" disabled>Custom outfit</option>' +
      wardrobeOutfits(pack, draft.rig)
        .map((o) => `<option value="${escape(o.family)}">${escape(outfitLabel(o.family))}</option>`)
        .join('');
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
    fitNotice = [
      result.removed.length ? `Removed pieces that no longer fit: ${result.removed.join(', ')}.` : '',
      result.fitted.length ? `Selected matching pieces: ${result.fitted.join(', ')}.` : '',
    ]
      .filter(Boolean)
      .join(' ');
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
    if (target.matches('[data-character-detail]')) {
      detailDrafts.set(detailFor(draft.rig), structuredClone(draft));
      const choices = wardrobeChoices(pack).filter((c) => detailFor(c.rig) === target.value);
      const current = wardrobeChoices(pack).find((c) => c.rig === draft.rig)!;
      const destination = choices.find((c) => c.character === current.character) ?? choices[0];
      if (!destination) return;
      draft = detailDrafts.get(target.value) ?? changeClothingStyle(draft, pack, destination.rig).recipe;
      fitNotice = '';
      render();
      void show();
    }
    if (target.matches('[data-character-person], [data-character-style]')) {
      const choices = wardrobeChoices(pack).filter((c) => detailFor(c.rig) === detailFor(draft.rig));
      const person = query<HTMLSelectElement>('[data-character-person]').value;
      const style = query<HTMLSelectElement>('[data-character-style]').value;
      const destination =
        choices.find((c) => c.character === person && c.style === style) ??
        choices.find((c) => c.character === person)!;
      const result = changeClothingStyle(draft, pack, destination.rig);
      draft = result.recipe;
      fitNotice = result.unavailable.length
        ? `Selected a starting look for unavailable pieces: ${result.unavailable.join(', ')}.`
        : '';
      render();
      void show();
    }
    if (target.matches('[data-character-outfit]')) {
      draft = chooseOutfit(draft, pack, target.value);
      fitNotice = '';
      render();
      void show();
    }
    if (target.dataset.regionPart && target.dataset.regionId) {
      const part = pack.parts.find((p) => p.id === target.dataset.regionPart)!;
      draft.partColors = {
        ...draft.partColors,
        [part.id]: { ...draft.partColors?.[part.id], [target.dataset.regionId]: target.value },
      };
      draft.partColorModes = { ...draft.partColorModes, [part.slot]: 'custom' };
      renderParts();
      renderColors();
      void show();
      return;
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
    const slotButton = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-avatar-style]');
    if (slotButton && !busy) {
      const select = query<HTMLSelectElement>('[data-character-detail]');
      select.value = slotButton.dataset.avatarStyle!;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    const reset = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-region-reset]');
    if (reset && !busy) {
      const part = pack.parts.find((p) => p.id === reset.dataset.regionReset)!;
      if (draft.partColors) delete draft.partColors[part.id];
      draft.partColorModes = { ...draft.partColorModes, [part.slot]: 'original' };
      renderParts();
      renderColors();
      void show();
      return;
    }
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
    const style = detailFor(draft.rig);
    draft = slotRecipes[style]
      ? restoreCharacterRecipe(slotRecipes[style]!, pack).recipe
      : defaultCharacterRecipe(pack, draft.rig);
    detailDrafts.set(style, structuredClone(draft));
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
      slotRecipes[detailFor(savedRecipe.rig)] = structuredClone(savedRecipe);
      detailDrafts.set(detailFor(savedRecipe.rig), structuredClone(savedRecipe));
      render();
      draft = structuredClone(savedRecipe);
      setStatus('Character saved. Your other avatar is kept for worlds that need it.');
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
      worldPictures.removeEventListener('error', pictureError, true);
      container.removeEventListener('change', change);
      container.removeEventListener('click', pick);
      if (!options.preview) preview.dispose();
      container.replaceChildren();
    },
  };
}
