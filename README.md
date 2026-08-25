# 🂡 Card Party

A peer-to-peer tabletop card game that runs entirely as a static site (GitHub
Pages friendly). No server, no accounts, no rules — everything on the table is
public and the honor system is the only referee.

## Features

- **Peer-to-peer rooms for up to 10 players** — WebRTC data channels via
  [PeerJS](https://peerjs.com) (vendored locally; only its free public
  signaling server is used to broker connections). The host's browser is the
  authoritative source of truth and relays state to everyone.
- **Graceful reconnection** — your player identity persists in the browser, so
  if you drop or close the tab you can rejoin the same room and **repossess
  your original seat, cards, and zones**. The host can even close their tab
  and restore the whole room later under the same code.
- **Host admin** — kick players, kick + block (with unblock), and "return
  every card to its owner's deck".
- **Four public zones per player** — Deck, Hand, Discard, and a **Delayed**
  space where cards are placed face-up in front of you. All four are visible
  to every player (yes, decks and hands too — click any pile to browse it).
- **Move anything anywhere** — drag a card onto any zone of any player, or use
  the card's detail dialog for precise moves (top/bottom of a deck, another
  player's hand, etc.). Cards always remember and display their **original
  owner**.
- **Card upgrades** — every card has two upgrade options, each with its own
  description. A card can have exactly one option selected (or none).
- **Deck builder fed live from a Google Sheet** — build decks by hand or
  randomly from the card library, save multiple named decks locally, and swap
  decks mid-game.

## Hosting on GitHub Pages

The repo ships with a `Deploy to GitHub Pages` workflow. One-time setup:

1. In the repo: **Settings → Pages → Build and deployment → Source → GitHub
   Actions**.
2. Push to `main` (or run the workflow manually). The site deploys to
   `https://<user>.github.io/<repo>/`.

Any other static host (or `python -m http.server` locally) works too — HTTPS
or `localhost` is required for WebRTC.

## The Google Sheet card list

Create a sheet, share it as **"Anyone with the link can view"**, and give it a
header row with these columns (order doesn't matter, names are matched
loosely):

| Title | Description | Keywords | Upgrade 1 | Upgrade 2 |
|-------|-------------|----------|-----------|-----------|
| Time Bomb | Delayed: after two of your turns, it goes off. | Delayed | Bigger boom. | You choose when it goes off. |

- **Keywords** is a comma-separated list (e.g. `Delayed, Shuffle`) and may be
  empty.
- **Upgrade 1 / Upgrade 2** hold each upgrade option's description.

Paste the sheet's URL (or bare ID) into the **Decks** screen and hit *Load*.
The list is fetched live each time you load it; a built-in demo card set is
available until you configure a sheet.

## Playing

1. Everyone opens the site, sets a name, and (optionally) builds a deck on the
   **Decks** screen.
2. One player clicks **Host a new room** and shares the 5-letter room code.
3. Others enter the code and **Join**. Each player arrives with their active
   deck, shuffled.
4. Tap your deck to draw. Drag cards anywhere — into other players' hands,
   decks, discard piles or Delayed spaces; there are no enforced rules.
   Hover a card to read it, click it to pick it up (upgrades, precise moves).
   Cards slide across the felt when anyone moves them, and card backs are
   colored by their original owner.

### Reconnecting

- **A player drops:** they show as disconnected but keep their seat and cards.
  Rejoining the room (the home screen offers a one-click *Rejoin*) from the
  same browser restores everything.
- **The host drops:** clients keep retrying automatically. The host reopens
  the site and clicks *Restore your room* — same code, same table — and
  everyone reconnects on their own.

## Development

No build step, no dependencies to install. Serve the directory statically:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

Code layout:

| File | Role |
|------|------|
| `js/game.js` | Pure game-state model + action reducer (host-authoritative) |
| `js/net.js` | PeerJS host/client sessions, heartbeats, reconnect logic |
| `js/sheet.js` | Google Sheet (gviz) card-library loader + demo cards |
| `js/deckui.js` | Deck-builder screen |
| `js/ui.js` | Game-table renderer, modals, drag & drop, toasts |
| `js/main.js` | App wiring: views, sessions, persistence |
