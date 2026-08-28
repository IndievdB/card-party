// P2P networking on top of PeerJS (WebRTC data channels, free public
// signaling server). Star topology: the host is authoritative. Clients send
// actions; the host applies them and broadcasts the full state.
//
// Reconnection: player identity (playerId) persists in localStorage, so a
// returning player automatically repossesses their original seat, cards and
// zones. The host also persists room state, so a host who closes the tab can
// restore the room under the same code.

import { applyAction, addSeat, getSeat, makeCardInstances, shuffle, cleanName, MAX_PLAYERS } from './game.js';
import { store } from './store.js';

const PEER_PREFIX = 'card-party-v1-';
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L

export function randomCode(len = 5) {
  let code = '';
  const rand = new Uint32Array(len);
  (globalThis.crypto || {}).getRandomValues?.(rand);
  for (let i = 0; i < len; i++) {
    const r = rand[i] != null ? rand[i] : Math.floor(Math.random() * 1e9);
    code += CODE_CHARS[r % CODE_CHARS.length];
  }
  return code;
}

export function normalizeCode(input) {
  return String(input || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function peerAvailable() {
  return typeof Peer !== 'undefined';
}

function makePeer(id) {
  // Defaults to PeerJS's free public cloud signaling server. A self-hosted
  // PeerServer can be used instead by storing its options (host, port, path,
  // secure, …) under the localStorage key `cardparty.peerConfig`.
  const custom = store.get('peerConfig');
  const opts = { debug: 0, ...(custom && typeof custom === 'object' ? custom : {}) };
  return id ? new Peer(id, opts) : new Peer(opts);
}

const CONNECT_TIMEOUT_MS = 15000;

const HEARTBEAT_MS = 8000;
const STALE_MS = 30000;

export class HostSession {
  constructor({ code, state, onChange, onPeerError }) {
    this.code = code;
    this.state = state;
    this.onChange = onChange; // (state) => void — persist + render
    this.onPeerError = onPeerError || (() => {});
    this.conns = new Map(); // playerId -> DataConnection
    this.peer = null;
    this.destroyed = false;
    this.role = 'host';
  }

  start() {
    return new Promise((resolve, reject) => {
      const peer = makePeer(PEER_PREFIX + this.code);
      this.peer = peer;
      let opened = false;
      // PeerJS can hang silently if the signaling server is unreachable.
      const timer = setTimeout(() => {
        if (!opened) {
          try { peer.destroy(); } catch {}
          reject(new Error('Timed out contacting the signaling server — check your connection.'));
        }
      }, CONNECT_TIMEOUT_MS);
      peer.on('open', () => {
        opened = true;
        clearTimeout(timer);
        resolve();
      });
      peer.on('error', (err) => {
        if (!opened) { clearTimeout(timer); reject(err); }
        else if (err.type !== 'peer-unavailable') this.onPeerError(err);
      });
      peer.on('disconnected', () => {
        // Lost the signaling server; existing connections keep working.
        // Reconnect so new players can still join.
        if (!this.destroyed) {
          try { peer.reconnect(); } catch {}
        }
      });
      peer.on('connection', (conn) => this._wire(conn));
      this._hb = setInterval(() => this._checkStale(), HEARTBEAT_MS);
    });
  }

  _wire(conn) {
    conn.on('data', (msg) => this._onMessage(conn, msg));
    conn.on('close', () => this._onConnGone(conn));
    conn.on('error', () => this._onConnGone(conn));
  }

  _onMessage(conn, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'hello') return this._hello(conn, msg);
    const playerId = conn._playerId;
    if (!playerId) return;
    const seat = getSeat(this.state, playerId);
    if (seat) {
      seat.lastSeen = Date.now();
      if (!seat.connected) {
        seat.connected = true;
        this._changed();
      }
    }
    if (msg.t === 'ping') {
      this._send(conn, { t: 'pong' });
    } else if (msg.t === 'action') {
      const res = applyAction(this.state, playerId, msg.action);
      if (res.ok) this._changed();
      else this._send(conn, { t: 'denied', reason: res.reason });
    }
  }

  _hello(conn, msg) {
    const playerId = String(msg.playerId || '');
    const name = cleanName(msg.name);
    if (!playerId) return conn.close();

    let seat = getSeat(this.state, playerId);
    if (!seat) {
      if (this.state.seats.length >= MAX_PLAYERS) {
        this._send(conn, { t: 'denied', fatal: true, reason: `Room is full (${MAX_PLAYERS} players max).` });
        setTimeout(() => { try { conn.close(); } catch {} }, 300);
        return;
      }
      seat = addSeat(this.state, { playerId, name });
      seat.zones.deck = shuffle(makeCardInstances(this.state, seat, msg.deck || []));
    }
    // On reconnection the seat keeps its current name (which may have been
    // set by the host) — the in-game rename action is how names change.
    seat.connected = true;
    seat.lastSeen = Date.now();

    const old = this.conns.get(playerId);
    if (old && old !== conn) {
      try { old.close(); } catch {}
    }
    this.conns.set(playerId, conn);
    conn._playerId = playerId;

    this._send(conn, { t: 'welcome', you: playerId, state: this.state });
    this._changed();
  }

  _onConnGone(conn) {
    const playerId = conn._playerId;
    if (!playerId) return;
    if (this.conns.get(playerId) === conn) {
      this.conns.delete(playerId);
      const seat = getSeat(this.state, playerId);
      if (seat && seat.connected) {
        seat.connected = false;
        this._changed();
      }
    }
  }

  _checkStale() {
    let dirty = false;
    const now = Date.now();
    for (const seat of this.state.seats) {
      if (seat.playerId === this.state.hostPlayerId) continue;
      if (seat.connected && now - (seat.lastSeen || 0) > STALE_MS) {
        seat.connected = false;
        dirty = true;
        const conn = this.conns.get(seat.playerId);
        try { conn && conn.close(); } catch {}
        this.conns.delete(seat.playerId);
      }
    }
    if (dirty) this._changed();
  }

  _send(conn, msg) {
    try {
      if (conn.open) conn.send(msg);
    } catch {}
  }

  _changed() {
    this.state.version++;
    this.onChange(this.state);
    const msg = { t: 'state', state: this.state };
    for (const conn of this.conns.values()) this._send(conn, msg);
  }

  // The host's own moves go through the same action pipeline.
  dispatch(action) {
    const res = applyAction(this.state, this.state.hostPlayerId, action);
    if (res.ok) this._changed();
    return res;
  }

  // Replace the whole board with a saved state (already sanitized). The room
  // code stays this room's; the loading host takes over the saved host seat
  // if identities differ; connected players keep or regain their seats.
  loadState(loaded) {
    const myId = this.state.hostPlayerId;
    const myName = getSeat(this.state, myId)?.name;
    loaded.roomCode = this.state.roomCode;

    if (!loaded.seats.some((s) => s.playerId === myId)) {
      // Take over the saved host's seat (or the first seat) and its cards.
      const hostSeat = loaded.seats.find((s) => s.playerId === loaded.hostPlayerId) || loaded.seats[0];
      const oldId = hostSeat.playerId;
      hostSeat.playerId = myId;
      if (myName) hostSeat.name = myName;
      for (const card of Object.values(loaded.cards)) {
        if (card.ownerId === oldId) {
          card.ownerId = myId;
          if (myName) card.ownerName = myName;
        }
      }
    }
    loaded.hostPlayerId = myId;

    // Players connected right now who aren't in the save keep a (fresh) seat.
    for (const pid of this.conns.keys()) {
      if (!loaded.seats.some((s) => s.playerId === pid) && loaded.seats.length < MAX_PLAYERS) {
        const current = getSeat(this.state, pid);
        addSeat(loaded, { playerId: pid, name: current ? current.name : 'Player' });
      }
    }
    for (const seat of loaded.seats) {
      seat.connected = seat.playerId === myId || this.conns.has(seat.playerId);
      seat.lastSeen = Date.now();
    }

    this.state = loaded;
    this._changed();
  }

  // Nudge every client to re-fetch the card library from the sheet.
  broadcastReload() {
    for (const conn of this.conns.values()) this._send(conn, { t: 'reloadLibrary' });
  }

  kick(playerId) {
    const conn = this.conns.get(playerId);
    const res = this.dispatch({ type: 'kick', playerId });
    if (res.ok && conn) {
      this._send(conn, { t: 'kicked' });
      setTimeout(() => { try { conn.close(); } catch {} }, 300);
      this.conns.delete(playerId);
    }
    return res;
  }

  destroy() {
    this.destroyed = true;
    clearInterval(this._hb);
    try { this.peer && this.peer.destroy(); } catch {}
  }
}

export class ClientSession {
  constructor({ code, identity, deck, handlers }) {
    this.code = code;
    this.identity = identity;
    this.deck = deck || [];
    this.h = handlers; // { onState, onStatus, onDenied, onKicked, onFail }
    this.peer = null;
    this.conn = null;
    this.destroyed = false;
    this.kicked = false;
    this.everConnected = false;
    this.failCount = 0;
    this.attempt = 0;
    this.lastSeen = 0;
    this.role = 'client';
    this._retryTimer = null;
  }

  connect() {
    this._hb = setInterval(() => this._heartbeat(), HEARTBEAT_MS);
    this._attempt();
  }

  _attempt() {
    if (this.destroyed) return;
    // Generation guard: events from a previous attempt's peer (including the
    // close events its teardown fires) must not disturb the current attempt.
    const gen = (this._gen = (this._gen || 0) + 1);
    const live = () => !this.destroyed && this._gen === gen;
    this.h.onStatus(this.everConnected ? 'reconnecting' : 'connecting');
    this._cleanupPeer();
    // If neither open nor error fires (unreachable signaling server), give up
    // on this attempt and let the retry logic take over.
    clearTimeout(this._connectTimer);
    this._connectTimer = setTimeout(() => {
      if (live() && !(this.conn && this.conn.open)) this._dropped();
    }, CONNECT_TIMEOUT_MS);
    const peer = makePeer(null);
    this.peer = peer;
    peer.on('open', () => {
      if (!live()) return;
      const conn = peer.connect(PEER_PREFIX + this.code, { reliable: true });
      this.conn = conn;
      conn.on('open', () => {
        if (!live()) return;
        clearTimeout(this._connectTimer);
        this.lastSeen = Date.now();
        try {
          conn.send({ t: 'hello', playerId: this.identity.playerId, name: this.identity.name, deck: this.deck });
        } catch {}
      });
      conn.on('data', (msg) => { if (live()) this._onMessage(msg); });
      conn.on('close', () => { if (live()) this._dropped(); });
      conn.on('error', () => { if (live()) this._dropped(); });
    });
    peer.on('error', () => { if (live()) this._dropped(); });
  }

  _onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    this.lastSeen = Date.now();
    switch (msg.t) {
      case 'welcome':
        this.everConnected = true;
        this.failCount = 0;
        this.attempt = 0;
        this.h.onStatus('connected');
        this.h.onState(msg.state);
        break;
      case 'state':
        this.h.onState(msg.state);
        break;
      case 'pong':
        break;
      case 'denied':
        if (msg.fatal) {
          const reason = msg.reason;
          this.destroy();
          this.h.onFail(reason);
        } else {
          this.h.onDenied(msg.reason);
        }
        break;
      case 'reloadLibrary':
        this.h.onReloadLibrary && this.h.onReloadLibrary();
        break;
      case 'kicked':
        this.kicked = true;
        this.destroy();
        this.h.onKicked();
        break;
    }
  }

  _dropped() {
    if (this.destroyed || this.kicked || this._retryTimer) return;
    if (!this.everConnected) {
      this.failCount++;
      if (this.failCount >= 3) {
        this.destroy();
        this.h.onFail('Could not find that room. Double-check the code — or the host may be offline.');
        return;
      }
    }
    this.h.onStatus(this.everConnected ? 'reconnecting' : 'connecting');
    const delay = Math.min(15000, 1500 + this.attempt * 1500);
    this.attempt++;
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      this._attempt();
    }, delay);
  }

  _heartbeat() {
    if (this.destroyed) return;
    if (this.conn && this.conn.open) {
      try { this.conn.send({ t: 'ping' }); } catch {}
      if (this.everConnected && Date.now() - this.lastSeen > STALE_MS) {
        // Host went silent — tear down and rebuild the connection.
        try { this.conn.close(); } catch {}
        this._dropped();
      }
    }
  }

  dispatch(action) {
    if (this.conn && this.conn.open) {
      try {
        this.conn.send({ t: 'action', action });
        return { ok: true };
      } catch {}
    }
    return { ok: false, reason: 'Not connected — hold on, reconnecting…' };
  }

  setDeck(deck) {
    this.deck = deck || [];
  }

  _cleanupPeer() {
    try { this.peer && this.peer.destroy(); } catch {}
    this.peer = null;
    this.conn = null;
  }

  destroy() {
    this.destroyed = true;
    clearInterval(this._hb);
    clearTimeout(this._retryTimer);
    clearTimeout(this._connectTimer);
    this._retryTimer = null;
    this._cleanupPeer();
  }
}
