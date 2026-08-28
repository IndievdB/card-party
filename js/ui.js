// DOM helpers, toasts, modals, and the game-table renderer.
//
// The table is drawn to look and feel physical: cards keep real card
// proportions with paper faces and owner-colored backs, decks are stacked
// piles, hands fan out, placed cards sit at slightly crooked angles, and a
// FLIP pass animates every card sliding across the felt between re-renders.

import { ZONES, ZONE_LABELS, getSeat, findCard } from './game.js';

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

// Deterministic per-card jitter so placed cards look set down by hand and
// keep their exact crooked angle across re-renders.
function jitterDeg(id, range = 2.4) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return (((Math.abs(h) % 1000) / 1000) * 2 - 1) * range;
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
let modalCtx = null; // { state, ctx } refreshed by renderGame

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

function renderModal() {
  const root = document.getElementById('modal-root');
  if (!modal) return root.replaceChildren();
  hidePeek();
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
      el('li', { text: 'Drag the top card off a deck to draw it (or use the Draw button). Drag any card onto any zone — yours or another player’s.' }),
      el('li', { text: 'Click a card to pick it up — choose an upgrade option or move it precisely (e.g. bottom of a deck).' }),
      el('li', { text: 'Click any pile to look through it — decks are public too.' }),
      el('li', { text: 'A card’s back and seal are colored by its original owner; it never forgets whose it is.' }),
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

// A physical-looking card. Sizes: 'hand' (my hand), 'table' (my board),
// 'mini' (other players), 'big' (modal / hover peek).
export function cardEl(state, ctx, cardId, opts = {}) {
  const card = state.cards[cardId];
  if (!card) return el('div');
  const size = opts.size || 'mini';
  const interactive = !opts.inert;
  const node = el('div', {
    class: `card ${size}` + (card.upgrade != null ? ' upgraded' : ''),
    dataset: interactive ? { cardId } : null,
    draggable: interactive ? 'true' : null,
  });
  node.style.setProperty('--owner', ownerColor(state, card.ownerId));

  const face = el('div', { class: 'card-face' });
  face.append(el('div', { class: 'card-titlebar' },
    el('span', { class: 'card-title', text: card.title }),
    el('span', { class: 'card-seal', title: 'Owner: ' + card.ownerName }),
  ));

  const foreign = opts.zoneOwnerId && opts.zoneOwnerId !== card.ownerId;
  if (foreign) {
    face.append(el('div', { class: 'card-owner', text: card.ownerName + '’s' }));
  }

  if (card.keywords.length) {
    face.append(el('div', { class: 'card-keywords' },
      card.keywords.map((k) => el('span', { class: 'kw', text: k }))));
  }
  if (card.description) {
    face.append(el('div', { class: 'card-desc', text: card.description }));
  }

  // Every card prints its full text, upgrade options included — like the
  // physical card would. The chosen upgrade is gilded.
  if (card.upgrades[0] || card.upgrades[1]) {
    face.append(el('div', { class: 'card-ups' },
      [0, 1].map((i) => card.upgrades[i]
        ? el('div', { class: 'up-line' + (card.upgrade === i ? ' sel' : '') },
            el('span', { class: 'up-star', text: '★' + (i === 0 ? 'A' : 'B') }),
            el('span', { text: card.upgrades[i] }))
        : null)));
  }
  node.append(face);
  if (card.upgrade != null && size !== 'big') {
    node.append(el('div', { class: 'card-upgrade-tag', text: '★' + (card.upgrade === 0 ? 'A' : 'B') }));
  }

  if (interactive) {
    node.addEventListener('click', (e) => { e.stopPropagation(); hidePeek(); openModal('card', { cardId }); });
    node.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', cardId);
      e.dataTransfer.effectAllowed = 'move';
      node.classList.add('dragging');
      hidePeek();
    });
    node.addEventListener('dragend', () => node.classList.remove('dragging'));
    if (size !== 'big') {
      node.addEventListener('mouseenter', () => showPeek(state, ctx, cardId));
      node.addEventListener('mouseleave', hidePeek);
    }
  }
  return node;
}

// A slot positions a card on the felt (fan angle / placement jitter) via CSS
// custom props, so the card element itself stays free for FLIP + hover lift.
function slot(cardNode, { rot = 0, ty = 0, cls = '' } = {}) {
  const s = el('div', { class: 'cslot ' + cls }, cardNode);
  s.style.setProperty('--rot', rot.toFixed(2) + 'deg');
  s.style.setProperty('--ty', ty.toFixed(1) + 'px');
  return s;
}

// ---------- hover peek (pick a card up to read it) ----------

let peekTimer = null;

function showPeek(state, ctx, cardId) {
  clearTimeout(peekTimer);
  peekTimer = setTimeout(() => {
    const root = document.getElementById('card-peek');
    if (!root || !state.cards[cardId]) return;
    root.replaceChildren(cardEl(state, ctx, cardId, { size: 'big', inert: true }));
    root.classList.add('show');
  }, 250);
}

export function hidePeek() {
  clearTimeout(peekTimer);
  document.getElementById('card-peek')?.classList.remove('show');
}

// ---------- drag & drop ----------

export function makeDropTarget(node, ctx, playerId, zone) {
  node.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    node.classList.add('drop-hint');
  });
  node.addEventListener('dragleave', () => node.classList.remove('drop-hint'));
  node.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    node.classList.remove('drop-hint');
    const cardId = e.dataTransfer.getData('text/plain');
    if (!cardId) return;
    ctx.dispatch({ type: 'moveCard', cardId, to: { playerId, zone, pos: zone === 'deck' ? 'top' : undefined } });
  });
  return node;
}

// ---------- FLIP animations: cards physically slide across the felt ----------

const flip = {
  cards: new Map(), // cardId -> { rect, el } from the previous DOM
  piles: new Map(), // "playerId:zone" -> rect from the previous DOM
  locs: new Map(),  // cardId -> "playerId:zone" from the previous state
};

function captureRects(root) {
  flip.cards.clear();
  flip.piles.clear();
  for (const node of root.querySelectorAll('[data-card-id]')) {
    flip.cards.set(node.dataset.cardId, { rect: node.getBoundingClientRect(), el: node });
  }
  for (const node of root.querySelectorAll('[data-pile]')) {
    flip.piles.set(node.dataset.pile, node.getBoundingClientRect());
  }
}

function locOf(state, cardId) {
  const loc = findCard(state, cardId);
  return loc ? loc.seat.playerId + ':' + loc.zone : null;
}

function playAnimations(root, state) {
  const seen = new Set();
  for (const node of root.querySelectorAll('[data-card-id]')) {
    const id = node.dataset.cardId;
    seen.add(id);
    const now = node.getBoundingClientRect();
    if (!now.width) continue;
    const prev = flip.cards.get(id);
    let from = prev?.rect;
    // Card just surfaced from a hidden pile (e.g. drawn off a deck):
    // animate it flying out of that pile.
    if (!from) {
      const oldLoc = flip.locs.get(id);
      if (oldLoc) from = flip.piles.get(oldLoc);
    }
    if (from) {
      const dx = from.left + from.width / 2 - (now.left + now.width / 2);
      const dy = from.top + from.height / 2 - (now.top + now.height / 2);
      if (Math.abs(dx) + Math.abs(dy) > 6) {
        const scale = from.width && now.width ? from.width / now.width : 1;
        node.style.transition = 'none';
        node.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`;
        node.classList.add('flying');
        requestAnimationFrame(() => {
          node.style.transition = 'transform .38s cubic-bezier(.2,.75,.3,1)';
          node.style.transform = '';
          setTimeout(() => {
            node.style.transition = '';
            node.classList.remove('flying');
          }, 450);
        });
      }
    } else if (flip.locs.size && !flip.locs.has(id)) {
      node.classList.add('dealt'); // brand-new card (deck load): flip in
    }
  }

  // Cards that were visible and are now buried in a pile: send a ghost flying
  // onto the pile so they don't just blink out of existence.
  const fx = document.getElementById('fx-layer');
  if (fx) {
    for (const [id, prev] of flip.cards) {
      if (seen.has(id)) continue;
      const locKey = locOf(state, id);
      if (!locKey) continue;
      const target = root.querySelector(`[data-pile="${locKey}"]`)?.getBoundingClientRect();
      if (!target || !prev.rect.width) continue;
      const ghost = prev.el.cloneNode(true);
      ghost.classList.add('ghost');
      Object.assign(ghost.style, {
        position: 'fixed',
        left: prev.rect.left + 'px',
        top: prev.rect.top + 'px',
        width: prev.rect.width + 'px',
        height: prev.rect.height + 'px',
        margin: '0',
        transform: '',
        transition: 'none',
      });
      fx.append(ghost);
      const dx = target.left + target.width / 2 - (prev.rect.left + prev.rect.width / 2);
      const dy = target.top + target.height / 2 - (prev.rect.top + prev.rect.height / 2);
      requestAnimationFrame(() => {
        ghost.style.transition = 'transform .4s cubic-bezier(.3,.6,.3,1), opacity .4s ease-in';
        ghost.style.transform = `translate(${dx}px, ${dy}px) scale(.3)`;
        ghost.style.opacity = '0.1';
      });
      setTimeout(() => ghost.remove(), 460);
    }
  }

  flip.locs.clear();
  for (const seat of state.seats) {
    for (const zone of ZONES) {
      for (const id of seat.zones[zone]) flip.locs.set(id, seat.playerId + ':' + zone);
    }
  }
}

// ---------- card modal ----------

function cardModalBody(state, ctx, card) {
  const loc = findCard(state, card.id);
  const wrap = el('div', { class: 'card-detail' });

  wrap.append(el('div', { class: 'detail-card-wrap' }, cardEl(state, ctx, card.id, { size: 'big', inert: true })));
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
        class: 'btn small', text: 'Shuffle',
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
      el('div', { class: 'zone-row-info' },
        el('span', { class: 'zone-row-title', text: card.title }),
        card.keywords.length ? el('span', { class: 'card-keywords' }, card.keywords.map((k) => el('span', { class: 'kw', text: k }))) : null,
      ),
      el('div', { class: 'zone-row-actions' },
        el('button', { class: 'btn small', text: 'View', onClick: () => openModal('card', { cardId }) }),
        el('button', {
          class: 'btn small', text: '→ my hand',
          onClick: () => ctx.dispatch({ type: 'moveCard', cardId, to: { playerId: ctx.myId, zone: 'hand' } }),
        }),
      ),
    );
    row.style.setProperty('--owner', ownerColor(state, card.ownerId));
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
  captureRects(root);
  hidePeek();
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
      el('button', { class: 'btn small', text: (me ? me.name : 'Name'), title: 'Rename yourself', onClick: ctx.renameSelf }),
      el('button', { class: 'btn small', text: 'Load deck', onClick: ctx.openLoadDeck }),
      ctx.isHost ? el('button', { class: 'btn small', text: 'Admin', onClick: () => openModal('admin') }) : null,
      el('button', { class: 'btn small', text: 'Help', onClick: () => openModal('help') }),
      el('button', { class: 'btn small danger', text: 'Leave', onClick: ctx.leave }),
    ),
  ));

  const table = el('div', { class: 'table' });
  const grid = el('div', { class: 'others-grid' });
  for (const seat of others) grid.append(seatPanel(state, ctx, seat, false));
  if (!others.length) {
    grid.append(el('div', { class: 'waiting-note' },
      el('p', { text: 'No one else is at the table yet. Share the room code:' }),
      el('p', { class: 'big-code', text: state.roomCode }),
    ));
  }
  table.append(grid);
  if (me) table.append(seatPanel(state, ctx, me, true));
  root.append(table);

  playAnimations(root, state);
  refreshModal();
}

function statusLabel(ctx) {
  if (ctx.isHost) return 'hosting';
  return ctx.status === 'connected' ? 'connected' : ctx.status + '…';
}

function pileKey(seat, zone) {
  return seat.playerId + ':' + zone;
}

// Deck: a stack of owner-colored card backs, thickness tracking the count.
function deckPileEl(state, ctx, seat, isMe) {
  const count = seat.zones.deck.length;
  const layers = Math.max(count > 0 ? 1 : 0, Math.min(4, Math.ceil(count / 6)));
  const stack = el('div', { class: 'pile-stack' });
  for (let i = 0; i < layers; i++) {
    const back = el('div', { class: 'card-back' });
    back.style.setProperty('--owner', ownerColor(state, seat.playerId));
    back.style.setProperty('--stack-i', i);
    stack.append(back);
  }
  if (!count) stack.append(el('div', { class: 'pile-empty-mark' }));

  const pile = el('div', {
    class: 'pile deck' + (isMe ? ' mine' : ''),
    dataset: { pile: pileKey(seat, 'deck') },
    draggable: count ? 'true' : null,
    title: 'Click to look through the deck (decks are public) · drag off the top card to draw it',
    onClick: () => openModal('zone', { playerId: seat.playerId, zone: 'deck' }),
    // Dragging the pile picks up its top card — drop it anywhere to draw it there.
    onDragstart: (e) => {
      const top = seat.zones.deck[0];
      if (!top) { e.preventDefault(); return; }
      e.dataTransfer.setData('text/plain', top);
      e.dataTransfer.effectAllowed = 'move';
    },
  }, stack, el('div', { class: 'pile-count', text: String(count) }), el('div', { class: 'pile-tag', text: 'Deck' }));
  return makeDropTarget(pile, ctx, seat.playerId, 'deck');
}

// Discard: the top card lies face-up, slightly crooked, on a soft stack.
function discardPileEl(state, ctx, seat, isMe) {
  const ids = seat.zones.discard;
  const topId = ids[ids.length - 1];
  const pile = el('div', {
    class: 'pile discard' + (topId ? ' has-cards' : ''),
    dataset: { pile: pileKey(seat, 'discard') },
    title: 'Click to browse the discard pile · drop a card to discard it here',
    onClick: () => openModal('zone', { playerId: seat.playerId, zone: 'discard' }),
  });
  if (topId) {
    const card = cardEl(state, ctx, topId, { size: isMe ? 'table' : 'mini', zoneOwnerId: seat.playerId });
    pile.append(slot(card, { rot: jitterDeg(topId, 5) }));
  } else {
    pile.append(el('div', { class: 'pile-empty-mark' }));
  }
  pile.append(el('div', { class: 'pile-count', text: String(ids.length) }), el('div', { class: 'pile-tag', text: 'Discard' }));
  return makeDropTarget(pile, ctx, seat.playerId, 'discard');
}

function delayedStripEl(state, ctx, seat, isMe) {
  const ids = seat.zones.delayed;
  const strip = el('div', { class: 'zone-strip delayed', dataset: { pile: pileKey(seat, 'delayed') } },
    el('div', { class: 'strip-label', text: 'Delayed' }),
    el('div', { class: 'strip-cards' },
      ids.map((id) => slot(
        cardEl(state, ctx, id, { size: isMe ? 'table' : 'mini', zoneOwnerId: seat.playerId }),
        { rot: jitterDeg(id) },
      )),
    ),
  );
  return makeDropTarget(strip, ctx, seat.playerId, 'delayed');
}

function handStripEl(state, ctx, seat, isMe) {
  const ids = seat.zones.hand;
  const strip = el('div', { class: 'zone-strip hand', dataset: { pile: pileKey(seat, 'hand') } },
    el('div', { class: 'strip-label', text: 'Hand' }),
    el('div', { class: 'strip-cards' },
      // Side by side, never overlapping — just a slight hand-placed tilt.
      ids.map((id) => slot(
        cardEl(state, ctx, id, { size: isMe ? 'hand' : 'mini', zoneOwnerId: seat.playerId }),
        { rot: jitterDeg(id, 1.2) },
      )),
    ),
  );
  return makeDropTarget(strip, ctx, seat.playerId, 'hand');
}

function seatPanel(state, ctx, seat, isMe) {
  const panel = el('div', { class: 'seat' + (isMe ? ' me' : '') + (seat.connected ? '' : ' offline') });
  panel.style.setProperty('--seat-color', ownerColor(state, seat.playerId));

  panel.append(el('div', { class: 'seat-head' },
    el('span', { class: 'dot ' + (seat.connected ? 'on' : 'off'), title: seat.connected ? 'Connected' : 'Disconnected' }),
    el('span', { class: 'seat-name', text: seat.name + (isMe ? ' (you)' : '') }),
    seat.playerId === state.hostPlayerId ? el('span', { class: 'badge', text: 'HOST' }) : null,
  ));

  if (isMe) {
    const actions = el('div', { class: 'pile-actions' },
      el('button', { class: 'btn small primary', text: 'Draw', onClick: () => ctx.dispatch({ type: 'draw', n: 1 }) }),
      el('button', { class: 'btn small', text: 'Shuffle', onClick: () => { ctx.dispatch({ type: 'shuffle', zone: 'deck' }); toast('Deck shuffled'); } }),
    );
    panel.append(
      delayedStripEl(state, ctx, seat, true),
      el('div', { class: 'my-lower' },
        el('div', { class: 'my-piles' }, deckPileEl(state, ctx, seat, true), actions),
        handStripEl(state, ctx, seat, true),
        el('div', { class: 'my-piles' }, discardPileEl(state, ctx, seat, true)),
      ),
    );
  } else {
    panel.append(el('div', { class: 'seat-zones' },
      el('div', { class: 'piles' }, deckPileEl(state, ctx, seat, false), discardPileEl(state, ctx, seat, false)),
      el('div', { class: 'seat-strips' },
        delayedStripEl(state, ctx, seat, false),
        handStripEl(state, ctx, seat, false),
      ),
    ));
  }
  return panel;
}
