# ChessCoach — Leak Sheet

A personal chess-improvement app. It imports your Chess.com games, runs Stockfish over
every move, and tells you **what you keep getting wrong** — not what went wrong in one
game.

Free review tools are single-game: you open a game, get a grade, move on. The value here
is aggregation over time — a sheet of recurring mistake patterns, segmented by time
class, with a plain-language coaching layer on top.

---

## What it does

**V1 — single-game review**

- Import by Chess.com username, or paste a PGN
- Stockfish analysis of every move, at a configurable depth
- Per-move classification: brilliant · best · excellent · good · inaccuracy · mistake · blunder
- Per-game accuracy for both sides
- Board replay with an eval bar, the move played and the move the engine wanted

**V2 — cross-game statistics**

- One dashboard over every analysed game
- Accuracy and blunder-rate trend, with each game hung above or below a baseline
- Time-class segmentation (all / bullet / blitz / rapid / daily) filtering every stat
- Mistake breakdown by phase (opening / middlegame / endgame)
- Win rate by opening, from the ECO codes in the PGN

**V3 — pattern detection and coaching**

- Mistakes clustered by *motif* — hung piece, allowed fork, back-rank, traded into a
  losing endgame, walked into a pin, and ten more — rather than by severity alone
- Clock-pressure correlation from the `[%clk]` data in live games
- A Claude-written summary of the recurring weaknesses, with a suggested follow-up
  attached to each pattern

---

## Running it

Requires Node 20+ and a Stockfish binary.

```bash
# Stockfish
apt install stockfish        # or: brew install stockfish

npm install
npm run dev                  # API on :8787, UI on :5173
```

Open http://localhost:5173 and import a username.

### On a phone

The engine is a native Stockfish process and the database is a file on disk, so the
phone is the screen, not the host. Run the app on a computer and open it from the
handset over the same Wi-Fi:

```bash
npm run build && npm start        # or: npm run dev
hostname -I                       # macOS: ipconfig getifaddr en0
```

Then open `http://<that-address>:8787` on the phone — `:5173` if you used `npm run dev`.
Both servers bind every interface, and the client calls the API at a relative `/api`, so
no extra configuration is needed. If nothing loads, the computer's firewall is the usual
cause. Vite rejects unknown *hostnames* for security, so use the IP address, or add the
name to `server.allowedHosts`.

In Chrome, **⋮ → Add to Home screen** installs it: standalone, no browser chrome, with
the status bar carrying the masthead's bone. The layout reflows below 900px — stat tiles
go two-up, the review screen stacks the board above the move sheet, the eval bar turns
horizontal, and the time-class band becomes a swipeable strip.

To run it *on* the phone instead, Termux can do it, but expect a build: Node from
`pkg install nodejs`, a toolchain (`pkg install build-essential python`) for
better-sqlite3's native module, and Stockfish compiled from source — there is no
`pkg install stockfish`. Set `ENGINE_POOL_SIZE=1` and a lower `ANALYSIS_DEPTH`; a phone
will not enjoy three engines at depth 16.

### No Chess.com access?

Some networks block `api.chess.com`. The seed command generates a realistic history
locally — Stockfish plays against a deliberately imperfect opponent, producing games with
genuine blunders, clocks and openings:

```bash
SEED_GAMES=40 npm run seed --workspace server
```

### Production build

```bash
npm run build
npm start                    # serves the built UI and the API on :8787
```

---

## Configuration

Everything is optional; the defaults work.

| Variable | Default | What it does |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | — | Switches the coaching layer from the offline summariser to Claude |
| `COACH_MODEL` | `claude-opus-5` | Model used for the coaching summaries |
| `ANALYSIS_DEPTH` | `16` | Default Stockfish depth (also settable in the UI) |
| `STOCKFISH_PATH` | auto-detected | Path to the engine binary |
| `ENGINE_POOL_SIZE` | cores − 1, max 6 | How many engine processes run in parallel |
| `DATABASE_PATH` | `data/chesscoach.db` | SQLite file |
| `PORT` | `8787` | API port |

Without an API key the app still works end to end — the coaching text is generated
deterministically from the same numbers, in fewer words.

---

## How the analysis works

**Every position is evaluated once.** The eval after a move is the negated eval of the
position the opponent inherits, so an N-move game costs N+1 searches rather than 2N.

**Thresholds are drops in winning chances, not centipawns.** Centipawn loss is a bad
yardstick — losing 300cp at 0.0 is a disaster, losing it at +8.0 is nothing. Centipawns
are converted to a win probability with the standard logistic curve first, and the labels
(inaccuracy ≥ 10, mistake ≥ 20, blunder ≥ 30 percentage points) are applied to that.

**Forced moves are never mistakes.** If there was one legal move, it is not a blunder no
matter what it cost.

**Brilliant means a sacrifice the engine would play** — material given up, still the top
engine move, in a position that is not already won.

**Phase is read off the board**, not the move number: a queenless four-piece position is
an endgame on move 18 as much as on move 60.

**Rating cost is derived, not invented.** A drop in winning chances is a drop in expected
score, and the Elo consequence of losing expected score is K times it. Chess.com uses
K ≈ 10, so a pattern that cost you 4.1 expected points reads as −41 Elo.

---

## Layout

```
server/
  engine.ts      Stockfish UCI process pool
  analysis.ts    PGN → per-move evaluation, classification, clocks
  evaluation.ts  Win-percentage model, accuracy, classification thresholds
  motifs.ts      Why a move lost value — the vocabulary patterns cluster on
  patterns.ts    Mistake clustering and rating cost
  stats.ts       Dashboard aggregation, segmented by time class
  coach.ts       Claude coaching layer, with an offline fallback
  chesscom.ts    Public API client
  seed.ts        Offline demo-history generator
web/
  screens/       Dashboard, Library, Review, Patterns, Import, Settings
  components/    Board, baseline bars, time-class band, masthead
  styles.css     The design system
```

## Tests

```bash
npm test
```

Covers the scoring model, PGN and clock parsing, time-class inference, motif detection
and the aggregation layer. The analysis tests run a real engine against fixture games —
including checking that the app calls Morphy's 13.Rxd7 in the Opera Game brilliant.

---

## Design

The interface is a tournament scoresheet, not a dashboard of cards.

- **No cards.** Structure comes from hairline rules and a shared grid.
- **One chromatic colour.** Vermilion is reserved for *your mistakes*; anything coloured
  on screen cost you something.
- **Chess already has an icon set** — `??  ?  ?!  !!` — so no icon library is loaded.
- **Typography ranks the data.** The blunder rate is 96px because it is the worst number.
- **Time class is a masthead rule**, not a dropdown, because it is the top-level lens:
  blitz mistakes are a time-pressure signal, rapid mistakes are a preparation signal, and
  averaging the two hides both.
- **Pieces are type**, not sprites — Unicode figurines, so the board scales anywhere.
