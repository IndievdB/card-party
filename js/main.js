// App wiring: views, sessions (host/client), and the game context.

import { store, getIdentity, saveIdentity } from './store.js';
import { newState, addSeat, makeCardInstances, shuffle, cleanName } from './game.js';
import { HostSession, ClientSession, randomCode, normalizeCode, peerAvailable } from './net.js';
import { renderGame, refreshModal, openModal, closeModal, toast, el } from './ui.js';
import { initDeckView, getCurrentDeckDefs, getCurrentDeckName, getSavedDecks, randomDeckFromLibrary, getLibrary } from './deckui.js';

let session = null; // HostSession | ClientSession
let latestState = null;
let clientStatus = 'connecting';

const views = ['home', 'decks', 'game'];

function showView(name) {
  for (const v of views) {
    document.getElementById('view-' + v).classList.toggle('hidden', v !== name);
  }
  document.querySelectorAll('[data-nav]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.nav === name);
  });
  if (name === 'home') renderHome();
}

// ---------- identity ----------

function requireName() {
  const identity = getIdentity();
  const input = document.getElementById('player-name');
  const name = cleanName(input.value || identity.name);
  if (!input.value.trim() && !identity.name) {
    toast('Pick a name first', 'warn');
    input.focus();
    return null;
  }
  identity.name = name;
  saveIdentity(identity);
  return identity;
}

// ---------- game context passed to the renderer ----------

function gameCtx() {
  const identity = getIdentity();
  return {
    myId: identity.playerId,
    isHost: session?.role === 'host',
    status: session?.role === 'host' ? 'connected' : clientStatus,
    dispatch,
    kick: (playerId, block) => {
      if (session?.role === 'host') {
        const res = session.kick(playerId, block);
        if (!res.ok) toast(res.reason, 'warn');
      }
    },
    renameSelf: () => {
      const identity = getIdentity();
      const name = prompt('Your name:', identity.name);
      if (name == null) return;
      const clean = cleanName(name);
      identity.name = clean;
      saveIdentity(identity);
      dispatch({ type: 'rename', name: clean });
    },
    openLoadDeck: () => openModal('loadDeck', { render: renderLoadDeckModal }),
    leave: leaveGame,
  };
}

function dispatch(action) {
  if (!session) return;
  const res = session.dispatch(action);
  if (!res.ok) toast(res.reason, 'warn');
}

function onState(state) {
  latestState = state;
  renderGame(document.getElementById('game-root'), state, gameCtx());
  refreshModal();
}

function rerender() {
  if (latestState) onState(latestState);
}

// ---------- load-deck modal (mid-game deck swap) ----------

function renderLoadDeckModal() {
  const wrap = el('div', {},
    el('p', { class: 'hint', text: 'Loading a deck removes every card you own from the table and gives you a fresh shuffled deck. Cards other people put in your zones stay put.' }),
  );
  const decks = getSavedDecks();
  const names = Object.keys(decks);
  for (const name of names) {
    wrap.append(el('button', {
      class: 'btn wide', text: `${name} (${decks[name].cards.length} cards)`,
      onClick: () => {
        dispatch({ type: 'resetMyCards', deck: decks[name].cards });
        closeModal();
        toast(`Loaded “${name}”`);
      },
    }));
  }
  if (!names.length) wrap.append(el('p', { class: 'empty', text: 'No saved decks yet — build one on the Decks screen.' }));
  wrap.append(el('button', {
    class: 'btn wide', text: `🎲 Random 20 from library (${getLibrary().length} cards)`,
    onClick: () => {
      dispatch({ type: 'resetMyCards', deck: randomDeckFromLibrary(20) });
      closeModal();
      toast('Loaded a random deck');
    },
  }));
  return wrap;
}

// ---------- hosting ----------

async function hostGame({ restore = false } = {}) {
  if (!peerAvailable()) return toast('PeerJS failed to load — check your connection and refresh.', 'warn');
  const identity = requireName();
  if (!identity) return;

  let code, state;
  if (restore) {
    const last = store.get('lastRoom');
    code = last?.code;
    state = code && store.get('hostState.' + code);
    if (!state) return toast('No saved room to restore.', 'warn');
    // Everyone shows as disconnected until they reconnect.
    for (const seat of state.seats) {
      seat.connected = seat.playerId === identity.playerId;
    }
    const mySeat = state.seats.find((s) => s.playerId === identity.playerId);
    if (mySeat) state.hostPlayerId = identity.playerId;
  } else {
    code = randomCode();
    state = newState(code);
    const seat = addSeat(state, { playerId: identity.playerId, name: identity.name, isHost: true });
    const deckDefs = getCurrentDeckDefs();
    seat.zones.deck = shuffle(makeCardInstances(state, seat, deckDefs));
  }

  const host = new HostSession({
    code,
    state,
    onChange: (st) => {
      store.set('hostState.' + code, st);
      onState(st);
    },
    onPeerError: (err) => toast('Network hiccup: ' + (err.type || err.message), 'warn'),
  });

  setBusy(true);
  for (let attempt = 0; ; attempt++) {
    try {
      await host.start();
      break;
    } catch (err) {
      if (err?.type === 'unavailable-id') {
        if (restore) {
          setBusy(false);
          host.destroy();
          return toast('That room code is still registered with the signaling server. Wait a minute and try again.', 'warn');
        }
        if (attempt < 3) {
          // Rare code collision — pick a new code and retry.
          host.destroy();
          code = randomCode();
          state.roomCode = code;
          host.code = code;
          continue;
        }
      }
      setBusy(false);
      host.destroy();
      return toast('Could not start the room: ' + (err.type || err.message || err), 'warn');
    }
  }
  setBusy(false);

  session = host;
  store.set('lastRoom', { code, role: 'host' });
  store.set('hostState.' + code, state);
  showView('game');
  onState(state);
  if (!restore && !getCurrentDeckDefs().length) {
    toast('You joined with an empty deck — use “Load deck” to grab one.', 'warn');
  }
}

// ---------- joining ----------

function joinGame(codeInput) {
  if (!peerAvailable()) return toast('PeerJS failed to load — check your connection and refresh.', 'warn');
  const identity = requireName();
  if (!identity) return;
  const code = normalizeCode(codeInput);
  if (code.length < 4) return toast('Enter the room code.', 'warn');

  clientStatus = 'connecting';
  const client = new ClientSession({
    code,
    identity,
    deck: getCurrentDeckDefs(),
    handlers: {
      onState,
      onStatus: (status) => {
        clientStatus = status;
        rerender();
        updateConnBanner();
      },
      onDenied: (reason) => toast(reason, 'warn'),
      onKicked: () => {
        endSession();
        store.del('lastRoom');
        showView('home');
        alert('You were removed from the room by the host.');
      },
      onFail: (reason) => {
        endSession();
        showView('home');
        toast(reason, 'warn');
      },
    },
  });
  session = client;
  client.connect();
  store.set('lastRoom', { code, role: 'client' });
  showView('game');
  renderConnecting(code);
}

function renderConnecting(code) {
  const root = document.getElementById('game-root');
  root.replaceChildren(el('div', { class: 'connecting' },
    el('div', { class: 'spinner' }),
    el('p', { text: `Connecting to room ${code}…` }),
    el('button', { class: 'btn', text: 'Cancel', onClick: leaveGame }),
  ));
}

function updateConnBanner() {
  const banner = document.getElementById('conn-banner');
  const show = session?.role === 'client' && session.everConnected && clientStatus !== 'connected';
  banner.classList.toggle('hidden', !show);
}

// ---------- leaving ----------

function endSession() {
  if (session) {
    session.destroy();
    session = null;
  }
  latestState = null;
  closeModal();
  document.getElementById('conn-banner').classList.add('hidden');
}

function leaveGame() {
  if (session?.role === 'host') {
    if (!confirm('Close the room? Players will be disconnected, but you can restore this room later from the home screen.')) return;
  } else {
    store.del('lastRoom');
  }
  endSession();
  showView('home');
}

// ---------- home screen ----------

function renderHome() {
  const identity = getIdentity();
  document.getElementById('player-name').value = identity.name;

  const deckNote = document.getElementById('home-deck-note');
  const deckName = getCurrentDeckName();
  const defs = getCurrentDeckDefs();
  deckNote.textContent = deckName
    ? `Active deck: “${deckName}” (${defs.length} cards)`
    : 'No active deck yet — build one, or join and pick a random deck later.';

  const last = store.get('lastRoom');
  const rejoinBox = document.getElementById('rejoin-box');
  rejoinBox.replaceChildren();
  if (last?.code) {
    if (last.role === 'client') {
      rejoinBox.append(el('button', {
        class: 'btn wide', text: `↻ Rejoin room ${last.code} (your seat & cards are waiting)`,
        onClick: () => joinGame(last.code),
      }));
    } else if (store.get('hostState.' + last.code)) {
      rejoinBox.append(el('button', {
        class: 'btn wide', text: `↻ Restore your room ${last.code} as host`,
        onClick: () => hostGame({ restore: true }),
      }));
    }
  }
}

function setBusy(busy) {
  document.getElementById('btn-host').disabled = busy;
  document.getElementById('btn-join').disabled = busy;
}

// ---------- boot ----------

function init() {
  // Navigating away from the table keeps the session alive (browse decks mid-game).
  document.querySelectorAll('[data-nav]').forEach((btn) => {
    btn.addEventListener('click', () => showView(btn.dataset.nav));
  });
  document.getElementById('nav-game').classList.add('hidden');

  document.getElementById('btn-host').addEventListener('click', () => hostGame());
  document.getElementById('btn-join').addEventListener('click', () => joinGame(document.getElementById('join-code').value));
  document.getElementById('join-code').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinGame(e.target.value);
  });
  document.getElementById('player-name').addEventListener('change', (e) => {
    const identity = getIdentity();
    identity.name = cleanName(e.target.value);
    saveIdentity(identity);
  });

  window.addEventListener('beforeunload', () => {
    // Host state is persisted on every change already; just close cleanly.
    if (session) session.destroy();
  });

  initDeckView();
  showView('home');

  // Keep the game nav tab in sync.
  setInterval(() => {
    document.getElementById('nav-game').classList.toggle('hidden', !session);
  }, 500);
}

init();
