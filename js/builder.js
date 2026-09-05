// Pool tools, embedded at the top of your own pool's browser: add cards to
// your pool from the one shared library (the hardcoded sheet) — hand-picked,
// X random, or a draft of X picks from 2-3 choices each.
//
// The modal system re-invokes the render function on every state broadcast,
// so the builder keeps ONE persistent root node (inputs and scroll survive)
// and only re-renders its dynamic parts on its own interactions.

import { el, toast, kwEl } from './ui.js';
import { normalizeCategory, categoryLabel, guideHue } from './game.js';
import { store } from './store.js';

let deps = { getLibrary: () => [], retryLoad: () => {}, add: () => {}, owned: () => new Set() };

function normUp(u) {
  return u && typeof u === 'object' ? u : { text: String(u || ''), sticker: '' };
}

let target = null; // boardId whose pool the tools act on
let guide = store.get('spiritGuide', ''); // your chosen spirit guide
let search = '';
let draft = null;  // { total, done, choices, options: [defs] }
let root = null;
let parts = null;  // references to the dynamic containers

export function configureBuilder(d) {
  deps = d;
}

export function poolToolsNode(targetBoardId) {
  target = targetBoardId || null;
  if (!root) build();
  update();
  return root;
}

function lib() {
  return deps.getLibrary();
}

function clone(def) {
  return structuredClone(def);
}

function catOf(def) {
  return normalizeCategory(def.category);
}

function titleKey(def) {
  return String(def?.title || '').toLowerCase();
}

// Pools hold one copy of each card, so everything the target board already
// owns is off the menu.
function ownedNow() {
  return deps.owned(target) || new Set();
}

// Draft source: 'general', 'death', or 'guide:<name>' for one spirit guide.
let draftSource = 'general';

function sourceLabel(source) {
  if (source === 'death') return 'Death';
  if (source.startsWith('guide:')) return source.slice(6);
  return 'General';
}

function inSource(def, source) {
  if (source === 'death') return catOf(def) === 'death';
  if (source.startsWith('guide:')) {
    return catOf(def) === 'spirit' && String(def.spiritGuide || '').trim() === source.slice(6);
  }
  return catOf(def) === 'general';
}

// A distinct random sample from a source, skipping cards the board owns.
function sampleDefs(n, source, exclude = null) {
  const owned = ownedNow();
  const pool = lib().filter((c) =>
    inSource(c, source) && !owned.has(titleKey(c)) && !exclude?.has(titleKey(c)));
  const idx = [...pool.keys()];
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, Math.min(n, idx.length)).map((i) => clone(pool[i]));
}

// "Add random" stays a General-cards tool.
function randomDefs(n, exclude = null) {
  return sampleDefs(n, 'general', exclude);
}

// ---------- draft ----------

function startDraft(total, choices) {
  if (!lib().length) return toast('The card library hasn’t loaded yet.', 'warn');
  const options = sampleDefs(choices, draftSource);
  if (!options.length) return toast(`No unowned ${sourceLabel(draftSource)} cards left to draft.`, 'warn');
  draft = { total, done: 0, choices, source: draftSource, taken: new Set(), options };
  update();
}

function pickOption(def) {
  deps.add([clone(def)], target); // each pick goes straight into the pool
  // The broadcast confirming the add is async, so track this draft's picks
  // locally too — the next options must not repeat them.
  draft.taken.add(titleKey(def));
  draft.done++;
  if (draft.done >= draft.total) {
    const n = draft.total;
    draft = null;
    toast(`Draft complete — ${n} card${n === 1 ? '' : 's'} added to the pool`);
  } else {
    draft.options = sampleDefs(draft.choices, draft.source, draft.taken);
    if (!draft.options.length) {
      const n = draft.done;
      draft = null;
      toast(`Draft ended early — no unowned cards left (${n} added)`, 'warn');
    }
  }
  update();
}

// ---------- skeleton ----------

function build() {
  parts = {};

  const randomCount = el('input', { type: 'number', min: '1', max: '60', value: '20', id: 'bld-random-count' });
  const randomBtn = el('button', {
    class: 'btn small', id: 'bld-random-btn', text: 'Add random',
    onClick: () => {
      if (!lib().length) return toast('The card library hasn’t loaded yet.', 'warn');
      const n = Math.max(1, Math.min(60, parseInt(randomCount.value, 10) || 20));
      const defs = randomDefs(n);
      if (!defs.length) return toast('Every General card is already in the pool.', 'warn');
      deps.add(defs, target);
      update();
    },
  });

  const draftCount = el('input', { type: 'number', min: '1', max: '40', value: '10', id: 'bld-draft-count' });
  const draftChoices = el('select', { id: 'bld-draft-choices' },
    el('option', { value: '2', text: '1 of 2' }),
    el('option', { value: '3', text: '1 of 3' }));
  // Which cards the draft deals from: General, Death, or one spirit guide.
  parts.draftSource = el('select', { id: 'bld-draft-source' });
  parts.draftSource.addEventListener('change', () => { draftSource = parts.draftSource.value; });
  const draftBtn = el('button', {
    class: 'btn small', id: 'bld-draft-start', text: 'Start draft',
    onClick: () => startDraft(
      Math.max(1, Math.min(40, parseInt(draftCount.value, 10) || 10)),
      parseInt(draftChoices.value, 10) === 3 ? 3 : 2,
    ),
  });

  const searchInput = el('input', {
    id: 'bld-search', placeholder: 'Search cards…',
    onInput: (e) => { search = e.target.value.toLowerCase(); renderLib(); },
  });

  parts.libWrap = el('div', { class: 'card-list builder-lib' });
  parts.libNote = el('div', { class: 'hint', id: 'bld-lib-note' });

  parts.mainView = el('div', {},
    el('div', { class: 'builder-tools' },
      el('span', { class: 'tool-row' }, randomCount, randomBtn),
      el('span', { class: 'tool-row' }, draftCount, el('span', { class: 'hint', text: 'picks of' }), draftChoices, el('span', { class: 'hint', text: 'from' }), parts.draftSource, draftBtn),
    ),
    el('div', { class: 'builder-search' }, searchInput, parts.libNote),
    parts.libWrap,
  );

  parts.draftView = el('div', { class: 'draft-view' });
  root = el('div', { class: 'builder' }, parts.mainView, parts.draftView);
}

// ---------- dynamic renders ----------

function update() {
  if (!root) return;
  parts.mainView.classList.toggle('hidden', !!draft);
  parts.draftView.classList.toggle('hidden', !draft);
  if (draft) renderDraft();
  else renderLib();
}

function libRow(def, owned) {
  const inPool = owned.has(titleKey(def));
  const row = el('div', { class: 'lib-card cat-' + catOf(def) + (inPool ? ' in-pool' : '') },
    el('div', { class: 'lib-card-main' },
      el('div', { class: 'lib-title', text: def.title }),
      el('div', { class: 'lib-cat', text: categoryLabel(def) }),
      def.keywords?.length ? el('div', { class: 'card-keywords' }, def.keywords.map(kwEl)) : null,
      el('div', { class: 'lib-desc', text: def.description }),
      (() => {
        const ups = [normUp(def.upgrades?.[0]), normUp(def.upgrades?.[1])];
        if (!ups[0].text && !ups[1].text) return null;
        return el('div', { class: 'lib-upgrades' },
          ups.map((u, i) => u.text ? el('div', { text: '★' + (u.sticker || (i === 0 ? 'A' : 'B')) + ': ' + u.text }) : null));
      })(),
    ),
    el('div', { class: 'lib-card-actions' },
      inPool
        ? el('button', { class: 'btn small', text: 'In pool', disabled: true })
        : el('button', { class: 'btn small primary', text: '+ Add', onClick: () => deps.add([clone(def)], target) })),
  );
  if (catOf(def) === 'spirit') row.style.setProperty('--sg', guideHue(def.spiritGuide));
  return row;
}

function renderLib() {
  const pool = lib();
  // Per-category counts make sheet problems visible at a glance.
  const counts = { general: 0, base: 0, death: 0, spirit: 0 };
  for (const c of pool) counts[catOf(c)]++;
  parts.libNote.textContent = pool.length
    ? `${pool.length} cards · ${counts.general} General · ${counts.base} Base · ${counts.death} Death · ${counts.spirit} Spirit`
    : '';
  parts.libWrap.replaceChildren();
  if (!pool.length) {
    parts.libWrap.append(
      el('p', { class: 'empty', text: 'The card library hasn’t loaded.' }),
      el('button', { class: 'btn small', text: 'Retry loading', onClick: () => deps.retryLoad().then(update) }),
    );
    return;
  }
  const owned = ownedNow();
  const matches = (c) => !search ||
    (c.title + ' ' + c.description + ' ' + (c.keywords || []).join(' ')).toLowerCase().includes(search);
  const general = pool.filter((c) => catOf(c) === 'general' && matches(c));
  const base = pool.filter((c) => catOf(c) === 'base' && matches(c));
  const death = pool.filter((c) => catOf(c) === 'death' && matches(c));
  const spiritAll = pool.filter((c) => catOf(c) === 'spirit');
  const guides = [...new Set(spiritAll.map((c) => String(c.spiritGuide || '').trim()).filter(Boolean))].sort();
  if (guide && !guides.includes(guide)) guide = '';
  const spirit = spiritAll.filter((c) => matches(c) && guide && String(c.spiritGuide || '').trim() === guide);

  // Draft sources reflect the library: General, Death, each spirit guide.
  if (draftSource.startsWith('guide:') && !guides.includes(draftSource.slice(6))) draftSource = 'general';
  parts.draftSource.replaceChildren(el('option', { value: 'general', text: 'General' }));
  if (pool.some((c) => catOf(c) === 'death')) {
    parts.draftSource.append(el('option', { value: 'death', text: 'Death' }));
  }
  for (const g of guides) {
    parts.draftSource.append(el('option', { value: 'guide:' + g, text: 'Spirit: ' + g }));
  }
  parts.draftSource.value = draftSource;

  // General
  if (general.length || search) {
    parts.libWrap.append(el('div', { class: 'lib-section-head', text: 'General' }));
    if (!general.length) parts.libWrap.append(el('p', { class: 'empty', text: 'No cards match.' }));
    for (const def of general) parts.libWrap.append(libRow(def, owned));
  }

  // Base — everyone starts with these (and repeats aren't allowed, so they
  // usually all show as "In pool").
  if (base.length) {
    parts.libWrap.append(el('div', { class: 'lib-section-head' }, 'Base',
      el('span', { class: 'hint', text: 'in every pool by default' })));
    for (const def of base) parts.libWrap.append(libRow(def, owned));
  }

  // Death
  if (death.length) {
    parts.libWrap.append(el('div', { class: 'lib-section-head', text: 'Death' }));
    for (const def of death) parts.libWrap.append(libRow(def, owned));
  }

  // Spirit Guide — pick your guide before its cards can be added.
  if (spiritAll.length) {
    const guideSel = el('select', { id: 'bld-guide' },
      el('option', { value: '', text: '— select your spirit guide —' }),
      guides.map((g) => {
        const opt = el('option', { value: g, text: g });
        if (g === guide) opt.selected = true;
        return opt;
      }));
    guideSel.addEventListener('change', () => {
      guide = guideSel.value;
      store.set('spiritGuide', guide);
      renderLib();
    });
    const guideDot = guide ? el('span', { class: 'guide-dot' }) : null;
    if (guideDot) guideDot.style.background = `hsl(${guideHue(guide)} 55% 55%)`;
    parts.libWrap.append(el('div', { class: 'lib-section-head' }, 'Spirit Guide', guideSel, guideDot));
    if (!guide) {
      parts.libWrap.append(el('p', { class: 'empty', text: 'Select your spirit guide to see and add its cards.' }));
    } else {
      if (!spirit.length) parts.libWrap.append(el('p', { class: 'empty', text: 'No cards match.' }));
      for (const def of spirit) parts.libWrap.append(libRow(def, owned));
    }
  }
}

function renderDraft() {
  parts.draftView.replaceChildren(
    el('div', { class: 'builder-head' },
      el('span', {}, el('strong', { text: `Pick ${draft.done + 1} of ${draft.total}` }), ` — choose 1 of ${draft.choices} · ${sourceLabel(draft.source)} cards`),
      el('button', {
        class: 'btn small warn', id: 'bld-cancel-draft', text: 'Stop drafting',
        onClick: () => { draft = null; update(); },
      }),
    ),
    el('div', { class: 'draft-options' },
      draft.options.map((def) => defCard(def, () => pickOption(def))),
    ),
  );
}

// A physical-style card rendered from a library definition (no owner yet).
function defCard(def, onPick) {
  const node = el('div', { class: 'card table pickable cat-' + normalizeCategory(def.category), onClick: onPick });
  node.style.setProperty('--owner', '#8b887f');
  const face = el('div', { class: 'card-face' },
    el('div', { class: 'card-titlebar' }, el('span', { class: 'card-title', text: def.title })),
    def.keywords?.length ? el('div', { class: 'card-keywords' }, def.keywords.map(kwEl)) : null,
    def.description ? el('div', { class: 'card-desc', text: def.description }) : null,
    (() => {
      const ups = [normUp(def.upgrades?.[0]), normUp(def.upgrades?.[1])];
      if (!ups[0].text && !ups[1].text) return null;
      return el('div', { class: 'card-ups' },
        ups.map((u, i) => u.text
          ? el('div', { class: 'up-line' },
              el('span', { class: 'up-star', text: '★' + (u.sticker || (i === 0 ? 'A' : 'B')) }),
              el('span', { class: 'up-text', text: u.text }))
          : null));
    })(),
  );
  face.append(el('div', { class: 'card-cat', text: categoryLabel(def) }));
  node.append(face);
  return node;
}
