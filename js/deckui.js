// Deck builder screen: load the card library live from a Google Sheet,
// browse/search it, and assemble named decks (hand-picked or random).
// Decks are stored locally as snapshots of the card definitions.

import { store } from './store.js';
import { el, toast } from './ui.js';
import { loadLibraryFromSheet, DEMO_CARDS } from './sheet.js';

let library = store.get('libraryCache', DEMO_CARDS);
let librarySource = store.get('librarySource', 'built-in demo cards');
let working = null; // { name, cards: [defs] } — deck being edited
let filter = '';

export function getCurrentDeckDefs() {
  const decks = store.get('decks', {});
  const current = store.get('currentDeck');
  return current && decks[current] ? decks[current].cards : [];
}

export function getCurrentDeckName() {
  const decks = store.get('decks', {});
  const current = store.get('currentDeck');
  return current && decks[current] ? current : null;
}

export function getSavedDecks() {
  return store.get('decks', {});
}

export function getLibrary() {
  return library;
}

export function randomDeckFromLibrary(n = 20) {
  const cards = [];
  if (!library.length) return cards;
  for (let i = 0; i < n; i++) {
    cards.push(structuredClone(library[Math.floor(Math.random() * library.length)]));
  }
  return cards;
}

export function initDeckView() {
  const decks = getSavedDecks();
  const current = getCurrentDeckName();
  working = current ? structuredClone({ name: current, cards: decks[current].cards }) : { name: 'My Deck', cards: [] };

  const sheetInput = document.getElementById('sheet-url');
  sheetInput.value = store.get('sheetUrl', '');
  document.getElementById('btn-load-sheet').addEventListener('click', () => loadSheet(sheetInput.value));
  document.getElementById('btn-demo-cards').addEventListener('click', () => {
    library = DEMO_CARDS;
    librarySource = 'built-in demo cards';
    store.set('libraryCache', library);
    store.set('librarySource', librarySource);
    renderLibrary();
    toast('Loaded built-in demo cards');
  });
  document.getElementById('lib-search').addEventListener('input', (e) => {
    filter = e.target.value.toLowerCase();
    renderLibrary();
  });

  document.getElementById('btn-deck-new').addEventListener('click', () => {
    working = { name: uniqueDeckName('New Deck'), cards: [] };
    renderDeckPanel();
  });
  document.getElementById('btn-deck-save').addEventListener('click', saveWorkingDeck);
  document.getElementById('btn-deck-delete').addEventListener('click', () => {
    const decks = getSavedDecks();
    if (!decks[working.name]) return toast('This deck isn’t saved yet.', 'warn');
    if (!confirm(`Delete deck “${working.name}”?`)) return;
    delete decks[working.name];
    store.set('decks', decks);
    if (store.get('currentDeck') === working.name) store.del('currentDeck');
    working = { name: 'My Deck', cards: [] };
    renderDeckPanel();
    toast('Deck deleted');
  });
  document.getElementById('btn-deck-clear').addEventListener('click', () => {
    working.cards = [];
    renderDeckPanel();
  });
  document.getElementById('btn-deck-random').addEventListener('click', () => {
    const n = Math.max(1, Math.min(60, parseInt(document.getElementById('random-count').value, 10) || 10));
    for (let i = 0; i < n; i++) {
      if (!library.length) break;
      working.cards.push(structuredClone(library[Math.floor(Math.random() * library.length)]));
    }
    renderDeckPanel();
    toast(`Added ${n} random card${n === 1 ? '' : 's'}`);
  });
  document.getElementById('deck-select').addEventListener('change', (e) => {
    const decks = getSavedDecks();
    const name = e.target.value;
    if (decks[name]) {
      working = structuredClone({ name, cards: decks[name].cards });
      renderDeckPanel();
    }
  });
  document.getElementById('btn-deck-use').addEventListener('click', () => {
    saveWorkingDeck();
    store.set('currentDeck', working.name);
    renderDeckPanel();
    toast(`“${working.name}” is now your active deck`);
  });
  document.getElementById('deck-name').addEventListener('input', (e) => {
    working.name = e.target.value.trim() || 'My Deck';
  });

  renderLibrary();
  renderDeckPanel();
}

function uniqueDeckName(base) {
  const decks = getSavedDecks();
  if (!decks[base]) return base;
  let i = 2;
  while (decks[`${base} ${i}`]) i++;
  return `${base} ${i}`;
}

function saveWorkingDeck() {
  const decks = getSavedDecks();
  working.name = (document.getElementById('deck-name').value || working.name).trim() || 'My Deck';
  decks[working.name] = { name: working.name, cards: working.cards };
  store.set('decks', decks);
  if (!store.get('currentDeck')) store.set('currentDeck', working.name);
  renderDeckPanel();
  toast(`Saved “${working.name}” (${working.cards.length} cards)`);
}

async function loadSheet(input) {
  const status = document.getElementById('sheet-status');
  status.textContent = 'Loading…';
  try {
    const cards = await loadLibraryFromSheet(input);
    library = cards;
    librarySource = 'Google Sheet';
    store.set('libraryCache', library);
    store.set('librarySource', librarySource);
    store.set('sheetUrl', input.trim());
    status.textContent = '';
    renderLibrary();
    toast(`Loaded ${cards.length} cards from the sheet`);
  } catch (err) {
    status.textContent = '⚠ ' + err.message;
  }
}

function libraryCardEl(def, actions) {
  return el('div', { class: 'lib-card' },
    el('div', { class: 'lib-card-main' },
      el('div', { class: 'lib-title', text: def.title }),
      def.keywords?.length ? el('div', { class: 'card-keywords' }, def.keywords.map((k) => el('span', { class: 'kw', text: k }))) : null,
      el('div', { class: 'lib-desc', text: def.description }),
      (def.upgrades?.[0] || def.upgrades?.[1])
        ? el('div', { class: 'lib-upgrades' },
            def.upgrades[0] ? el('div', { text: '★A: ' + def.upgrades[0] }) : null,
            def.upgrades[1] ? el('div', { text: '★B: ' + def.upgrades[1] }) : null)
        : null,
    ),
    el('div', { class: 'lib-card-actions' }, actions),
  );
}

function renderLibrary() {
  document.getElementById('lib-source').textContent = `${library.length} cards · ${librarySource}`;
  const list = document.getElementById('lib-list');
  list.replaceChildren();
  const cards = library.filter((c) => {
    if (!filter) return true;
    const hay = (c.title + ' ' + c.description + ' ' + (c.keywords || []).join(' ')).toLowerCase();
    return hay.includes(filter);
  });
  if (!cards.length) list.append(el('p', { class: 'empty', text: 'No cards match.' }));
  for (const def of cards) {
    list.append(libraryCardEl(def, el('button', {
      class: 'btn small primary', text: '+ Add',
      onClick: () => {
        working.cards.push(structuredClone(def));
        renderDeckPanel();
      },
    })));
  }
}

function renderDeckPanel() {
  const decks = getSavedDecks();
  const current = getCurrentDeckName();

  const select = document.getElementById('deck-select');
  select.replaceChildren(el('option', { value: '', text: '— saved decks —' }));
  for (const name of Object.keys(decks)) {
    const opt = el('option', { value: name, text: name + (name === current ? ' ✓ active' : '') });
    if (name === working.name) opt.selected = true;
    select.append(opt);
  }

  document.getElementById('deck-name').value = working.name;
  document.getElementById('deck-count').textContent = `${working.cards.length} cards`;
  document.getElementById('deck-active-note').textContent =
    current === working.name ? 'This is your active deck — it’s what you bring into a game.' :
    current ? `Active deck: “${current}”` : 'No active deck yet — click “Use this deck”.';

  const list = document.getElementById('deck-list');
  list.replaceChildren();
  if (!working.cards.length) list.append(el('p', { class: 'empty', text: 'Empty — add cards from the library, or add random ones.' }));
  working.cards.forEach((def, i) => {
    list.append(libraryCardEl(def, el('button', {
      class: 'btn small warn', text: '✕',
      title: 'Remove from deck',
      onClick: () => {
        working.cards.splice(i, 1);
        renderDeckPanel();
      },
    })));
  });
}
