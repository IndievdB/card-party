// App wiring: views, sessions (host/client), library loading, and the game context.

import { store, getIdentity, saveIdentity } from './store.js';
import { newState, addPlayer, getPlayer, migrateState, cleanName, sanitizeLoadedState, normalizeCategory, ownedTitles } from './game.js';
import { HostSession, ClientSession, randomCode, normalizeCode, peerAvailable } from './net.js';
import { renderGame, refreshModal, openModal, closeModal, toast, el, setKeywordDefs, uiPrompt, uiConfirm, uiAlert } from './ui.js';
import { loadLibrary } from './sheet.js';
import { configureBuilder, poolToolsNode } from './builder.js';

let session = null; // HostSession | ClientSession
let latestState = null;
let clientStatus = 'connecting';

// The one shared card library (hardcoded sheet). Loaded at startup.
let library = [];
let boardStates = []; // [{ name, desc }] from the sheet's States tab
let libraryReady = Promise.resolve();

// Base cards start in everyone's pool by default.
function baseDefs() {
  return library.filter((c) => normalizeCategory(c.category) === 'base');
}

async function loadLibraryNow() {
  try {
    const { cards, keywords, states, source } = await loadLibrary();
    library = cards;
    boardStates = Array.isArray(states) ? states : [];
    setKeywordDefs(keywords);
    if (source === 'cache') {
      toast('Card sheet unreachable — using the last downloaded card list.', 'warn');
    }
    // The pool modal may already be open showing "library not loaded".
    refreshModal();
    return source;
  } catch (err) {
    toast('Could not load the card library: ' + (err.message || err), 'warn');
    return null;
  }
}

// "Last room" is remembered per identity, so each tab (= each player) gets
// its own rejoin/restore offer.
function lastRoomKey() {
  return 'lastRoom.' + getIdentity().playerId;
}

const views = ['home', 'game'];

function showView(name) {
  for (const v of views) {
    document.getElementById('view-' + v).classList.toggle('hidden', v !== name);
  }
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
  const me = latestState ? getPlayer(latestState, identity.playerId) : null;
  return {
    myId: identity.playerId,
    myBoardId: me?.boardId || null,
    isHost: session?.role === 'host',
    stateDefs: () => boardStates,
    // Spectators (or players whose board was taken) start a fresh board.
    // Wait for the library so the Base cards are known to seed it with.
    // The host is the table's organizer: boards they create arrive OPEN
    // (named via prompt, not possessed) — they claim one explicitly.
    newBoard: async () => {
      const hosting = session?.role === 'host';
      let name;
      if (hosting) {
        name = await uiPrompt('Name for the new board', 'Board ' + ((latestState?.boards.length || 0) + 1), 'Add board');
        if (name == null || !name.trim()) return;
      }
      await libraryReady;
      dispatch({ type: 'newBoard', deck: baseDefs(), possess: !hosting, name });
    },
    // Host admin: set up an extra open board without leaving your own.
    addBoard: async (name) => {
      await libraryReady;
      dispatch({ type: 'newBoard', deck: baseDefs(), possess: false, name });
    },
    status: session?.role === 'host' ? 'connected' : clientStatus,
    dispatch,
    kick: (playerId) => {
      if (session?.role === 'host') {
        const res = session.kick(playerId);
        if (!res.ok) toast(res.reason, 'warn');
      }
    },
    renameSelf: async () => {
      const identity = getIdentity();
      const name = await uiPrompt('Your name', identity.name, 'Rename');
      if (name == null || !name.trim()) return;
      const clean = cleanName(name);
      identity.name = clean;
      saveIdentity(identity);
      dispatch({ type: 'rename', name: clean });
    },
    poolTools: poolToolsNode,
    // Host admin: re-fetch the sheet and refresh the text of every card
    // already in play — hands and boards stay exactly as they are.
    reloadSheet: async () => {
      const source = await loadLibraryNow();
      if (!library.length) return toast('The card library is empty — nothing to apply.', 'warn');
      dispatch({ type: 'updateCardTexts', defs: library });
      if (session?.role === 'host') session.broadcastReload?.();
      if (source === 'live') toast('Cards reloaded from the sheet — in-play cards updated.');
      else toast('Sheet unreachable — applied the cached card list to in-play cards.', 'warn');
    },
    // Host admin: save the whole game to a file — every board and player,
    // every card and where it sits. The card library isn't part of a save:
    // it always comes live from the sheet, and it's fine if it has changed
    // between sessions (in-play cards carry their printed text anyway).
    saveGame: () => {
      if (!latestState) return;
      const save = {
        app: 'card-party',
        kind: 'save',
        savedAt: new Date().toISOString(),
        state: latestState,
      };
      const blob = new Blob([JSON.stringify(save, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `card-party-${latestState.roomCode}-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      toast('Game saved to file');
    },
    loadGame: async (file) => {
      if (session?.role !== 'host') return toast('Only the host can load a game.', 'warn');
      try {
        const raw = JSON.parse(await file.text());
        // Save envelope, or a bare state from an older save file.
        const isEnvelope = raw && typeof raw === 'object' && raw.app === 'card-party' && raw.state;
        const cleaned = sanitizeLoadedState(isEnvelope ? raw.state : raw);
        session.loadState(cleaned);
        closeModal();
        toast('Game loaded — players rejoin to reclaim their seats.');
      } catch (err) {
        toast('Could not load the save: ' + (err.message || err), 'warn');
      }
    },
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

// ---------- hosting ----------

async function hostGame({ restore = false } = {}) {
  if (!peerAvailable()) return toast('PeerJS failed to load — check your connection and refresh.', 'warn');
  const identity = requireName();
  if (!identity) return;

  let code, state;
  if (restore) {
    const last = store.get(lastRoomKey());
    code = last?.code;
    state = code && store.get('hostState.' + code);
    if (!state) return toast('No saved room to restore.', 'warn');
    if (state.hostPlayerId !== identity.playerId) {
      return toast('That room was hosted by a different player in this browser.', 'warn');
    }
    migrateState(state); // rooms saved before players/boards split
    // Everyone shows as disconnected until they reconnect.
    for (const player of state.players) {
      player.connected = player.playerId === identity.playerId;
    }
  } else {
    code = randomCode();
    state = newState(code);
    // The host, like everyone else, arrives boardless and chooses at the
    // table: spectate, claim an open board, or start their own.
    addPlayer(state, { playerId: identity.playerId, name: identity.name, isHost: true });
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
  store.set(lastRoomKey(), { code, role: 'host' });
  store.set('hostState.' + code, state);
  showView('game');
  onState(state);
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
    handlers: {
      onState,
      onStatus: (status) => {
        clientStatus = status;
        rerender();
        updateConnBanner();
      },
      onDenied: (reason) => toast(reason, 'warn'),
      onReloadLibrary: async () => {
        await loadLibraryNow();
        toast('Card list refreshed from the sheet.');
      },
      onKicked: () => {
        endSession();
        store.del(lastRoomKey());
        showView('home');
        uiAlert('You were removed from the room by the host.');
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
  store.set(lastRoomKey(), { code, role: 'client' });
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

async function leaveGame() {
  if (session?.role === 'host') {
    const ok = await uiConfirm('Players will be disconnected, but you can restore this room later from the home screen.', { title: 'Close the room?', okText: 'Close room', danger: true });
    if (!ok) return;
  } else {
    store.del(lastRoomKey());
  }
  endSession();
  showView('home');
}

// ---------- home screen ----------

function renderHome() {
  const identity = getIdentity();
  document.getElementById('player-name').value = identity.name;

  const last = store.get(lastRoomKey());
  const rejoinBox = document.getElementById('rejoin-box');
  rejoinBox.replaceChildren();
  let offered = false;
  if (last?.code) {
    if (last.role === 'client') {
      rejoinBox.append(el('button', {
        class: 'btn big-btn wide-btn', text: `Rejoin room ${last.code}`,
        title: 'Your seat and cards are waiting',
        onClick: () => joinGame(last.code),
      }));
      offered = true;
    } else {
      const saved = store.get('hostState.' + last.code);
      if (saved && saved.hostPlayerId === identity.playerId) {
        rejoinBox.append(el('button', {
          class: 'btn big-btn wide-btn', text: `Restore room ${last.code}`,
          title: 'Reopen your room as host — players reconnect automatically',
          onClick: () => hostGame({ restore: true }),
        }));
        offered = true;
      }
    }
  }
  if (!offered) rejoinBox.append(el('p', { class: 'hint', text: 'No recent room.' }));
}

function setBusy(busy) {
  document.getElementById('btn-host').disabled = busy;
  document.getElementById('btn-join').disabled = busy;
}

// ---------- boot ----------

function init() {
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
    if (session) session.destroy();
  });

  configureBuilder({
    getLibrary: () => library,
    retryLoad: loadLibraryNow,
    // Pools hold one copy of each card — the builder greys out and never
    // offers titles the target board already owns.
    owned: (boardId) => (latestState ? ownedTitles(latestState, boardId) : new Set()),
    add: (defs, targetBoardId) => {
      dispatch({ type: 'addCards', deck: defs, boardId: targetBoardId });
      toast(`Shuffled ${defs.length} card${defs.length === 1 ? '' : 's'} into the pool`);
    },
  });

  libraryReady = loadLibraryNow();
  showView('home');

  // Invite links (https://<site>/<CODE>) arrive as ?room=CODE via 404.html.
  const roomParam = new URLSearchParams(location.search).get('room');
  if (roomParam) {
    history.replaceState({}, '', location.pathname);
    const code = normalizeCode(roomParam);
    if (code.length >= 4) {
      if (getIdentity().name) {
        joinGame(code);
      } else {
        document.getElementById('join-code').value = code;
        document.getElementById('player-name').focus();
        toast(`Pick a name, then hit Join to enter room ${code}`);
      }
    }
  }
}

init();
