// The one canonical card library, loaded live from THE Google Sheet
// ("Cards" tab), plus keyword descriptions from its "Keywords" tab.
// The sheet is hardcoded on purpose: players cannot import their own cards
// or point the app at a different list. The last successful load is cached
// so the app still works through a network blip.
//
// Expected columns (header names matched loosely, order doesn't matter):
//   Title | Description | Keywords | Upgrade 1 | Upgrade 1 Sticker | Upgrade 2 | Upgrade 2 Sticker
// Keywords are comma/semicolon separated (e.g. "Delayed, Shuffle").
// The sticker names the upgrade: a "Hamburger" sticker makes it the
// Hamburger upgrade rather than "option A".

import { store } from './store.js';

export const SHEET_ID = '1ewtANY7m7Xz7ldtYjdbT86BE_VidhynVgb-18YArw18';

// The CSV export returns every cell as plain text. The gviz JSON endpoint
// types each column and NULLS cells that don't match the majority type (a
// text title in a mostly-numeric column silently vanishes) — CSV avoids
// that entirely.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); field = ''; rows.push(row); row = []; }
    else if (ch !== '\r') field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function cellAt(row, i) {
  return i >= 0 && i < row.length ? String(row[i]).trim() : '';
}

function splitKeywords(text) {
  return String(text || '')
    .split(/[,;|]/)
    .map((k) => k.trim())
    .filter(Boolean);
}

function tabUrl(tab) {
  const base = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv`;
  return tab ? base + '&sheet=' + encodeURIComponent(tab) : base;
}

// Board states from the "States" tab (State | Description), in sheet order.
async function fetchStates() {
  const res = await fetch(tabUrl('States'));
  if (!res.ok) throw new Error(`Google Sheets returned ${res.status}.`);
  const rows = parseCsv(await res.text());
  if (rows.length < 1) throw new Error('No States tab.');
  const labels = rows[0].map((l) => String(l).trim().toLowerCase());
  let colState = labels.findIndex((l) => l.includes('state'));
  if (colState < 0) colState = 0;
  let colDesc = labels.findIndex((l) => l.includes('desc'));
  if (colDesc < 0) colDesc = 1;
  const states = [];
  for (const row of rows.slice(1)) {
    const name = cellAt(row, colState);
    if (name) states.push({ name: name.slice(0, 60), desc: cellAt(row, colDesc).slice(0, 500) });
  }
  return states;
}

// Keyword descriptions from the "Keywords" tab (Keyword | Description).
async function fetchKeywords() {
  const res = await fetch(tabUrl('Keywords'));
  if (!res.ok) throw new Error(`Google Sheets returned ${res.status}.`);
  const rows = parseCsv(await res.text());
  if (rows.length < 1) throw new Error('No Keywords tab.');
  const labels = rows[0].map((l) => String(l).trim().toLowerCase());
  let colKw = labels.findIndex((l) => l.includes('keyword'));
  if (colKw < 0) colKw = 0;
  let colDesc = labels.findIndex((l) => l.includes('desc'));
  if (colDesc < 0) colDesc = 1;
  const map = {};
  for (const row of rows.slice(1)) {
    const kw = cellAt(row, colKw).toLowerCase();
    const desc = cellAt(row, colDesc);
    if (kw && desc) map[kw] = desc.slice(0, 500);
  }
  return map;
}

async function fetchLibrary(tab) {
  const res = await fetch(tabUrl(tab));
  if (!res.ok) throw new Error(`Google Sheets returned ${res.status}.`);
  const rows = parseCsv(await res.text());
  if (rows.length < 2) throw new Error('The card sheet loaded but contained no cards.');
  const labels = rows[0].map((l) => String(l).trim().toLowerCase());

  const findCol = (pred, fallback) => {
    const i = labels.findIndex(pred);
    return i >= 0 ? i : fallback;
  };
  const colTitle = findCol((l) => l.includes('title') || l === 'name' || l.includes('card name'), 0);
  const colDesc = findCol((l) => l.includes('desc') && !l.includes('upgrade'), 1);
  const colKeywords = findCol((l) => l.includes('keyword') || l.includes('tag'), 2);
  const isUpgradeText = (l) => l.includes('upgrade') && !l.includes('sticker');
  const colUp1 = findCol((l) => isUpgradeText(l) && /(1|a|one|left)\b/.test(l), 3);
  const colUp2 = findCol((l, i) => isUpgradeText(l) && i !== colUp1, 4);
  const colSt1 = findCol((l) => l.includes('sticker') && /(1|a|one|left)\b/.test(l), -1);
  const colSt2 = findCol((l, i) => l.includes('sticker') && i !== colSt1, -1);
  const colCat = findCol((l) => l.includes('categor'), -1);
  // "Spirit Guide" column: which spirit guide a Spirit Guide card belongs to.
  const colGuide = findCol((l) => l.includes('spirit') && !l.includes('categor'), -1);

  const cards = [];
  for (const row of rows.slice(1)) {
    const title = cellAt(row, colTitle);
    if (!title) continue;
    cards.push({
      title,
      description: cellAt(row, colDesc),
      keywords: splitKeywords(cellAt(row, colKeywords)),
      category: colCat >= 0 ? cellAt(row, colCat) : '',
      spiritGuide: colGuide >= 0 ? cellAt(row, colGuide) : '',
      upgrades: [
        { text: cellAt(row, colUp1), sticker: colSt1 >= 0 ? cellAt(row, colSt1) : '' },
        { text: cellAt(row, colUp2), sticker: colSt2 >= 0 ? cellAt(row, colSt2) : '' },
      ],
    });
  }
  if (!cards.length) throw new Error('The card sheet loaded but contained no cards.');
  return cards;
}

// Returns { cards, keywords, states, source: 'live' | 'cache' }. Throws only
// if the sheet is unreachable AND there is no cached copy.
export async function loadLibrary() {
  try {
    let cards;
    try {
      cards = await fetchLibrary('Cards');
    } catch {
      cards = await fetchLibrary(null); // older sheets: single unnamed tab
    }
    store.set('libraryCache', cards);
    let keywords;
    try {
      keywords = await fetchKeywords();
      store.set('kwCache', keywords);
    } catch {
      keywords = store.get('kwCache', {});
    }
    let states;
    try {
      states = await fetchStates();
      store.set('stateCache', states);
    } catch {
      states = store.get('stateCache', []);
    }
    return { cards, keywords, states, source: 'live' };
  } catch (err) {
    const cached = store.get('libraryCache');
    if (Array.isArray(cached) && cached.length) {
      return { cards: cached, keywords: store.get('kwCache', {}), states: store.get('stateCache', []), source: 'cache' };
    }
    throw err;
  }
}
