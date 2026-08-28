// Pool tools, embedded at the top of your own pool's browser: add cards to
// your pool from the one shared library (the hardcoded sheet) — hand-picked,
// X random, or a draft of X picks from 2-3 choices each.
//
// The modal system re-invokes the render function on every state broadcast,
// so the builder keeps ONE persistent root node (inputs and scroll survive)
// and only re-renders its dynamic parts on its own interactions.

import { el, toast } from './ui.js';
import { normalizeCategory } from './game.js';

let deps = { getLibrary: () => [], retryLoad: () => {}, add: () => {} };

function normUp(u) {
  return u && typeof u === 'object' ? u : { text: String(u || ''), sticker: '' };
}

let sel = [];      // chosen card defs
let target = null; // playerId whose pool the tools act on
let search = '';
let draft = null;  // { total, done, choices, options: [defs] }
let root = null;
let parts = null;  // references to the dynamic containers

export function configureBuilder(d) {
  deps = d;
}

export function poolToolsNode(targetPlayerId) {
  target = targetPlayerId || null;
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

function randomDefs(n, distinct = false) {
  const pool = lib();
  if (!pool.length) return [];
  if (!distinct) {
    return Array.from({ length: n }, () => clone(pool[Math.floor(Math.random() * pool.length)]));
  }
  const idx = [...pool.keys()];
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, Math.min(n, idx.length)).map((i) => clone(pool[i]));
}

// ---------- draft ----------

function startDraft(total, choices) {
  if (!lib().length) return toast('The card library hasn’t loaded yet.', 'warn');
  draft = { total, done: 0, choices, options: randomDefs(choices, true) };
  update();
}

function pickOption(def) {
  sel.push(clone(def));
  draft.done++;
  if (draft.done >= draft.total) {
    const n = draft.total;
    draft = null;
    toast(`Draft complete — ${n} card${n === 1 ? '' : 's'} added`);
  } else {
    draft.options = randomDefs(draft.choices, true);
  }
  update();
}

// ---------- skeleton ----------

function build() {
  parts = {};

  parts.count = el('strong', {});
  parts.dealBtn = el('button', {
    class: 'btn small primary', id: 'bld-deal',
    onClick: () => {
      if (!sel.length) return toast('Pick some cards first.', 'warn');
      deps.add(sel.map(clone), target);
      sel = [];
      update();
    },
  });
  const clearBtn = el('button', {
    class: 'btn small warn', id: 'bld-clear', text: 'Clear',
    onClick: () => { sel = []; update(); },
  });

  const randomCount = el('input', { type: 'number', min: '1', max: '60', value: '20', id: 'bld-random-count' });
  const randomBtn = el('button', {
    class: 'btn small', id: 'bld-random-btn', text: 'Add random',
    onClick: () => {
      if (!lib().length) return toast('The card library hasn’t loaded yet.', 'warn');
      const n = Math.max(1, Math.min(60, parseInt(randomCount.value, 10) || 20));
      sel.push(...randomDefs(n));
      toast(`Added ${n} random card${n === 1 ? '' : 's'}`);
      update();
    },
  });

  const draftCount = el('input', { type: 'number', min: '1', max: '40', value: '10', id: 'bld-draft-count' });
  const draftChoices = el('select', { id: 'bld-draft-choices' },
    el('option', { value: '2', text: '1 of 2' }),
    el('option', { value: '3', text: '1 of 3' }));
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

  parts.selWrap = el('div', { class: 'sel-chips' });
  parts.libWrap = el('div', { class: 'card-list builder-lib' });
  parts.libNote = el('div', { class: 'hint', id: 'bld-lib-note' });

  parts.mainView = el('div', {},
    el('div', { class: 'builder-head' },
      el('span', {}, parts.count, ' picked'),
      el('span', { class: 'builder-head-actions' }, parts.dealBtn, clearBtn),
    ),
    el('p', { class: 'hint', text: 'Picked cards are shuffled into your pool when you add them.' }),
    el('div', { class: 'builder-tools' },
      el('span', { class: 'tool-row' }, randomCount, randomBtn),
      el('span', { class: 'tool-row' }, draftCount, el('span', { class: 'hint', text: 'picks of' }), draftChoices, draftBtn),
    ),
    parts.selWrap,
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
  else {
    parts.count.textContent = `${sel.length} card${sel.length === 1 ? '' : 's'}`;
    parts.dealBtn.textContent = `Add to pool (${sel.length})`;
    renderSel();
    renderLib();
  }
}

function renderSel() {
  parts.selWrap.replaceChildren();
  sel.forEach((def, i) => {
    parts.selWrap.append(el('span', { class: 'sel-chip' },
      el('span', { text: def.title }),
      el('button', {
        class: 'chip-x', title: 'Remove',
        onClick: () => { sel.splice(i, 1); update(); }, text: '✕',
      }),
    ));
  });
  if (!sel.length) parts.selWrap.append(el('span', { class: 'empty', text: 'Nothing picked yet — pick from the list, add random, or draft.' }));
}

function renderLib() {
  const pool = lib();
  parts.libNote.textContent = pool.length ? `${pool.length} cards in the library` : '';
  parts.libWrap.replaceChildren();
  if (!pool.length) {
    parts.libWrap.append(
      el('p', { class: 'empty', text: 'The card library hasn’t loaded.' }),
      el('button', { class: 'btn small', text: 'Retry loading', onClick: () => deps.retryLoad().then(update) }),
    );
    return;
  }
  const cards = pool.filter((c) => {
    if (!search) return true;
    return (c.title + ' ' + c.description + ' ' + (c.keywords || []).join(' ')).toLowerCase().includes(search);
  });
  if (!cards.length) parts.libWrap.append(el('p', { class: 'empty', text: 'No cards match.' }));
  for (const def of cards) {
    parts.libWrap.append(el('div', { class: 'lib-card cat-' + normalizeCategory(def.category) },
      el('div', { class: 'lib-card-main' },
        el('div', { class: 'lib-title', text: def.title }),
        def.keywords?.length ? el('div', { class: 'card-keywords' }, def.keywords.map((k) => el('span', { class: 'kw', text: k }))) : null,
        el('div', { class: 'lib-desc', text: def.description }),
        (() => {
          const ups = [normUp(def.upgrades?.[0]), normUp(def.upgrades?.[1])];
          if (!ups[0].text && !ups[1].text) return null;
          return el('div', { class: 'lib-upgrades' },
            ups.map((u, i) => u.text ? el('div', { text: '★' + (u.sticker || (i === 0 ? 'A' : 'B')) + ': ' + u.text }) : null));
        })(),
      ),
      el('div', { class: 'lib-card-actions' },
        el('button', { class: 'btn small primary', text: '+ Add', onClick: () => { sel.push(clone(def)); update(); } })),
    ));
  }
}

function renderDraft() {
  parts.draftView.replaceChildren(
    el('div', { class: 'builder-head' },
      el('span', {}, el('strong', { text: `Pick ${draft.done + 1} of ${draft.total}` }), ` — choose 1 of ${draft.choices}`),
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
    def.keywords?.length ? el('div', { class: 'card-keywords' }, def.keywords.map((k) => el('span', { class: 'kw', text: k }))) : null,
    def.description ? el('div', { class: 'card-desc', text: def.description }) : null,
    (() => {
      const ups = [normUp(def.upgrades?.[0]), normUp(def.upgrades?.[1])];
      if (!ups[0].text && !ups[1].text) return null;
      return el('div', { class: 'card-ups' },
        ups.map((u, i) => u.text
          ? el('div', { class: 'up-line' },
              el('span', { class: 'up-star', text: '★' + (u.sticker || (i === 0 ? 'A' : 'B')) }),
              el('span', { text: u.text }))
          : null));
    })(),
  );
  node.append(face);
  return node;
}
