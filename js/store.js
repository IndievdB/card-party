// Tiny localStorage wrapper + id helpers.

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

// The persistent identity lets a player reconnect and repossess their seat.
export function getIdentity() {
  let id = store.get('identity');
  if (!id || !id.playerId) {
    id = { playerId: uid('p'), name: '' };
    store.set('identity', id);
  }
  return id;
}

export function saveIdentity(identity) {
  store.set('identity', identity);
}
