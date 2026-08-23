// Loads the card library live from a Google Sheet via the public gviz JSON
// endpoint (works for any sheet shared as "Anyone with the link can view";
// no API key required).
//
// Expected columns (header names matched loosely, order doesn't matter):
//   Title | Description | Keywords | Upgrade 1 | Upgrade 2
// Keywords are comma/semicolon separated (e.g. "Delayed, Shuffle").

export function parseSheetId(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  const m = s.match(/\/d\/([a-zA-Z0-9_-]{10,})/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]{10,}$/.test(s)) return s;
  return null;
}

function parseGvizText(text) {
  // Response looks like: /*O_o*/\ngoogle.visualization.Query.setResponse({...});
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error('Unexpected response from Google Sheets.');
  return JSON.parse(text.slice(start, end + 1));
}

function cellText(cell) {
  if (!cell) return '';
  if (cell.v == null) return '';
  return String(cell.f != null ? cell.f : cell.v).trim();
}

function splitKeywords(text) {
  return String(text || '')
    .split(/[,;|]/)
    .map((k) => k.trim())
    .filter(Boolean);
}

export async function loadLibraryFromSheet(sheetInput) {
  const sheetId = parseSheetId(sheetInput);
  if (!sheetId) throw new Error('That does not look like a Google Sheet URL or ID.');

  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:json&headers=1`;
  let res;
  try {
    res = await fetch(url);
  } catch {
    throw new Error('Could not reach Google Sheets (network error).');
  }
  if (!res.ok) {
    throw new Error(`Google Sheets returned ${res.status}. Is the sheet shared as "Anyone with the link can view"?`);
  }
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
  const colUp1 = findCol((l) => l.includes('upgrade') && /(1|a|one|left)\b/.test(l), 3);
  const colUp2 = findCol((l) => l.includes('upgrade') && /(2|b|two|right)\b/.test(l) && labels.indexOf(l) !== colUp1, -1);
  const colUp2Final = colUp2 >= 0 ? colUp2 : findCol((l, i) => l.includes('upgrade') && i !== colUp1, 4);

  const cards = [];
  for (const row of rows) {
    const c = row.c || [];
    const title = cellText(c[colTitle]);
    if (!title) continue;
    cards.push({
      title,
      description: cellText(c[colDesc]),
      keywords: splitKeywords(cellText(c[colKeywords])),
      upgrades: [cellText(c[colUp1]), cellText(c[colUp2Final])],
    });
  }
  if (!cards.length) {
    throw new Error('The sheet loaded, but no cards were found. Expected columns: Title, Description, Keywords, Upgrade 1, Upgrade 2.');
  }
  return cards;
}

// Built-in cards so the app is playable before a sheet is configured.
export const DEMO_CARDS = [
  { title: 'Spark', description: 'Deal a small jolt to any target.', keywords: ['Attack'], upgrades: ['Deal a bigger jolt.', 'Also draw a card.'] },
  { title: 'Slow Burn', description: 'Place this in your Delayed space. It smolders.', keywords: ['Delayed'], upgrades: ['Smolders twice as hot.', 'Returns to your hand afterwards.'] },
  { title: 'Reshuffle', description: 'Shuffle any deck of your choice.', keywords: ['Shuffle'], upgrades: ['Shuffle two decks.', 'Peek at the top card first.'] },
  { title: 'Barrier', description: 'Block the next thing that happens to you.', keywords: ['Defend'], upgrades: ['Block the next two things.', 'Reflect it instead.'] },
  { title: 'Pickpocket', description: 'Take a card from another player’s hand.', keywords: ['Steal'], upgrades: ['Take two cards.', 'They don’t get it back.'] },
  { title: 'Gift', description: 'Give a card from your hand to another player.', keywords: [], upgrades: ['Give two cards and draw one.', 'It counts double for them.'] },
  { title: 'Time Bomb', description: 'Delayed: after two of your turns, it goes off.', keywords: ['Delayed'], upgrades: ['Bigger boom.', 'You choose when it goes off.'] },
  { title: 'Mulligan', description: 'Discard your hand and draw the same number of cards.', keywords: ['Draw', 'Shuffle'], upgrades: ['Draw one extra card.', 'Shuffle your discard into your deck first.'] },
  { title: 'Scout', description: 'Look at the top three cards of any deck.', keywords: [], upgrades: ['Rearrange them.', 'Draw one of them.'] },
  { title: 'Echo', description: 'Copy the effect of the last card played.', keywords: [], upgrades: ['Copy it twice.', 'Copy any card in a discard pile.'] },
  { title: 'Anchor', description: 'A card in a Delayed space stays one turn longer.', keywords: ['Delayed'], upgrades: ['Two turns longer.', 'Move it to any other Delayed space.'] },
  { title: 'Windfall', description: 'Draw two cards.', keywords: ['Draw'], upgrades: ['Draw three cards.', 'Everyone else discards one.'] },
  { title: 'Trade Route', description: 'Swap a card with another player, hand to hand.', keywords: [], upgrades: ['Swap two cards.', 'You pick both cards.'] },
  { title: 'Graverobber', description: 'Take any card from any discard pile.', keywords: [], upgrades: ['Take two cards.', 'Put it straight into play (Delayed).'] },
  { title: 'Fog', description: 'Nothing can target you until your next turn.', keywords: ['Defend'], upgrades: ['Extends to a neighbor.', 'Lasts two turns.'] },
  { title: 'Overclock', description: 'Play an extra card this turn.', keywords: [], upgrades: ['Play two extra cards.', 'The extra card counts double.'] },
];
