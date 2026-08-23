// Pure game-state model. The host owns one `state` object, applies actions to
// it, and broadcasts the whole thing to every client after each change.
//
// There are no game rules — the honor system reigns. Any player may move any
// card anywhere; only administrative actions (kick, block, return-all) are
// restricted to the host.

import { uid } from './store.js';

export const ZONES = ['deck', 'hand', 'discard', 'delayed'];
export const ZONE_LABELS = { deck: 'Deck', hand: 'Hand', discard: 'Discard', delayed: 'Delayed' };
export const MAX_PLAYERS = 10;
export const MAX_NAME = 24;

export function newState(roomCode) {
  return {
    schema: 1,
    roomCode,
    hostPlayerId: null,
    seats: [],       // [{ playerId, name, connected, lastSeen, zones: {deck,hand,discard,delayed} }]
    cards: {},       // instanceId -> card instance
    blocked: [],     // [{ playerId, name }]
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
      upgrades: [String(d.upgrades?.[0] || '').slice(0, 1000), String(d.upgrades?.[1] || '').slice(0, 1000)],
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

    case 'rename': {
      const name = cleanName(action.name);
      actor.name = name;
      for (const card of Object.values(state.cards)) {
        if (card.ownerId === actorId) card.ownerName = name;
      }
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
      if (action.block && !state.blocked.some((b) => b.playerId === pid)) {
        state.blocked.push({ playerId: pid, name: seat.name });
      }
      break;
    }

    case 'unblock': {
      if (!isHost) return fail('Only the host can do that.');
      state.blocked = state.blocked.filter((b) => b.playerId !== action.playerId);
      break;
    }

    default:
      return fail('Unknown action: ' + action.type);
  }

  state.version++;
  return { ok: true };
}
