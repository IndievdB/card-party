// The one canonical card library, loaded live from THE Google Sheet.
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

function parseGvizText(text) {
  // Response looks like: /*O_o*/\ngoogle.visualization.Query.setResponse({...});
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error('Unexpected response from Google Sheets.');
  return JSON.parse(text.slice(start, end + 1));
}

function cellText(cell) {
  if (!cell || cell.v == null) return '';
  return String(cell.f != null ? cell.f : cell.v).trim();
}

function splitKeywords(text) {
  return String(text || '')
    .split(/[,;|]/)
    .map((k) => k.trim())
    .filter(Boolean);
}

async function fetchLibrary() {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&headers=1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Google Sheets returned ${res.status}.`);
  const json = parseGvizText(await res.text());
  if (json.status === 'error') {
    throw new Error('Google Sheets error: ' + (json.errors?.[0]?.detail_message || 'unknown'));
  }

  const table = json.table;
  let labels = (table.cols || []).map((c) => String(c.label || '').trim().toLowerCase());
  let rows = table.rows || [];

  // If gviz didn't detect a header row, the labels are empty and the first row is the header.
  if (labels.every((l) => !l) && rows.length) {
    labels = (rows[0].c || []).map((c) => cellText(c).toLowerCase());
    rows = rows.slice(1);
  }

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
  for (const row of rows) {
    const c = row.c || [];
    const title = cellText(c[colTitle]);
    if (!title) continue;
    cards.push({
      title,
      description: cellText(c[colDesc]),
      keywords: splitKeywords(cellText(c[colKeywords])),
      category: colCat >= 0 ? cellText(c[colCat]) : '',
      spiritGuide: colGuide >= 0 ? cellText(c[colGuide]) : '',
      upgrades: [
        { text: cellText(c[colUp1]), sticker: colSt1 >= 0 ? cellText(c[colSt1]) : '' },
        { text: cellText(c[colUp2]), sticker: colSt2 >= 0 ? cellText(c[colSt2]) : '' },
      ],
    });
  }
  if (!cards.length) throw new Error('The card sheet loaded but contained no cards.');
  return cards;
}

// Returns { cards, source: 'live' | 'cache' }. Throws only if the sheet is
// unreachable AND there is no cached copy.
export async function loadLibrary() {
  try {
    const cards = await fetchLibrary();
    store.set('libraryCache', cards);
    return { cards, source: 'live' };
  } catch (err) {
    const cached = store.get('libraryCache');
    if (Array.isArray(cached) && cached.length) {
      return { cards: cached, source: 'cache' };
    }
    throw err;
  }
}
