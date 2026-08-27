// Tiny localStorage wrapper + id helpers + per-tab identity claims.

const NS = 'cardparty.';

export const store = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(NS + key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(NS + key, JSON.stringify(value));
    } catch {
      // storage full or unavailable — game still works, just won't persist
    }
  },
  del(key) {
    try {
      localStorage.removeItem(NS + key);
    } catch {}
  },
};

export function uid(prefix = 'x') {
  if (globalThis.crypto?.randomUUID) {
    return prefix + '_' + crypto.randomUUID().replaceAll('-', '').slice(0, 20);
  }
  return (
    prefix + '_' +
    Math.random().toString(36).slice(2, 12) +
    Date.now().toString(36)
  );
}

// ---------------------------------------------------------------------------
// Identity pool with per-tab claims.
//
// Identities persist in localStorage so a returning player can repossess
// their seat — but localStorage is shared across tabs, so a naive single
// identity would force every tab to be the same player. Instead we keep a
// pool of identities plus a claim map: each tab claims a free identity
// (tracked by a per-tab token in sessionStorage plus a heartbeat timestamp)
// and heartbeats it. A second tab therefore becomes a second player, and a
// closed tab's identity frees up — or is instantly reclaimed on reload,
// since sessionStorage survives refresh.
// ---------------------------------------------------------------------------

const CLAIM_TTL = 15000;
const HEARTBEAT = 5000;

let currentIdentity = null;
let claimTimer = null;

function session(key, value) {
  try {
    if (arguments.length > 1) {
      sessionStorage.setItem(NS + key, value);
      return value;
    }
    return sessionStorage.getItem(NS + key);
  } catch {
    return null;
  }
}

function tabToken() {
  let t = session('tab');
  if (!t) t = session('tab', uid('t')) || 'tab';
  return t;
}

function readClaims() {
  return store.get('claims', {});
}

function claimIdentity(playerId) {
  const stamp = () => {
    const claims = readClaims();
    claims[playerId] = { tab: tabToken(), ts: Date.now() };
    store.set('claims', claims);
  };
  stamp();
  session('claimed', playerId);
  clearInterval(claimTimer);
  claimTimer = setInterval(stamp, HEARTBEAT);
  window.addEventListener('beforeunload', () => {
    const claims = readClaims();
    if (claims[playerId]?.tab === tabToken()) {
      delete claims[playerId];
      store.set('claims', claims);
    }
  });
}

export function getIdentity() {
  if (currentIdentity) return currentIdentity;

  let ids = store.get('identities');
  if (!Array.isArray(ids)) {
    // migrate from the old single-identity key
    const old = store.get('identity');
    ids = old?.playerId ? [old] : [];
    store.set('identities', ids);
  }

  const claims = readClaims();
  const now = Date.now();
  const tab = tabToken();
  const isFree = (playerId) => {
    const claim = claims[playerId];
    return !claim || claim.tab === tab || now - claim.ts > CLAIM_TTL;
  };

  // This tab already claimed one (page reload) → keep it.
  const claimed = session('claimed');
  let identity = (claimed && ids.find((i) => i.playerId === claimed)) || null;
  if (!identity) identity = ids.find((i) => isFree(i.playerId)) || null;
  if (!identity) {
    identity = { playerId: uid('p'), name: '' };
    ids.push(identity);
    store.set('identities', ids);
  }

  claimIdentity(identity.playerId);
  currentIdentity = identity;
  return identity;
}

export function saveIdentity(identity) {
  currentIdentity = identity;
  const ids = store.get('identities', []);
  const i = ids.findIndex((x) => x.playerId === identity.playerId);
  if (i >= 0) ids[i] = identity;
  else ids.push(identity);
  store.set('identities', ids);
}
