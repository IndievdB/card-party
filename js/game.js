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
export const MAX_NAME = 24;

export function newState(roomCode) {
  return {
    schema: 1,
    roomCode,
    hostPlayerId: null,
    seats: [],       // [{ playerId, name, connected, lastSeen, zones: {deck,hand,discard,delayed} }]
    cards: {},       // instanceId -> card instance
    version: 0,
  };
}

export function getSeat(state, playerId) {
  return state.seats.find((s) => s.playerId === playerId) || null;
}

export function addSeat(state, { playerId, name, isHost = false }) {
  const seat = {
    playerId,
    name: cleanName(name),
    connected: true,
    lastSeen: Date.now(),
    zones: { deck: [], hand: [], discard: [], delayed: [] },
  };
  state.seats.push(seat);
  if (isHost) state.hostPlayerId = playerId;
  return seat;
}

export function cleanName(name) {
  return String(name || 'Player').trim().slice(0, MAX_NAME) || 'Player';
}

// Turn deck definitions (from the deck builder) into owned card instances.
export function makeCardInstances(state, seat, defs) {
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
      ownerId: seat.playerId, // original owner, never changes
      ownerName: seat.name,
    };
    ids.push(id);
  }
  return ids;
}

export function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function findCard(state, cardId) {
  for (const seat of state.seats) {
    for (const zone of ZONES) {
      const index = seat.zones[zone].indexOf(cardId);
      if (index >= 0) return { seat, zone, index };
    }
  }
  return null;
}

function removeFromZones(state, cardId) {
  const loc = findCard(state, cardId);
  if (loc) loc.seat.zones[loc.zone].splice(loc.index, 1);
  return loc;
}

// Rebuild a trustworthy state from a saved board file: unknown fields are
// dropped, every value re-normalized, zone entries deduped and checked
// against the card map, and orphan cards discarded.
export function sanitizeLoadedState(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.seats) || typeof raw.cards !== 'object' || raw.cards === null) {
    throw new Error('That is not a Card Party save file.');
  }
  const state = {
    schema: 1,
    roomCode: String(raw.roomCode || ''),
    hostPlayerId: raw.hostPlayerId ? String(raw.hostPlayerId) : null,
    seats: [],
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
  for (const s of raw.seats.slice(0, MAX_PLAYERS)) {
    if (!s || !s.playerId) continue;
    const seat = {
      playerId: String(s.playerId),
      name: cleanName(s.name),
      connected: false,
      lastSeen: 0,
      zones: { deck: [], hand: [], discard: [], delayed: [] },
    };
    for (const zone of ZONES) {
      for (const id of (s.zones?.[zone] || [])) {
        if (state.cards[id] && !placed.has(id)) {
          seat.zones[zone].push(id);
          placed.add(id);
        }
      }
    }
    state.seats.push(seat);
  }
  if (!state.seats.length) throw new Error('The save file contains no players.');
  for (const id of Object.keys(state.cards)) {
    if (!placed.has(id)) delete state.cards[id];
  }
  return state;
}

// Applies one action from `actorId`. Mutates state. Returns {ok} or {ok:false, reason}.
export function applyAction(state, actorId, action) {
  const fail = (reason) => ({ ok: false, reason });
  const actor = getSeat(state, actorId);
  if (!actor) return fail('You are not seated at this table.');
  if (!action || typeof action !== 'object') return fail('Malformed action.');
  const isHost = actorId === state.hostPlayerId;

  switch (action.type) {
    case 'moveCard': {
      const { cardId, to } = action;
      if (!state.cards[cardId]) return fail('Unknown card.');
      const target = to && getSeat(state, to.playerId);
      if (!target || !ZONES.includes(to.zone)) return fail('Invalid destination.');
      removeFromZones(state, cardId);
      const arr = target.zones[to.zone];
      if (to.zone === 'deck' && to.pos === 'top') arr.unshift(cardId);
      else arr.push(cardId);
      break;
    }

    case 'draw': {
      const n = Math.max(1, Math.min(20, (action.n | 0) || 1));
      for (let i = 0; i < n; i++) {
        const cardId = actor.zones.deck.shift();
        if (!cardId) break;
        actor.zones.hand.push(cardId);
      }
      break;
    }

    case 'shuffle': {
      const target = getSeat(state, action.playerId || actorId);
      if (!target) return fail('No such player.');
      const zone = ZONES.includes(action.zone) ? action.zone : 'deck';
      shuffle(target.zones[zone]);
      break;
    }

    case 'setUpgrade': {
      const card = state.cards[action.cardId];
      if (!card) return fail('Unknown card.');
      // Only one upgrade option may be selected at a time (or none).
      card.upgrade = action.choice === 0 || action.choice === 1 ? action.choice : null;
      break;
    }

    // Rename yourself — or, as the host, any player.
    case 'rename': {
      const targetId = action.playerId || actorId;
      if (targetId !== actorId && !isHost) return fail('Only the host can rename other players.');
      const target = getSeat(state, targetId);
      if (!target) return fail('No such player.');
      const name = cleanName(action.name);
      target.name = name;
      for (const card of Object.values(state.cards)) {
        if (card.ownerId === targetId) card.ownerName = name;
      }
      break;
    }

    // Shuffle newly chosen cards into a pool — your own, or (host only)
    // any player's. The cards belong to the pool's owner either way.
    case 'addCards': {
      const targetId = action.playerId || actorId;
      if (targetId !== actorId && !isHost) return fail('Only the host can add cards to another player’s pool.');
      const target = getSeat(state, targetId);
      if (!target) return fail('No such player.');
      const ids = makeCardInstances(state, target, action.deck || []);
      if (!ids.length) return fail('No cards to add.');
      target.zones.deck.push(...ids);
      shuffle(target.zones.deck);
      break;
    }

    // Replace every card the actor owns (wherever it is) with a fresh shuffled deck.
    case 'resetMyCards': {
      for (const seat of state.seats) {
        for (const zone of ZONES) {
          seat.zones[zone] = seat.zones[zone].filter((id) => state.cards[id]?.ownerId !== actorId);
        }
      }
      for (const id of Object.keys(state.cards)) {
        if (state.cards[id].ownerId === actorId) delete state.cards[id];
      }
      const ids = makeCardInstances(state, actor, action.deck || []);
      actor.zones.deck = shuffle(ids);
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

    // Host admin: every card returns to its original owner's deck; decks shuffled.
    case 'returnAll': {
      if (!isHost) return fail('Only the host can do that.');
      for (const seat of state.seats) for (const zone of ZONES) seat.zones[zone] = [];
      for (const card of Object.values(state.cards)) {
        const owner = getSeat(state, card.ownerId);
        if (owner) owner.zones.deck.push(card.id);
        else delete state.cards[card.id];
      }
      for (const seat of state.seats) shuffle(seat.zones.deck);
      break;
    }

    // Host admin: remove a player. Their own cards vanish with them; cards other
    // players own that were sitting in their zones go to those owners' discard.
    case 'kick': {
      if (!isHost) return fail('Only the host can do that.');
      const pid = action.playerId;
      if (pid === state.hostPlayerId) return fail('The host cannot be kicked.');
      const seat = getSeat(state, pid);
      if (!seat) return fail('No such player.');
      for (const zone of ZONES) {
        for (const id of seat.zones[zone]) {
          const card = state.cards[id];
          if (!card) continue;
          if (card.ownerId === pid) {
            delete state.cards[id];
          } else {
            const owner = getSeat(state, card.ownerId);
            if (owner) owner.zones.discard.push(id);
            else delete state.cards[id];
          }
        }
      }
      for (const other of state.seats) {
        if (other === seat) continue;
        for (const zone of ZONES) {
          other.zones[zone] = other.zones[zone].filter((id) => state.cards[id]?.ownerId !== pid);
        }
      }
      for (const id of Object.keys(state.cards)) {
        if (state.cards[id].ownerId === pid) delete state.cards[id];
      }
      state.seats = state.seats.filter((s) => s !== seat);
      break;
    }

    default:
      return fail('Unknown action: ' + action.type);
  }

  state.version++;
  return { ok: true };
}
