// DOM helpers, toasts, modals, and the game-table renderer.
// The whole table re-renders on every state broadcast (states are small).

import { ZONES, ZONE_LABELS, getSeat } from './game.js';

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'text') node.textContent = value;
    else if (typeof value === 'boolean') { if (value) node.setAttribute(key, ''); }
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child == null) continue;
    node.append(child.nodeType ? child : document.createTextNode(child));
  }
  return node;
}

// ---------- toasts ----------

export function toast(message, kind = 'info') {
  const root = document.getElementById('toast-root');
  const node = el('div', { class: 'toast ' + kind, text: message });
  root.append(node);
  setTimeout(() => node.classList.add('show'), 10);
  setTimeout(() => {
    node.classList.remove('show');
    setTimeout(() => node.remove(), 400);
  }, 3800);
}

// ---------- modals ----------
// One modal at a time; it re-renders when new state arrives so open panels stay live.

let modal = null; // { kind, params }

export function openModal(kind, params = {}) {
  modal = { kind, params };
  renderModal();
}

export function closeModal() {
  modal = null;
  document.getElementById('modal-root').replaceChildren();
}

export function refreshModal() {
  if (modal) renderModal();
}

let modalCtx = null; // { state, ctx } refreshed by renderGame

function renderModal() {
  const root = document.getElementById('modal-root');
  if (!modal) return root.replaceChildren();
  const { kind, params } = modal;
  let title = '';
  let body = null;

  if (kind === 'help') {
    title = 'How Card Party works';
    body = helpBody();
  } else if (!modalCtx) {
    return root.replaceChildren();
  } else if (kind === 'card') {
    const card = modalCtx.state.cards[params.cardId];
    if (!card) return closeModal();
    title = card.title;
    body = cardModalBody(modalCtx.state, modalCtx.ctx, card);
  } else if (kind === 'zone') {
    const seat = getSeat(modalCtx.state, params.playerId);
    if (!seat) return closeModal();
    title = `${seat.name} — ${ZONE_LABELS[params.zone]} (${seat.zones[params.zone].length})`;
    body = zoneModalBody(modalCtx.state, modalCtx.ctx, seat, params.zone);
  } else if (kind === 'admin') {
    title = 'Host admin';
    body = adminModalBody(modalCtx.state, modalCtx.ctx);
  } else if (kind === 'loadDeck') {
    title = 'Load a deck';
    body = params.render();
  } else {
    return closeModal();
  }

  const overlay = el('div', { class: 'modal-overlay', onClick: (e) => { if (e.target === overlay) closeModal(); } },
    el('div', { class: 'modal' },
      el('div', { class: 'modal-head' },
        el('h3', { text: title }),
        el('button', { class: 'btn icon', title: 'Close', onClick: closeModal }, '✕'),
      ),
      el('div', { class: 'modal-body' }, body),
    ),
  );
  root.replaceChildren(overlay);
}

function helpBody() {
  const p = (t) => el('p', { text: t });
  return el('div', {},
    p('Card Party is a rules-free shared tabletop. Everything is public and anything goes — the honor system is the only referee.'),
    el('ul', {},
      el('li', { text: 'Each player has a Deck, a Hand, a Discard pile, and a Delayed space. All four are visible to everyone.' }),
      el('li', { text: 'Drag any card onto any zone — yours or another player’s deck, hand, discard, or Delayed space.' }),
      el('li', { text: 'Click a card for details, to pick one of its two upgrade options, or to move it precisely (e.g. bottom of a deck).' }),
      el('li', { text: 'Click any pile (deck/discard) to look through it — decks are public too.' }),
      el('li', { text: 'Cards always remember their original owner (the colored stripe).' }),
      el('li', { text: 'If you disconnect, rejoin with the same room code from the same browser and you get your seat and cards back.' }),
      el('li', { text: 'The host can kick/block players, and send every card back to its owner’s deck.' }),
    ),
    p('Build decks from the Decks screen — the card list can be loaded live from a Google Sheet.'),
  );
}

// ---------- shared card rendering ----------

export function ownerColor(state, ownerId) {
  const i = state.seats.findIndex((s) => s.playerId === ownerId);
  return `var(--seat-${(i >= 0 ? i : 0) % 10})`;
}

export function cardEl(state, ctx, cardId, opts = {}) {
  const card = state.cards[cardId];
  if (!card) return el('div');
  const size = opts.size || 'mini';
  const node = el('div', {
    class: `card ${size}` + (card.upgrade != null ? ' upgraded' : ''),
    draggable: 'true',
    title: card.description || card.title,
    onClick: (e) => { e.stopPropagation(); openModal('card', { cardId }); },
    onDragstart: (e) => {
      e.dataTransfer.setData('text/plain', cardId);
      e.dataTransfer.effectAllowed = 'move';
      node.classList.add('dragging');
    },
    onDragend: () => node.classList.remove('dragging'),
  });
  node.style.setProperty('--owner', ownerColor(state, card.ownerId));

  node.append(el('div', { class: 'card-title', text: card.title }));
  if (card.keywords.length) {
    node.append(el('div', { class: 'card-keywords' },
      card.keywords.map((k) => el('span', { class: 'kw', text: k }))));
  }
  if (size === 'big' && card.description) {
    node.append(el('div', { class: 'card-desc', text: card.description }));
  }
  if (card.upgrade != null) {
    node.append(el('div', { class: 'card-upgrade-tag', text: '★ ' + (card.upgrade === 0 ? 'A' : 'B') }));
  }
  const foreign = opts.zoneOwnerId && opts.zoneOwnerId !== card.ownerId;
  if (foreign) {
    node.append(el('div', { class: 'card-owner', text: card.ownerName + '’s' }));
  }
  return node;
}

export function makeDropTarget(node, ctx, playerId, zone) {
  node.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    node.classList.add('drop-hint');
  });
  node.addEventListener('dragleave', () => node.classList.remove('drop-hint'));
  node.addEventListener('drop', (e) => {
    e.preventDefault();
    node.classList.remove('drop-hint');
    const cardId = e.dataTransfer.getData('text/plain');
    if (!cardId) return;
    ctx.dispatch({ type: 'moveCard', cardId, to: { playerId, zone, pos: zone === 'deck' ? 'top' : undefined } });
  });
  return node;
}

// ---------- card modal ----------

function cardModalBody(state, ctx, card) {
  const loc = (() => {
    for (const seat of state.seats) {
      for (const zone of ZONES) {
        if (seat.zones[zone].includes(card.id)) return { seat, zone };
      }
    }
    return null;
  })();

  const wrap = el('div', { class: 'card-detail' });
  wrap.style.setProperty('--owner', ownerColor(state, card.ownerId));

  if (card.keywords.length) {
    wrap.append(el('div', { class: 'card-keywords' }, card.keywords.map((k) => el('span', { class: 'kw', text: k }))));
  }
  wrap.append(el('p', { class: 'detail-desc', text: card.description || '(no description)' }));
  wrap.append(el('p', { class: 'detail-meta' },
    `Owned by ${card.ownerName}`,
    loc ? ` · currently in ${loc.seat.name}’s ${ZONE_LABELS[loc.zone].toLowerCase()}` : '',
  ));

  // Upgrade options — exactly one may be selected (or none).
  const upgradeBox = el('div', { class: 'upgrade-box' }, el('h4', { text: 'Upgrade' }));
  const options = [
    { choice: null, label: 'Not upgraded', desc: '' },
    { choice: 0, label: 'Option A', desc: card.upgrades[0] || '(blank)' },
    { choice: 1, label: 'Option B', desc: card.upgrades[1] || '(blank)' },
  ];
  for (const opt of options) {
    const input = el('input', {
      type: 'radio', name: 'upgrade-choice',
      onChange: () => ctx.dispatch({ type: 'setUpgrade', cardId: card.id, choice: opt.choice }),
    });
    input.checked = card.upgrade === opt.choice;
    upgradeBox.append(el('label', { class: 'upgrade-option' + (card.upgrade === opt.choice ? ' selected' : '') },
      input,
      el('span', { class: 'upgrade-label', text: opt.label }),
      opt.desc ? el('span', { class: 'upgrade-desc', text: opt.desc }) : null,
    ));
  }
  wrap.append(upgradeBox);

  // Quick moves + precise mover.
  const quick = el('div', { class: 'quick-moves' },
    quickBtn('My hand', { playerId: ctx.myId, zone: 'hand' }),
    quickBtn('My Delayed', { playerId: ctx.myId, zone: 'delayed' }),
    quickBtn('My discard', { playerId: ctx.myId, zone: 'discard' }),
    quickBtn('Top of my deck', { playerId: ctx.myId, zone: 'deck', pos: 'top' }),
  );
  function quickBtn(label, to) {
    return el('button', {
      class: 'btn small',
      text: label,
      onClick: () => { ctx.dispatch({ type: 'moveCard', cardId: card.id, to }); closeModal(); },
    });
  }

  const seatSel = el('select', {}, state.seats.map((s) =>
    el('option', { value: s.playerId, text: s.playerId === ctx.myId ? s.name + ' (you)' : s.name })));
  const zoneSel = el('select', {}, ZONES.map((z) => el('option', { value: z, text: ZONE_LABELS[z] })));
  const posSel = el('select', {},
    el('option', { value: 'top', text: 'Top' }),
    el('option', { value: 'bottom', text: 'Bottom' }));
  const syncPos = () => { posSel.style.display = zoneSel.value === 'deck' ? '' : 'none'; };
  zoneSel.addEventListener('change', syncPos);
  syncPos();

  const mover = el('div', { class: 'mover' },
    el('span', { text: 'Move to:' }), seatSel, zoneSel, posSel,
    el('button', {
      class: 'btn small primary', text: 'Move',
      onClick: () => {
        ctx.dispatch({
          type: 'moveCard', cardId: card.id,
          to: { playerId: seatSel.value, zone: zoneSel.value, pos: posSel.value },
        });
        closeModal();
      },
    }),
  );

  wrap.append(el('h4', { text: 'Move this card' }), quick, mover);
  return wrap;
}

// ---------- zone modal (browse any pile — everything is public) ----------

function zoneModalBody(state, ctx, seat, zone) {
  const wrap = el('div', { class: 'zone-browser' });
  if (zone === 'deck') {
    wrap.append(el('div', { class: 'zone-note' },
      el('span', { text: 'Top card first. ' }),
      el('button', {
        class: 'btn small', text: '🔀 Shuffle',
        onClick: () => { ctx.dispatch({ type: 'shuffle', playerId: seat.playerId, zone: 'deck' }); toast('Deck shuffled'); },
      }),
    ));
  }
  const ids = seat.zones[zone];
  if (!ids.length) wrap.append(el('p', { class: 'empty', text: 'Empty.' }));
  ids.forEach((cardId, i) => {
    const card = state.cards[cardId];
    if (!card) return;
    const row = el('div', { class: 'zone-row' },
      zone === 'deck' ? el('span', { class: 'zone-index', text: String(i + 1) }) : null,
      cardEl(state, ctx, cardId, { size: 'mini', zoneOwnerId: seat.playerId }),
      el('div', { class: 'zone-row-actions' },
        el('button', {
          class: 'btn small', text: '→ my hand',
          onClick: () => ctx.dispatch({ type: 'moveCard', cardId, to: { playerId: ctx.myId, zone: 'hand' } }),
        }),
      ),
    );
    wrap.append(row);
  });
  return wrap;
}

// ---------- admin modal ----------

function adminModalBody(state, ctx) {
  const wrap = el('div', { class: 'admin' });

  wrap.append(el('h4', { text: 'Players' }));
  for (const seat of state.seats) {
    if (seat.playerId === state.hostPlayerId) continue;
    wrap.append(el('div', { class: 'admin-row' },
      el('span', { class: 'dot ' + (seat.connected ? 'on' : 'off') }),
      el('span', { class: 'admin-name', text: seat.name + (seat.connected ? '' : ' (disconnected)') }),
      el('button', {
        class: 'btn small warn', text: 'Kick',
        onClick: () => { if (confirm(`Kick ${seat.name}? Their cards return to their owners; they can rejoin.`)) ctx.kick(seat.playerId, false); },
      }),
      el('button', {
        class: 'btn small danger', text: 'Kick + block',
        onClick: () => { if (confirm(`Kick and BLOCK ${seat.name}? They cannot rejoin until unblocked.`)) ctx.kick(seat.playerId, true); },
      }),
    ));
  }
  if (state.seats.length <= 1) wrap.append(el('p', { class: 'empty', text: 'No other players yet.' }));

  if (state.blocked.length) {
    wrap.append(el('h4', { text: 'Blocked' }));
    for (const b of state.blocked) {
      wrap.append(el('div', { class: 'admin-row' },
        el('span', { class: 'admin-name', text: b.name }),
        el('button', { class: 'btn small', text: 'Unblock', onClick: () => ctx.dispatch({ type: 'unblock', playerId: b.playerId }) }),
      ));
    }
  }

  wrap.append(el('h4', { text: 'Table' }));
  wrap.append(el('button', {
    class: 'btn warn', text: 'Return all cards to their owners’ decks',
    onClick: () => {
      if (confirm('Return every card to its original owner’s deck and shuffle?')) {
        ctx.dispatch({ type: 'returnAll' });
        toast('All cards returned home');
      }
    },
  }));
  return wrap;
}

// ---------- game table ----------

export function renderGame(root, state, ctx) {
  modalCtx = { state, ctx };
  root.replaceChildren();

  const me = getSeat(state, ctx.myId);
  const others = state.seats.filter((s) => s.playerId !== ctx.myId);

  // Top bar
  root.append(el('div', { class: 'game-topbar' },
    el('div', { class: 'room-info' },
      el('button', {
        class: 'room-code', title: 'Click to copy room code',
        onClick: () => { navigator.clipboard?.writeText(state.roomCode).then(() => toast('Room code copied')); },
      }, 'Room ', el('strong', { text: state.roomCode }), ' ⧉'),
      el('span', { class: 'pill ' + ctx.status, text: statusLabel(ctx) }),
      el('span', { class: 'pill', text: `${state.seats.length}/10 players` }),
    ),
    el('div', { class: 'game-actions' },
      el('button', { class: 'btn small', text: '✎ ' + (me ? me.name : 'Name'), title: 'Rename yourself', onClick: ctx.renameSelf }),
      el('button', { class: 'btn small', text: '🂠 Load deck', onClick: ctx.openLoadDeck }),
      ctx.isHost ? el('button', { class: 'btn small', text: '⚙ Admin', onClick: () => openModal('admin') }) : null,
      el('button', { class: 'btn small', text: '? Help', onClick: () => openModal('help') }),
      el('button', { class: 'btn small danger', text: 'Leave', onClick: ctx.leave }),
    ),
  ));

  // Other players
  const grid = el('div', { class: 'others-grid' });
  for (const seat of others) grid.append(seatPanel(state, ctx, seat, false));
  if (!others.length) {
    grid.append(el('div', { class: 'waiting-note' },
      el('p', { text: 'No one else is here yet. Share the room code:' }),
      el('p', { class: 'big-code', text: state.roomCode }),
    ));
  }
  root.append(grid);

  // My board
  if (me) root.append(seatPanel(state, ctx, me, true));
}

function statusLabel(ctx) {
  if (ctx.isHost) return 'hosting';
  return ctx.status === 'connected' ? 'connected' : ctx.status + '…';
}

function seatPanel(state, ctx, seat, isMe) {
  const panel = el('div', { class: 'seat' + (isMe ? ' me' : '') + (seat.connected ? '' : ' offline') });
  panel.style.setProperty('--seat-color', ownerColor(state, seat.playerId));

  panel.append(el('div', { class: 'seat-head' },
    el('span', { class: 'dot ' + (seat.connected ? 'on' : 'off'), title: seat.connected ? 'Connected' : 'Disconnected' }),
    el('span', { class: 'seat-name', text: seat.name + (isMe ? ' (you)' : '') }),
    seat.playerId === state.hostPlayerId ? el('span', { class: 'badge', text: 'HOST' }) : null,
  ));

  const zones = el('div', { class: 'seat-zones' });

  // Deck + discard piles
  const piles = el('div', { class: 'piles' });
  const deckPile = makeDropTarget(el('div', {
    class: 'pile deck', title: 'Click to browse (decks are public!) · drop a card to put it on top',
    onClick: () => openModal('zone', { playerId: seat.playerId, zone: 'deck' }),
  },
    el('div', { class: 'pile-label', text: 'Deck' }),
    el('div', { class: 'pile-count', text: String(seat.zones.deck.length) }),
  ), ctx, seat.playerId, 'deck');
  const topDiscard = seat.zones.discard[seat.zones.discard.length - 1];
  const discardPile = makeDropTarget(el('div', {
    class: 'pile discard', title: 'Click to browse · drop a card to discard it here',
    onClick: () => openModal('zone', { playerId: seat.playerId, zone: 'discard' }),
  },
    el('div', { class: 'pile-label', text: 'Discard' }),
    el('div', { class: 'pile-count', text: String(seat.zones.discard.length) }),
    topDiscard ? el('div', { class: 'pile-top', text: state.cards[topDiscard]?.title || '' }) : null,
  ), ctx, seat.playerId, 'discard');
  piles.append(deckPile, discardPile);

  if (isMe) {
    piles.append(el('div', { class: 'pile-actions' },
      el('button', { class: 'btn small primary', text: 'Draw', onClick: () => ctx.dispatch({ type: 'draw', n: 1 }) }),
      el('button', { class: 'btn small', text: 'Draw 5', onClick: () => ctx.dispatch({ type: 'draw', n: 5 }) }),
      el('button', { class: 'btn small', text: '🔀 Shuffle', onClick: () => { ctx.dispatch({ type: 'shuffle', zone: 'deck' }); toast('Deck shuffled'); } }),
    ));
  }
  zones.append(piles);

  // Delayed space
  const delayed = makeDropTarget(el('div', { class: 'zone-strip delayed' },
    el('div', { class: 'strip-label', text: `Delayed (${seat.zones.delayed.length})` }),
    el('div', { class: 'strip-cards' },
      seat.zones.delayed.map((id) => cardEl(state, ctx, id, { size: isMe ? 'small' : 'mini', zoneOwnerId: seat.playerId })),
      seat.zones.delayed.length ? null : el('span', { class: 'empty', text: 'empty' }),
    ),
  ), ctx, seat.playerId, 'delayed');
  zones.append(delayed);

  // Hand — public, like everything else
  const hand = makeDropTarget(el('div', { class: 'zone-strip hand' },
    el('div', { class: 'strip-label', text: `Hand (${seat.zones.hand.length})` }),
    el('div', { class: 'strip-cards' },
      seat.zones.hand.map((id) => cardEl(state, ctx, id, { size: isMe ? 'small' : 'mini', zoneOwnerId: seat.playerId })),
      seat.zones.hand.length ? null : el('span', { class: 'empty', text: 'empty' }),
    ),
  ), ctx, seat.playerId, 'hand');
  zones.append(hand);

  panel.append(zones);
  return panel;
}
