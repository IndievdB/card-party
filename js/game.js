// Pure game-state model. The host owns one `state` object, applies actions to
// it, and broadcasts the whole thing to every client after each change.
//
// There are no game rules — the honor system reigns. Any player may move any
// card anywhere; only administrative actions (kick, return-all) are
// restricted to the host.

import { uid } from './store.js';

// The zone key stays 'deck' in the protocol; players see it as their "pool".
export const ZONES = ['deck', 'hand', 'discard', 'delayed'];
export const ZONE_LABELS = { deck: 'Pool', hand: 'Hand', discard: 'Discard', delayed: 'Delayed' };

// Upgrades are { text, sticker } — the sticker names the upgrade (a
// "Hamburger" sticker makes it the Hamburger upgrade). Older saved states
// and defs may still carry plain strings.
export function normalizeUpgrade(u) {
  if (u && typeof u === 'object') {
    return { text: String(u.text || '').slice(0, 1000), sticker: String(u.sticker || '').slice(0, 40) };
  }
  return { text: String(u || '').slice(0, 1000), sticker: '' };
}
// Card categories from the sheet's Category column. Each is styled
// distinctly on the card face.
export function normalizeCategory(c) {
  const s = String(c || '').toLowerCase();
  if (s.includes('death')) return 'death';
  if (s.includes('spirit')) return 'spirit';
  if (s.includes('base')) return 'base';
  return 'general';
}

// Every spirit guide gets its own color: the guide's name picks a hue from a
// curated palette, deterministically, so the color is stable everywhere and
// works for whatever guides the sheet defines.
const GUIDE_HUES = [265, 195, 150, 330, 20, 45, 285, 175, 95, 220];
export function guideHue(name) {
  const s = String(name || '').trim().toLowerCase();
  if (!s) return 215;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return GUIDE_HUES[h % GUIDE_HUES.length];
}

// Printed name of a card's category, including which spirit guide it serves.
export function categoryLabel(card) {
  const cat = normalizeCategory(card.category);
  if (cat === 'death') return 'Death';
  if (cat === 'spirit') return 'Spirit Guide' + (card.spiritGuide ? ' · ' + card.spiritGuide : '');
  if (cat === 'base') return 'Base';
  return 'General';
}

export const MAX_PLAYERS = 10;
export const MAX_BOARDS = 10;
export const MAX_NAME = 24;

// Players and boards are separate things. A PLAYER is a connected (or
// recently connected) person; a BOARD is a set of zones plus the cards it
// owns. A player possesses at most one board (player.boardId); a board
// survives its player leaving, and anyone may possess an abandoned board
// to play as them. Spectators are players with no board.
export function newState(roomCode) {
  return {
    schema: 2,
    roomCode,
    hostPlayerId: null,
    players: [],     // [{ playerId, name, connected, lastSeen, boardId|null }]
    boards: [],      // [{ boardId, name, createdBy, zones: {deck,hand,discard,delayed} }]
    cards: {},       // instanceId -> card instance (ownerId = boardId)
    version: 0,
  };
}

export function getPlayer(state, playerId) {
  return state.players.find((p) => p.playerId === playerId) || null;
}

export function getBoard(state, boardId) {
  return state.boards.find((b) => b.boardId === boardId) || null;
}

// The player currently possessing a board, if any.
export function playerOn(state, boardId) {
  return state.players.find((p) => p.boardId === boardId) || null;
}

// The board the player currently possesses, if any (spectators have none).
export function boardOf(state, playerId) {
  const p = getPlayer(state, playerId);
  return p && p.boardId ? getBoard(state, p.boardId) : null;
}

export function addPlayer(state, { playerId, name, isHost = false }) {
  const player = {
    playerId,
    name: cleanName(name),
    connected: true,
    lastSeen: Date.now(),
    boardId: null,
  };
  state.players.push(player);
  if (isHost) state.hostPlayerId = playerId;
  return player;
}

export const DEFAULT_ENERGY = 40;

export function addBoard(state, { boardId, name, createdBy = null }) {
  const board = {
    boardId: boardId || uid('b'),
    name: cleanName(name),
    createdBy,
    energy: DEFAULT_ENERGY,
    block: 0,
    momentum: 0,
    state: '', // optional board state, from the sheet's States tab
    zones: { deck: [], hand: [], discard: [], delayed: [] },
  };
  state.boards.push(board);
  return board;
}

// Older states (schema 1) had one merged `seats` list. Convert in place:
// each seat becomes a board (reusing playerId as boardId, so card ownerIds
// still match) possessed by a player of the same identity.
export function migrateState(state) {
  if (!state || typeof state !== 'object') return state;
  if (Array.isArray(state.seats)) {
    state.players = state.seats.map((s) => ({
      playerId: s.playerId,
      name: s.name,
      connected: !!s.connected,
      lastSeen: s.lastSeen || 0,
      boardId: s.playerId,
    }));
    state.boards = state.seats.map((s) => ({
      boardId: s.playerId,
      name: s.name,
      createdBy: s.playerId,
      zones: s.zones,
    }));
    delete state.seats;
    state.schema = 2;
  }
  // Boards stored before energy/block/momentum/state existed get defaults.
  for (const b of state.boards || []) {
    if (!Number.isFinite(b.energy)) b.energy = DEFAULT_ENERGY;
    if (!Number.isFinite(b.block)) b.block = 0;
    if (!Number.isFinite(b.momentum)) b.momentum = 0;
    if (typeof b.state !== 'string') b.state = '';
  }
  return state;
}

export function cleanName(name) {
  return String(name || 'Player').trim().slice(0, MAX_NAME) || 'Player';
}

// Turn deck definitions (from the deck builder) into card instances owned
// by a board. Ownership follows the board, not the person playing it.
export function makeCardInstances(state, board, defs) {
  const ids = [];
  for (const d of defs || []) {
    if (!d || !d.title) continue;
    const id = uid('c');
    state.cards[id] = {
      id,
      title: String(d.title).slice(0, 80),
      description: String(d.description || '').slice(0, 1000),
      keywords: Array.isArray(d.keywords) ? d.keywords.map(String).slice(0, 12) : [],
      category: normalizeCategory(d.category),
      spiritGuide: String(d.spiritGuide || '').slice(0, 60),
      upgrades: [normalizeUpgrade(d.upgrades?.[0]), normalizeUpgrade(d.upgrades?.[1])],
      upgrade: null, // null | 0 | 1 — which upgrade option is selected
      ownerId: board.boardId, // original owner board, never changes
      ownerName: board.name,
    };
    ids.push(id);
  }
  return ids;
}

// Pools hold at most one copy of each card: the titles (lowercased) a board
// already owns, wherever those cards currently sit on the table.
export function ownedTitles(state, boardId) {
  const titles = new Set();
  for (const card of Object.values(state.cards)) {
    if (card.ownerId === boardId) titles.add(String(card.title).toLowerCase());
  }
  return titles;
}

export function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function findCard(state, cardId) {
  for (const board of state.boards) {
    for (const zone of ZONES) {
      const index = board.zones[zone].indexOf(cardId);
      if (index >= 0) return { board, zone, index };
    }
  }
  return null;
}

function removeFromZones(state, cardId) {
  const loc = findCard(state, cardId);
  if (loc) loc.board.zones[loc.zone].splice(loc.index, 1);
  return loc;
}

// Rebuild a trustworthy state from a saved board file: unknown fields are
// dropped, every value re-normalized, zone entries deduped and checked
// against the card map, and orphan cards discarded. A save holds EVERY
// board, whether or not a player possesses it — loading with fewer players
// than boards simply leaves boards open for the taking. Older saves
// (schema 1, merged seats) are migrated first.
export function sanitizeLoadedState(rawIn) {
  const raw = migrateState(rawIn);
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.boards) || typeof raw.cards !== 'object' || raw.cards === null) {
    throw new Error('That is not a Card Party save file.');
  }
  const state = {
    schema: 2,
    roomCode: String(raw.roomCode || ''),
    hostPlayerId: raw.hostPlayerId ? String(raw.hostPlayerId) : null,
    players: [],
    boards: [],
    cards: {},
    version: 0,
  };
  for (const [id, c] of Object.entries(raw.cards)) {
    if (!c || !c.title) continue;
    state.cards[id] = {
      id,
      title: String(c.title).slice(0, 80),
      description: String(c.description || '').slice(0, 1000),
      keywords: Array.isArray(c.keywords) ? c.keywords.map(String).slice(0, 12) : [],
      category: normalizeCategory(c.category),
      spiritGuide: String(c.spiritGuide || '').slice(0, 60),
      upgrades: [normalizeUpgrade(c.upgrades?.[0]), normalizeUpgrade(c.upgrades?.[1])],
      upgrade: c.upgrade === 0 || c.upgrade === 1 ? c.upgrade : null,
      ownerId: String(c.ownerId || ''),
      ownerName: cleanName(c.ownerName),
    };
  }
  const placed = new Set();
  for (const b of raw.boards.slice(0, MAX_BOARDS)) {
    if (!b || !b.boardId) continue;
    const board = {
      boardId: String(b.boardId),
      name: cleanName(b.name),
      createdBy: b.createdBy ? String(b.createdBy) : null,
      energy: Number.isFinite(Number(b.energy)) ? Math.max(-9999, Math.min(9999, Math.round(Number(b.energy)))) : DEFAULT_ENERGY,
      block: Number.isFinite(Number(b.block)) ? Math.max(-9999, Math.min(9999, Math.round(Number(b.block)))) : 0,
      momentum: Number.isFinite(Number(b.momentum)) ? Math.max(-9999, Math.min(9999, Math.round(Number(b.momentum)))) : 0,
      state: typeof b.state === 'string' ? b.state.slice(0, 60) : '',
      zones: { deck: [], hand: [], discard: [], delayed: [] },
    };
    for (const zone of ZONES) {
      for (const id of (b.zones?.[zone] || [])) {
        if (state.cards[id] && !placed.has(id)) {
          board.zones[zone].push(id);
          placed.add(id);
        }
      }
    }
    state.boards.push(board);
  }
  if (!state.boards.length) throw new Error('The save file contains no boards.');
  for (const id of Object.keys(state.cards)) {
    if (!placed.has(id)) delete state.cards[id];
  }
  const claimed = new Set();
  for (const p of (Array.isArray(raw.players) ? raw.players : []).slice(0, MAX_PLAYERS)) {
    if (!p || !p.playerId) continue;
    let boardId = p.boardId ? String(p.boardId) : null;
    if (boardId && (claimed.has(boardId) || !state.boards.some((b) => b.boardId === boardId))) boardId = null;
    if (boardId) claimed.add(boardId);
    state.players.push({
      playerId: String(p.playerId),
      name: cleanName(p.name),
      connected: false,
      lastSeen: 0,
      boardId,
    });
  }
  return state;
}

// Applies one action from `actorId`. Mutates state. Returns {ok} or {ok:false, reason}.
export function applyAction(state, actorId, action) {
  const fail = (reason) => ({ ok: false, reason });
  const actor = getPlayer(state, actorId);
  if (!actor) return fail('You are not seated at this table.');
  if (!action || typeof action !== 'object') return fail('Malformed action.');
  const isHost = actorId === state.hostPlayerId;
  const myBoard = actor.boardId ? getBoard(state, actor.boardId) : null;

  switch (action.type) {
    case 'moveCard': {
      const { cardId, to } = action;
      if (!state.cards[cardId]) return fail('Unknown card.');
      const target = to && getBoard(state, to.boardId);
      if (!target || !ZONES.includes(to.zone)) return fail('Invalid destination.');
      removeFromZones(state, cardId);
      const arr = target.zones[to.zone];
      if (to.zone === 'deck' && to.pos === 'top') arr.unshift(cardId);
      else arr.push(cardId);
      break;
    }

    case 'draw': {
      if (!myBoard) return fail('You need a board to draw — claim or start one first.');
      const n = Math.max(1, Math.min(20, (action.n | 0) || 1));
      for (let i = 0; i < n; i++) {
        const cardId = myBoard.zones.deck.shift();
        if (!cardId) break;
        myBoard.zones.hand.push(cardId);
      }
      break;
    }

    case 'shuffle': {
      const target = action.boardId ? getBoard(state, action.boardId) : myBoard;
      if (!target) return fail('No such board.');
      const zone = ZONES.includes(action.zone) ? action.zone : 'deck';
      shuffle(target.zones[zone]);
      break;
    }

    // Anyone may adjust any board's numbers — same honor system as cards.
    case 'setStat': {
      const board = getBoard(state, action.boardId);
      if (!board) return fail('No such board.');
      if (!['energy', 'block', 'momentum'].includes(action.stat)) return fail('Unknown stat.');
      const n = Math.round(Number(action.value));
      if (!Number.isFinite(n)) return fail('That stat must be a number.');
      board[action.stat] = Math.max(-9999, Math.min(9999, n));
      break;
    }

    // Host admin: everyone's block back to 0 (e.g. at the start of a round).
    case 'resetBlock': {
      if (!isHost) return fail('Only the host can do that.');
      for (const board of state.boards) board.block = 0;
      break;
    }

    // A board's optional state, from the sheet's States tab (or '' = none).
    case 'setBoardState': {
      const board = getBoard(state, action.boardId);
      if (!board) return fail('No such board.');
      board.state = String(action.state || '').slice(0, 60);
      break;
    }

    case 'setUpgrade': {
      const card = state.cards[action.cardId];
      if (!card) return fail('Unknown card.');
      // Only one upgrade option may be selected at a time (or none).
      card.upgrade = action.choice === 0 || action.choice === 1 ? action.choice : null;
      break;
    }

    // Rename yourself — or, as the host, any player. Boards have their own
    // names (renameBoard); a player renaming themself leaves boards alone.
    case 'rename': {
      const targetId = action.playerId || actorId;
      if (targetId !== actorId && !isHost) return fail('Only the host can rename other players.');
      const target = getPlayer(state, targetId);
      if (!target) return fail('No such player.');
      target.name = cleanName(action.name);
      break;
    }

    // Rename a board — the one you possess, or (host only) any board. The
    // cards it owns follow the name.
    case 'renameBoard': {
      const board = getBoard(state, action.boardId);
      if (!board) return fail('No such board.');
      if (board.boardId !== actor.boardId && !isHost) return fail('Only the host can rename another board.');
      const name = cleanName(action.name);
      board.name = name;
      for (const card of Object.values(state.cards)) {
        if (card.ownerId === board.boardId) card.ownerName = name;
      }
      break;
    }

    // Shuffle newly chosen cards into a board's pool — your own board, or
    // (host only) any board. The cards belong to the board either way.
    // No repeats: a title the board already owns is skipped.
    case 'addCards': {
      const boardId = action.boardId || actor.boardId;
      if (boardId !== actor.boardId && !isHost) return fail('Only the host can add cards to another board’s pool.');
      const target = boardId && getBoard(state, boardId);
      if (!target) return fail('No such board.');
      if (!(action.deck || []).length) return fail('No cards to add.');
      const owned = ownedTitles(state, boardId);
      const defs = [];
      for (const d of action.deck) {
        const key = String(d?.title || '').toLowerCase();
        if (!key || owned.has(key)) continue;
        owned.add(key);
        defs.push(d);
      }
      const ids = makeCardInstances(state, target, defs);
      if (!ids.length) return fail('Those cards are already in the pool.');
      target.zones.deck.push(...ids);
      shuffle(target.zones.deck);
      break;
    }

    // Take possession of a board (play as its owner) — or, with boardId
    // null, release your board and become a spectator. The board and all
    // its cards stay on the table either way. A board can only be taken
    // over while nobody connected is playing it.
    case 'possessBoard': {
      const boardId = action.boardId == null ? null : String(action.boardId);
      if (boardId === null) {
        actor.boardId = null;
        break;
      }
      const board = getBoard(state, boardId);
      if (!board) return fail('No such board.');
      const holder = state.players.find((p) => p.boardId === boardId && p.playerId !== actorId);
      if (holder && holder.connected) return fail(`${holder.name} is playing that board.`);
      if (holder) holder.boardId = null;
      actor.boardId = boardId;
      break;
    }

    // Start a fresh board seeded with the provided starter cards (the Base
    // cards) and possess it — a board you were playing stays on the table,
    // open for someone else. With possess:false (host only) the board is
    // added open instead, e.g. an extra board set up in advance.
    case 'newBoard': {
      if (state.boards.length >= MAX_BOARDS) return fail(`All ${MAX_BOARDS} board slots are in use.`);
      const possess = action.possess !== false;
      if (!possess && !isHost) return fail('Only the host can add a board without playing it.');
      const board = addBoard(state, {
        name: action.name ? cleanName(action.name) : actor.name,
        createdBy: possess ? actorId : null,
      });
      board.zones.deck = shuffle(makeCardInstances(state, board, action.deck || []));
      if (possess) actor.boardId = board.boardId;
      break;
    }

    // Host admin: refresh the printed text of every card already in play from
    // the latest library, matched by title. Locations, owners, and chosen
    // upgrades stay exactly as they are — nothing leaves the table.
    case 'updateCardTexts': {
      if (!isHost) return fail('Only the host can do that.');
      const byTitle = new Map();
      for (const d of action.defs || []) {
        if (d && d.title && !byTitle.has(String(d.title))) byTitle.set(String(d.title), d);
      }
      if (!byTitle.size) return fail('No card definitions to apply.');
      for (const card of Object.values(state.cards)) {
        const d = byTitle.get(card.title);
        if (!d) continue; // card no longer in the sheet — leave it as printed
        card.description = String(d.description || '').slice(0, 1000);
        card.keywords = Array.isArray(d.keywords) ? d.keywords.map(String).slice(0, 12) : [];
        card.upgrades = [normalizeUpgrade(d.upgrades?.[0]), normalizeUpgrade(d.upgrades?.[1])];
      }
      break;
    }

    // Host admin: every card returns to its owner board's deck; decks shuffled.
    case 'returnAll': {
      if (!isHost) return fail('Only the host can do that.');
      for (const board of state.boards) for (const zone of ZONES) board.zones[zone] = [];
      for (const card of Object.values(state.cards)) {
        const owner = getBoard(state, card.ownerId);
        if (owner) owner.zones.deck.push(card.id);
        else delete state.cards[card.id];
      }
      for (const board of state.boards) shuffle(board.zones.deck);
      break;
    }

    // Host admin: remove a player from the room. Their board and every card
    // on it stay on the table, open for anyone to possess.
    case 'kick': {
      if (!isHost) return fail('Only the host can do that.');
      const pid = action.playerId;
      if (pid === state.hostPlayerId) return fail('The host cannot be kicked.');
      const player = getPlayer(state, pid);
      if (!player) return fail('No such player.');
      state.players = state.players.filter((p) => p !== player);
      break;
    }

    // Host admin: delete a board. Its own cards vanish with it; cards other
    // boards own that were sitting in its zones go to those boards' discard.
    case 'removeBoard': {
      if (!isHost) return fail('Only the host can do that.');
      const board = getBoard(state, action.boardId);
      if (!board) return fail('No such board.');
      const bid = board.boardId;
      for (const zone of ZONES) {
        for (const id of board.zones[zone]) {
          const card = state.cards[id];
          if (!card) continue;
          if (card.ownerId === bid) {
            delete state.cards[id];
          } else {
            const owner = getBoard(state, card.ownerId);
            if (owner) owner.zones.discard.push(id);
            else delete state.cards[id];
          }
        }
      }
      for (const other of state.boards) {
        if (other === board) continue;
        for (const zone of ZONES) {
          other.zones[zone] = other.zones[zone].filter((id) => state.cards[id]?.ownerId !== bid);
        }
      }
      for (const id of Object.keys(state.cards)) {
        if (state.cards[id].ownerId === bid) delete state.cards[id];
      }
      state.boards = state.boards.filter((b) => b !== board);
      for (const p of state.players) {
        if (p.boardId === bid) p.boardId = null;
      }
      break;
    }

    default:
      return fail('Unknown action: ' + action.type);
  }

  state.version++;
  return { ok: true };
}
