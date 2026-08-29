// DOM helpers, toasts, modals, and the game-table renderer.
//
// The table is drawn to look and feel physical: cards keep real card
// proportions with paper faces and owner-colored backs, decks are stacked
// piles, hands fan out, placed cards sit at slightly crooked angles, and a
// FLIP pass animates every card sliding across the felt between re-renders.

import { ZONES, ZONE_LABELS, getPlayer, getBoard, playerOn, findCard, normalizeUpgrade, normalizeCategory, categoryLabel, guideHue } from './game.js';

// Upgrade display names come from the sheet's sticker columns: a "Hamburger"
// sticker makes it the Hamburger upgrade. Fall back to A/B when unstickered.
function upgradeInfo(card, i) {
  const u = normalizeUpgrade(card.upgrades?.[i]);
  return { ...u, name: u.sticker || (i === 0 ? 'A' : 'B'), longName: u.sticker || 'Option ' + (i === 0 ? 'A' : 'B') };
}

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

// Keyword descriptions from the sheet's Keywords tab: hovering a keyword
// shows a popup that follows the mouse (a tap does the same on touch).
let KW_DEFS = {};
export function setKeywordDefs(map) {
  KW_DEFS = map && typeof map === 'object' ? map : {};
}

export function kwEl(k) {
  const desc = KW_DEFS[String(k).toLowerCase()];
  const chip = el('span', { class: 'kw' + (desc ? ' has-def' : ''), text: k });
  // Every tag gets its own stable color, derived from its name.
  chip.style.setProperty('--kw', guideHue(k));
  if (desc) {
    const show = (e) => showKwTip(k, desc, e.clientX, e.clientY);
    chip.addEventListener('mouseenter', show);
    chip.addEventListener('mousemove', show); // the popup follows the mouse
    chip.addEventListener('mouseleave', hideKwTip);
    // Touch devices have no hover: a tap shows the popup briefly instead.
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      show(e);
      clearTimeout(kwTapTimer);
      kwTapTimer = setTimeout(hideKwTip, 2500);
    });
  }
  return chip;
}

let kwTapTimer = null;

function showKwTip(k, desc, x, y) {
  const tip = document.getElementById('kw-tip');
  if (!tip) return;
  tip.replaceChildren(el('strong', { text: k }), el('span', { text: desc }));
  tip.classList.add('show');
  // Position by the cursor, nudged so it never leaves the viewport.
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  let left = x + 14;
  let top = y + 18;
  if (left + w > window.innerWidth - 8) left = Math.max(8, x - w - 14);
  if (top + h > window.innerHeight - 8) top = Math.max(8, y - h - 12);
  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
}

export function hideKwTip() {
  document.getElementById('kw-tip')?.classList.remove('show');
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

// ---------- themed dialogs (in place of native prompt/confirm/alert) ----------
// They live in their own layer above the modal, so a modal can open one.

function baseDialog({ title, message, input = false, numeric = false, value = '', okText = 'OK', cancelText = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    const root = document.getElementById('dialog-root');
    if (!root) return resolve(input ? null : false);
    let inputEl = null;
    let inputRow = null;
    const done = (result) => {
      root.replaceChildren();
      document.removeEventListener('keydown', onKey, true);
      resolve(result);
    };
    const submit = () => done(input ? inputEl.value : true);
    const cancel = () => done(input ? null : false);
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); cancel(); }
    };
    if (input) {
      inputEl = el('input', { value: String(value) });
      if (numeric) inputEl.setAttribute('inputmode', 'numeric');
      inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
      // Numbers get −/+ steppers around the input for quick nudges;
      // typing an exact value still works.
      if (numeric) {
        const step = (d) => {
          const n = Math.round(Number(inputEl.value));
          inputEl.value = String((Number.isFinite(n) ? n : 0) + d);
        };
        inputRow = el('div', { class: 'dialog-stepper' },
          el('button', { class: 'btn step-minus', text: '−', onClick: () => step(-1) }),
          inputEl,
          el('button', { class: 'btn step-plus', text: '+', onClick: () => step(1) }),
        );
      }
    }
    document.addEventListener('keydown', onKey, true);
    const overlay = el('div', { class: 'dialog-overlay', onClick: (e) => { if (e.target === overlay) cancel(); } },
      el('div', { class: 'dialog' },
        title ? el('h3', { text: title }) : null,
        message ? el('p', { class: 'dialog-msg', text: message }) : null,
        inputRow || inputEl,
        el('div', { class: 'dialog-actions' },
          cancelText != null ? el('button', { class: 'btn dialog-cancel', text: cancelText, onClick: cancel }) : null,
          el('button', { class: 'btn primary' + (danger ? ' danger-solid' : ''), text: okText, onClick: submit }),
        ),
      ),
    );
    root.replaceChildren(overlay);
    if (inputEl) { inputEl.focus(); inputEl.select(); }
  });
}

// Resolves to the entered string, or null if cancelled.
export function uiPrompt(title, value = '', okText = 'OK') {
  return baseDialog({ title, input: true, value, okText });
}
// Number entry with −/+ steppers beside the input.
export function uiPromptNumber(title, value, okText = 'Set') {
  return baseDialog({ title, input: true, numeric: true, value, okText });
}
// Resolves to true/false.
export function uiConfirm(message, { title = '', okText = 'OK', danger = false } = {}) {
  return baseDialog({ title, message, okText, danger });
}
export function uiAlert(message, title = '') {
  return baseDialog({ title, message, cancelText: null });
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
  hideKwTip();
  const { kind, params } = modal;
  let title = '';
  let body = null;

  if (!modalCtx) {
    return root.replaceChildren();
  } else if (kind === 'card') {
    const card = modalCtx.state.cards[params.cardId];
    if (!card) return closeModal();
    title = card.title;
    body = cardModalBody(modalCtx.state, modalCtx.ctx, card);
  } else if (kind === 'zone') {
    const board = getBoard(modalCtx.state, params.boardId);
    if (!board) return closeModal();
    title = `${board.name} — ${ZONE_LABELS[params.zone]} (${board.zones[params.zone].length})`;
    body = zoneModalBody(modalCtx.state, modalCtx.ctx, board, params.zone, params);
  } else if (kind === 'admin') {
    title = 'Host admin';
    body = adminModalBody(modalCtx.state, modalCtx.ctx);
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

// ---------- shared card rendering ----------

export function ownerColor(state, ownerId) {
  const i = state.boards.findIndex((b) => b.boardId === ownerId);
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
    class: `card ${size} cat-${normalizeCategory(card.category)}` + (card.upgrade != null ? ' upgraded' : ''),
    dataset: interactive ? { cardId } : null,
    draggable: interactive ? 'true' : null,
  });
  node.style.setProperty('--owner', ownerColor(state, card.ownerId));
  if (normalizeCategory(card.category) === 'spirit') {
    node.style.setProperty('--sg', guideHue(card.spiritGuide));
  }

  const face = el('div', { class: 'card-face' });
  face.append(el('div', { class: 'card-titlebar' },
    el('span', { class: 'card-title', text: card.title }),
  ));

  const foreign = opts.zoneOwnerId && opts.zoneOwnerId !== card.ownerId;
  if (foreign) {
    face.append(el('div', { class: 'card-owner', text: card.ownerName + '’s' }));
  }

  if (card.keywords.length) {
    face.append(el('div', { class: 'card-keywords' }, card.keywords.map(kwEl)));
  }
  if (card.description) {
    face.append(el('div', { class: 'card-desc', text: card.description }));
  }

  // Every card prints its full text, upgrade options included — like the
  // physical card would. The chosen upgrade is gilded.
  const ups = [upgradeInfo(card, 0), upgradeInfo(card, 1)];
  if (ups[0].text || ups[1].text) {
    face.append(el('div', { class: 'card-ups' },
      [0, 1].map((i) => ups[i].text
        ? el('div', { class: 'up-line' + (card.upgrade === i ? ' sel' : '') },
            el('span', { class: 'up-star', text: '★' + ups[i].name }),
            el('span', { class: 'up-text', text: ups[i].text }))
        : null)));
  }
  // The category is printed at the foot of every card.
  face.append(el('div', { class: 'card-cat', text: categoryLabel(card) }));
  node.append(face);
  if (card.upgrade != null && size !== 'big') {
    node.append(el('div', { class: 'card-upgrade-tag', text: '★' + upgradeInfo(card, card.upgrade).name }));
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
    enableTouchDrag(node, ctx, () => cardId);
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

export function makeDropTarget(node, ctx, boardId, zone) {
  // Tagged for the touch-drag hit test as well as HTML5 DnD.
  node._drop = { boardId, zone };
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
    ctx.dispatch({ type: 'moveCard', cardId, to: { boardId, zone, pos: zone === 'deck' ? 'top' : undefined } });
  });
  return node;
}

// ---------- touch drag ----------
// HTML5 drag-and-drop doesn't exist on touch browsers, so touches get their
// own gesture: HOLD a card briefly to pick it up (a quick swipe still
// scrolls), drag the floating ghost, release over any zone to drop it.

const HOLD_MS = 220;        // long-press before the card lifts
const SCROLL_SLOP = 12;     // movement before the hold that means "scrolling"
const MIN_DROP_DIST = 15;   // movement required for the release to count as a drop

let touchDragActive = false;
let swallowClicksUntil = 0;

// A drag's release also fires a click on some browsers — swallow it.
document.addEventListener('click', (e) => {
  if (Date.now() < swallowClicksUntil) {
    e.stopPropagation();
    e.preventDefault();
  }
}, true);

function dropTargetAt(x, y) {
  for (const el of document.elementsFromPoint(x, y)) {
    if (el._drop) return el;
  }
  return null;
}

function clearDropHints() {
  for (const n of document.querySelectorAll('.drop-hint')) n.classList.remove('drop-hint');
}

function enableTouchDrag(node, ctx, getCardId) {
  node.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return; // desktop keeps HTML5 DnD
    const cardId = getCardId();
    if (!cardId || touchDragActive) return;

    const startX = e.clientX, startY = e.clientY;
    let lastX = startX, lastY = startY;
    let dragging = false;
    let ghost = null;
    let grabDX = 0, grabDY = 0;

    const lift = () => {
      dragging = true;
      touchDragActive = true;
      hidePeek();
      hideKwTip();
      const r = node.getBoundingClientRect();
      grabDX = lastX - r.left;
      grabDY = lastY - r.top;
      ghost = node.cloneNode(true);
      ghost.classList.add('touch-ghost');
      Object.assign(ghost.style, {
        position: 'fixed',
        left: (lastX - grabDX) + 'px',
        top: (lastY - grabDY) + 'px',
        width: r.width + 'px',
        height: r.height + 'px',
        margin: '0',
      });
      document.body.append(ghost);
      node.classList.add('dragging');
    };
    const holdTimer = setTimeout(lift, HOLD_MS);

    const cleanup = () => {
      clearTimeout(holdTimer);
      node.removeEventListener('pointermove', onMove);
      node.removeEventListener('pointerup', onUp);
      node.removeEventListener('pointercancel', onCancel);
      document.removeEventListener('touchmove', onTouchMove);
      if (ghost) ghost.remove();
      node.classList.remove('dragging');
      clearDropHints();
      if (dragging) {
        touchDragActive = false;
        swallowClicksUntil = Date.now() + 400;
      }
    };

    const onMove = (ev) => {
      lastX = ev.clientX;
      lastY = ev.clientY;
      if (!dragging) {
        // Moving before the hold completes is a scroll, not a drag.
        if (Math.hypot(lastX - startX, lastY - startY) > SCROLL_SLOP) cleanup();
        return;
      }
      ghost.style.left = (lastX - grabDX) + 'px';
      ghost.style.top = (lastY - grabDY) + 'px';
      const target = dropTargetAt(lastX, lastY);
      clearDropHints();
      if (target) target.classList.add('drop-hint');
    };

    // Once the card is lifted, the page must not scroll under the drag.
    const onTouchMove = (ev) => {
      if (dragging) ev.preventDefault();
    };

    const onUp = () => {
      if (dragging && Math.hypot(lastX - startX, lastY - startY) >= MIN_DROP_DIST) {
        const target = dropTargetAt(lastX, lastY);
        if (target) {
          const { boardId, zone } = target._drop;
          ctx.dispatch({ type: 'moveCard', cardId, to: { boardId, zone, pos: zone === 'deck' ? 'top' : undefined } });
        }
      }
      cleanup();
    };
    const onCancel = () => cleanup();

    node.addEventListener('pointermove', onMove);
    node.addEventListener('pointerup', onUp);
    node.addEventListener('pointercancel', onCancel);
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    try { node.setPointerCapture(e.pointerId); } catch {}
  });
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
  return loc ? loc.board.boardId + ':' + loc.zone : null;
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
  for (const board of state.boards) {
    for (const zone of ZONES) {
      for (const id of board.zones[zone]) flip.locs.set(id, board.boardId + ':' + zone);
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
    loc ? ` · currently in ${loc.board.name}’s ${ZONE_LABELS[loc.zone].toLowerCase()}` : '',
  ));

  // Upgrade options — exactly one may be selected (or none). Named by sticker.
  const upA = upgradeInfo(card, 0);
  const upB = upgradeInfo(card, 1);
  const upgradeBox = el('div', { class: 'upgrade-box' }, el('h4', { text: 'Upgrade' }));
  const options = [
    { choice: null, label: 'Not upgraded', desc: '' },
    { choice: 0, label: upA.longName, desc: upA.text || '(blank)' },
    { choice: 1, label: upB.longName, desc: upB.text || '(blank)' },
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

  // No move controls here — cards move by dragging them (hold to lift on
  // touch), onto any zone of any board.
  return wrap;
}

// ---------- zone modal (browse any pile — everything is public) ----------

function zoneModalBody(state, ctx, board, zone, params) {
  const wrap = el('div', { class: 'zone-browser' });
  const canEdit = board.boardId === ctx.myBoardId || ctx.isHost;

  // Clicking a pool shows its CARDS. The deck builder (library, random,
  // draft) only appears when you choose to add cards — your own pool
  // always, every pool for the host. Added cards belong to the pool's board.
  if (zone === 'deck' && canEdit && ctx.poolTools && params?.adding) {
    wrap.append(
      el('div', { class: 'zone-note' },
        el('button', {
          class: 'btn small', id: 'pool-add-done', text: '← Back to the pool',
          onClick: () => { params.adding = false; refreshModal(); },
        }),
        el('span', { text: 'Adding cards to this pool' }),
      ),
      ctx.poolTools(board.boardId),
    );
    return wrap;
  }
  if (zone === 'deck') {
    wrap.append(el('div', { class: 'zone-note' },
      el('span', { text: 'Top card first. ' }),
      el('button', {
        class: 'btn small', text: 'Shuffle',
        onClick: () => { ctx.dispatch({ type: 'shuffle', boardId: board.boardId, zone: 'deck' }); toast('Pool shuffled'); },
      }),
      canEdit && ctx.poolTools ? el('button', {
        class: 'btn small primary', id: 'pool-add-cards', text: '+ Add cards',
        title: 'Open the card library to add cards to this pool',
        onClick: () => { params.adding = true; refreshModal(); },
      }) : null,
    ));
  }
  const ids = board.zones[zone];
  if (!ids.length) wrap.append(el('p', { class: 'empty', text: 'Empty.' }));
  ids.forEach((cardId, i) => {
    const card = state.cards[cardId];
    if (!card) return;
    const row = el('div', { class: 'zone-row' },
      zone === 'deck' ? el('span', { class: 'zone-index', text: String(i + 1) }) : null,
      el('div', { class: 'zone-row-info' },
        el('span', { class: 'zone-row-title', text: card.title }),
        card.keywords.length ? el('span', { class: 'card-keywords' }, card.keywords.map(kwEl)) : null,
      ),
      el('div', { class: 'zone-row-actions' },
        el('button', { class: 'btn small', text: 'View', onClick: () => openModal('card', { cardId }) }),
        ctx.myBoardId ? el('button', {
          class: 'btn small', text: '→ my hand',
          onClick: () => ctx.dispatch({ type: 'moveCard', cardId, to: { boardId: ctx.myBoardId, zone: 'hand' } }),
        }) : null,
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
  for (const player of state.players) {
    if (player.playerId === state.hostPlayerId) continue;
    const status = !player.connected ? ' (disconnected)' : (player.boardId ? '' : ' (spectating)');
    wrap.append(el('div', { class: 'admin-row' },
      el('span', { class: 'dot ' + (player.connected ? 'on' : 'off') }),
      el('span', { class: 'admin-name', text: player.name + status }),
      el('button', {
        class: 'btn small', text: 'Rename',
        onClick: async () => {
          const name = await uiPrompt(`New name for ${player.name}`, player.name, 'Rename');
          if (name != null && name.trim()) ctx.dispatch({ type: 'rename', playerId: player.playerId, name });
        },
      }),
      el('button', {
        class: 'btn small danger', text: 'Kick',
        onClick: async () => {
          if (await uiConfirm(`Their board and cards stay on the table; they can rejoin any time.`, { title: `Kick ${player.name}?`, okText: 'Kick', danger: true })) ctx.kick(player.playerId);
        },
      }),
    ));
  }
  if (state.players.length <= 1) wrap.append(el('p', { class: 'empty', text: 'No other players yet.' }));

  // Boards are independent of players — they stay when a player leaves.
  // Removing one takes its cards off the table for good.
  wrap.append(el('h4', { text: 'Boards' }));
  for (const board of state.boards) {
    const player = playerOn(state, board.boardId);
    const status = player
      ? (player.connected ? `played by ${player.name}` : `${player.name} — away`)
      : 'open';
    wrap.append(el('div', { class: 'admin-row' },
      el('span', { class: 'dot ' + (player?.connected ? 'on' : 'off') }),
      el('span', { class: 'admin-name', text: `${board.name} · ${status}` }),
      el('button', {
        class: 'btn small', text: 'Rename',
        onClick: async () => {
          const name = await uiPrompt(`New name for the board “${board.name}”`, board.name, 'Rename');
          if (name != null && name.trim()) ctx.dispatch({ type: 'renameBoard', boardId: board.boardId, name });
        },
      }),
      board.boardId !== ctx.myBoardId ? el('button', {
        class: 'btn small danger', text: 'Remove board',
        onClick: async () => {
          if (await uiConfirm('Its cards leave the table for good.', { title: `Remove ${board.name}’s board?`, okText: 'Remove board', danger: true })) {
            ctx.dispatch({ type: 'removeBoard', boardId: board.boardId });
          }
        },
      }) : null,
    ));
  }
  // Set up an extra open board (seeded with the Base cards) without leaving
  // your own — e.g. prepared for a player who hasn't arrived yet.
  wrap.append(el('button', {
    class: 'btn', id: 'admin-add-board', text: 'Add an open board',
    title: 'Add a board nobody is playing yet — anyone can take it with “Play this board”',
    onClick: async () => {
      const name = await uiPrompt('Name for the new board', 'Board ' + (state.boards.length + 1), 'Add board');
      if (name != null && name.trim()) ctx.addBoard?.(name);
    },
  }));

  wrap.append(el('h4', { text: 'Table' }));
  wrap.append(el('button', {
    class: 'btn', id: 'admin-reload-sheet', text: 'Reload cards from the sheet',
    title: 'Re-fetch the card sheet and update the text of every card in play — nothing leaves anyone’s hand or board',
    onClick: () => ctx.reloadSheet?.(),
  }), ' ');
  wrap.append(el('button', {
    class: 'btn', id: 'admin-reset-block', text: 'Reset everyone’s block to 0',
    title: 'Set the block number on every board back to 0',
    onClick: () => { ctx.dispatch({ type: 'resetBlock' }); toast('Block reset to 0 on every board'); },
  }), ' ');
  wrap.append(el('button', {
    class: 'btn warn', text: 'Return all cards to their owners’ pools',
    onClick: async () => {
      if (await uiConfirm('Every card goes back to its owner board’s pool, shuffled.', { title: 'Return all cards?', okText: 'Return all' })) {
        ctx.dispatch({ type: 'returnAll' });
        toast('All cards returned home');
      }
    },
  }));

  // Save/load the whole game for sessions spanning multiple sittings.
  wrap.append(el('h4', { text: 'Save & load' }));
  const fileInput = el('input', { type: 'file', accept: 'application/json,.json', id: 'admin-load-file' });
  fileInput.style.display = 'none';
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    if (await uiConfirm('It replaces the whole game — every board, player, card, and zone — with the saved one.', { title: 'Load this save?', okText: 'Load' })) {
      ctx.loadGame?.(file);
    }
  });
  wrap.append(el('div', { class: 'admin-saveload' },
    el('button', {
      class: 'btn', id: 'admin-save-game', text: 'Save game to file',
      title: 'Download the entire game — every board and player, every card and where it sits — as one file',
      onClick: () => ctx.saveGame?.(),
    }),
    el('button', {
      class: 'btn', text: 'Load game from file',
      title: 'Restore a previously saved game; players rejoin to reclaim their boards',
      onClick: () => fileInput.click(),
    }),
    fileInput,
  ));
  return wrap;
}

// ---------- game table ----------

export function renderGame(root, state, ctx) {
  modalCtx = { state, ctx };
  captureRects(root);
  hidePeek();
  hideKwTip();
  root.replaceChildren();

  const me = getPlayer(state, ctx.myId);
  const myBoard = me?.boardId ? getBoard(state, me.boardId) : null;
  const otherBoards = state.boards.filter((b) => b !== myBoard);
  const watchers = state.players.filter((p) => p.connected && !p.boardId);

  // Top bar
  // Invite link: https://<site>/<room code> — the 404 redirect turns it back
  // into ?room=<code> for auto-joining.
  const inviteLink = () => {
    const dir = location.pathname.endsWith('/') ? location.pathname : location.pathname.replace(/[^/]*$/, '');
    return location.origin + dir + state.roomCode;
  };
  root.append(el('div', { class: 'game-topbar' },
    el('div', { class: 'room-info' },
      el('button', {
        class: 'room-code', title: 'Copy an invite link others can click to join',
        onClick: () => { navigator.clipboard?.writeText(inviteLink()).then(() => toast('Invite link copied')); },
      }, 'Room ', el('strong', { text: state.roomCode }), ' ⧉'),
      el('span', { class: 'pill ' + ctx.status, text: statusLabel(ctx) }),
      el('span', { class: 'pill', text: `${state.players.length}/10 players` }),
      watchers.length ? el('span', {
        class: 'pill', text: `${watchers.length} watching`,
        title: watchers.map((p) => p.name).join(', '),
      }) : null,
    ),
    el('div', { class: 'game-actions' },
      el('button', { class: 'btn small', text: (me ? me.name : 'Name'), title: 'Rename yourself', onClick: ctx.renameSelf }),
      ctx.isHost ? el('button', { class: 'btn small', text: 'Admin', onClick: () => openModal('admin') }) : null,
      el('button', { class: 'btn small danger', text: 'Leave', onClick: ctx.leave }),
    ),
  ));

  const table = el('div', { class: 'table' });
  const grid = el('div', { class: 'others-grid' });
  for (const board of otherBoards) grid.append(seatPanel(state, ctx, board, false));
  table.append(grid);
  if (myBoard) {
    table.append(seatPanel(state, ctx, myBoard, true));
  } else if (me) {
    // No board yet (a new joiner, a spectator, or a player whose board was
    // taken): choose to keep watching, possess an open board, or start fresh.
    const openBoards = state.boards.filter((b) => !playerOn(state, b.boardId)?.connected).length;
    table.append(el('div', { class: 'spectator-bar' },
      el('span', { text: openBoards
        ? `You don’t have a board — watch as long as you like, take over an open board with “Play this board”, or `
        : 'You don’t have a board — watch as long as you like, or ' }),
      el('button', { class: 'btn small primary', id: 'btn-new-board', text: 'Start a new board', onClick: ctx.newBoard }),
    ));
  }
  root.append(table);

  playAnimations(root, state);
  refreshModal();
}

function statusLabel(ctx) {
  if (ctx.isHost) return 'hosting';
  return ctx.status === 'connected' ? 'connected' : ctx.status + '…';
}

function pileKey(board, zone) {
  return board.boardId + ':' + zone;
}

// The pool: a stack of owner-colored card backs, thickness tracking the count.
function deckPileEl(state, ctx, board, isMe) {
  const count = board.zones.deck.length;
  const layers = Math.max(count > 0 ? 1 : 0, Math.min(4, Math.ceil(count / 6)));
  const stack = el('div', { class: 'pile-stack' });
  for (let i = 0; i < layers; i++) {
    const back = el('div', { class: 'card-back' });
    back.style.setProperty('--owner', ownerColor(state, board.boardId));
    back.style.setProperty('--stack-i', i);
    stack.append(back);
  }
  if (!count) stack.append(el('div', { class: 'pile-empty-mark' }));

  const pile = el('div', {
    class: 'pile deck' + (isMe ? ' mine' : ''),
    dataset: { pile: pileKey(board, 'deck') },
    draggable: count ? 'true' : null,
    title: isMe
      ? 'Click to look through your pool and add cards to it · drag off the top card to draw it'
      : 'Click to look through the pool (pools are public) · drag off the top card to draw it',
    onClick: () => openModal('zone', { boardId: board.boardId, zone: 'deck' }),
    // Dragging the pile picks up its top card — drop it anywhere to draw it there.
    onDragstart: (e) => {
      const top = board.zones.deck[0];
      if (!top) { e.preventDefault(); return; }
      e.dataTransfer.setData('text/plain', top);
      e.dataTransfer.effectAllowed = 'move';
    },
  }, stack, el('div', { class: 'pile-count', text: String(count) }), el('div', { class: 'pile-tag', text: 'Pool' }));
  // Touch: hold the pile to pick up its top card, drag it anywhere to draw it there.
  enableTouchDrag(pile, ctx, () => board.zones.deck[0]);
  return makeDropTarget(pile, ctx, board.boardId, 'deck');
}

// Discard: the top card lies face-up, slightly crooked, on a soft stack.
function discardPileEl(state, ctx, board, isMe) {
  const ids = board.zones.discard;
  const topId = ids[ids.length - 1];
  const pile = el('div', {
    class: 'pile discard' + (topId ? ' has-cards' : ''),
    dataset: { pile: pileKey(board, 'discard') },
    title: 'Click to browse the discard pile · drop a card to discard it here',
    onClick: () => openModal('zone', { boardId: board.boardId, zone: 'discard' }),
  });
  if (topId) {
    const card = cardEl(state, ctx, topId, { size: isMe ? 'table' : 'mini', zoneOwnerId: board.boardId });
    pile.append(slot(card, { rot: jitterDeg(topId, 5) }));
  } else {
    pile.append(el('div', { class: 'pile-empty-mark' }));
  }
  pile.append(el('div', { class: 'pile-count', text: String(ids.length) }), el('div', { class: 'pile-tag', text: 'Discard' }));
  return makeDropTarget(pile, ctx, board.boardId, 'discard');
}

function delayedStripEl(state, ctx, board, isMe) {
  const ids = board.zones.delayed;
  const strip = el('div', { class: 'zone-strip delayed', dataset: { pile: pileKey(board, 'delayed') } },
    el('div', { class: 'strip-label', text: 'Delayed' }),
    el('div', { class: 'strip-cards' },
      ids.map((id) => slot(
        cardEl(state, ctx, id, { size: isMe ? 'table' : 'mini', zoneOwnerId: board.boardId }),
        { rot: jitterDeg(id) },
      )),
    ),
  );
  return makeDropTarget(strip, ctx, board.boardId, 'delayed');
}

function handStripEl(state, ctx, board, isMe) {
  const ids = board.zones.hand;
  const strip = el('div', { class: 'zone-strip hand', dataset: { pile: pileKey(board, 'hand') } },
    el('div', { class: 'strip-label', text: 'Hand' }),
    el('div', { class: 'strip-cards' },
      // Side by side, never overlapping — just a slight hand-placed tilt.
      ids.map((id) => slot(
        cardEl(state, ctx, id, { size: isMe ? 'hand' : 'mini', zoneOwnerId: board.boardId }),
        { rot: jitterDeg(id, 1.2) },
      )),
    ),
  );
  return makeDropTarget(strip, ctx, board.boardId, 'hand');
}

// Energy / block / momentum counters + optional board state (from the
// sheet's States tab). Honor system like everything else: anyone can
// adjust any board's numbers.
function statCtl(ctx, board, key, label) {
  return el('span', { class: 'stat' },
    el('span', { class: 'stat-label', text: label }),
    el('button', {
      class: `stat-val ${key}-val`, text: String(board[key]),
      title: `Set ${label.toLowerCase()} for ${board.name}`,
      onClick: async () => {
        const v = await uiPromptNumber(`${label} for ${board.name}`, String(board[key]));
        if (v == null || !v.trim()) return;
        const n = Math.round(Number(v));
        if (Number.isFinite(n)) ctx.dispatch({ type: 'setStat', boardId: board.boardId, stat: key, value: n });
      },
    }),
  );
}

function boardStatsEl(state, ctx, board) {
  const row = el('div', { class: 'board-stats' },
    statCtl(ctx, board, 'energy', 'Energy'),
    statCtl(ctx, board, 'block', 'Block'),
    statCtl(ctx, board, 'momentum', 'Momentum'),
  );

  const defs = ctx.stateDefs ? ctx.stateDefs() : [];
  if (defs.length || board.state) {
    const sel = el('select', { class: 'state-sel' },
      el('option', { value: '', text: '— no state —' }),
      defs.map((d) => {
        const opt = el('option', { value: d.name, text: d.name, title: d.desc });
        if (d.name === board.state) opt.selected = true;
        return opt;
      }),
      // A state set before the sheet changed stays selectable.
      board.state && !defs.some((d) => d.name === board.state)
        ? (() => { const o = el('option', { value: board.state, text: board.state }); o.selected = true; return o; })()
        : null,
    );
    sel.addEventListener('change', () => ctx.dispatch({ type: 'setBoardState', boardId: board.boardId, state: sel.value }));
    // Hovering the state shows its description by the mouse, like keywords.
    const descOf = () => defs.find((d) => d.name === (sel.value || board.state))?.desc || '';
    sel.addEventListener('mouseenter', (e) => { const d = descOf(); if (d) showKwTip(sel.value || board.state, d, e.clientX, e.clientY); });
    sel.addEventListener('mousemove', (e) => { const d = descOf(); if (d) showKwTip(sel.value || board.state, d, e.clientX, e.clientY); });
    sel.addEventListener('mouseleave', hideKwTip);
    row.append(el('label', { class: 'state-wrap' }, el('span', { class: 'state-label', text: 'State' }), sel));
  }
  return row;
}

// One board on the table. The head shows the board's identity plus who is
// playing it right now; a board with no connected player offers a
// "Play this board" button so anyone can possess it.
function seatPanel(state, ctx, board, isMe) {
  const player = playerOn(state, board.boardId);
  const online = !!player?.connected;
  const panel = el('div', { class: 'seat' + (isMe ? ' me' : '') + (online ? '' : ' offline') });
  panel.style.setProperty('--seat-color', ownerColor(state, board.boardId));

  panel.append(el('div', { class: 'seat-head' },
    el('span', {
      class: 'dot ' + (online ? 'on' : 'off'),
      title: online ? 'Connected' : (player ? 'Player away' : 'No player on this board'),
    }),
    el('span', { class: 'seat-name', text: board.name }),
    // Board names are their own thing, so always show who's playing it.
    player
      ? el('span', { class: 'seat-sub', text: isMe ? 'played by you' : `played by ${player.name}` })
      : el('span', { class: 'seat-sub', text: 'open board' }),
    player && player.playerId === state.hostPlayerId ? el('span', { class: 'badge', text: 'HOST' }) : null,
    (isMe || ctx.isHost) ? el('button', {
      class: 'btn small rename-board', text: '✎', title: 'Rename this board',
      onClick: async () => {
        const name = await uiPrompt('Board name', board.name, 'Rename');
        if (name != null && name.trim()) ctx.dispatch({ type: 'renameBoard', boardId: board.boardId, name });
      },
    }) : null,
    isMe ? el('button', {
      class: 'btn small unpossess-btn', text: 'Unpossess',
      title: 'Step away and spectate — the board and its cards stay on the table for anyone to take',
      onClick: () => ctx.dispatch({ type: 'possessBoard', boardId: null }),
    }) : null,
    !isMe && !online ? el('button', {
      class: 'btn small claim-btn', text: 'Play this board',
      title: player
        ? `Take over while ${player.name} is away`
        : `Possess this board and play as ${board.name}`,
      onClick: () => ctx.dispatch({ type: 'possessBoard', boardId: board.boardId }),
    }) : null,
  ));

  panel.append(boardStatsEl(state, ctx, board));

  if (isMe) {
    const actions = el('div', { class: 'pile-actions' },
      el('button', { class: 'btn small primary', text: 'Draw', onClick: () => ctx.dispatch({ type: 'draw', n: 1 }) }),
      el('button', { class: 'btn small', text: 'Shuffle', onClick: () => { ctx.dispatch({ type: 'shuffle', zone: 'deck' }); toast('Deck shuffled'); } }),
    );
    panel.append(
      delayedStripEl(state, ctx, board, true),
      el('div', { class: 'my-lower' },
        el('div', { class: 'my-piles' }, deckPileEl(state, ctx, board, true), actions),
        handStripEl(state, ctx, board, true),
        el('div', { class: 'my-piles' }, discardPileEl(state, ctx, board, true)),
      ),
    );
  } else {
    panel.append(el('div', { class: 'seat-zones' },
      el('div', { class: 'piles' }, deckPileEl(state, ctx, board, false), discardPileEl(state, ctx, board, false)),
      el('div', { class: 'seat-strips' },
        delayedStripEl(state, ctx, board, false),
        handStripEl(state, ctx, board, false),
      ),
    ));
  }
  return panel;
}
