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
- Both players' names, ratings and accuracy either side of the board
- Pieces slide, and moves, captures and checks each sound different — synthesised in
  the browser, so no audio files and nothing to download
- Right-click a square to highlight it, right-drag for an arrow, left-click to clear
- A link straight to the game's analysis board on Chess.com when it came from there

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
- A link out to a lesson for whichever motif you keep repeating

---

## Running it

Requires Node 22+ (better-sqlite3 needs it) and a Stockfish binary.

```bash
# Stockfish
apt install stockfish        # or: brew install stockfish

npm install
npm run dev                  # API on :8787, UI on :5173
```

Open http://localhost:5173 and import a username.

### On a phone — analyse on the computer, read anywhere

The engine is a native Stockfish process and the database is a file on disk, so the
analysis stays on the computer. The results do not have to. Export a snapshot:

```bash
npm run build
npm run export                    # → server/exports/leaksheet-<you>-<date>.html
```

That writes **one self-contained HTML file** — the whole app, every number, the board
replay, the coaching text and the fonts, all inside it. Put it on your phone however you
like (cable, Drive, mail it to yourself), open it, and the leak sheet is there. No server,
no network, no install, nothing to keep running. The current 44-game database exports to
about 1 MB.

It also writes a `.leaksheet.json.gz` alongside it. That is the same data without the app
wrapped around it: open it from **Settings → open snapshot** in an already-installed copy,
and it is kept in IndexedDB so the phone remembers it.

A snapshot is read-only by construction — importing and analysis need the engine. The
masthead says when it was taken, so a month-old sheet is never mistaken for today's form.
To update it, export again.

Two flags, both rarely needed: `--coaching` asks Claude for any scope that has not got
coaching cached yet, and `--with-fallback` adds an uncompressed copy of the payload for
browsers without `DecompressionStream`, which roughly quadruples the file.

### Reading it on the same network instead

If the computer is on anyway, the phone can just open it over Wi-Fi — both servers bind
every interface and the client calls the API at a relative `/api`:

```bash
npm start                         # or: npm run dev
hostname -I                       # macOS: ipconfig getifaddr en0
```

Then `http://<that-address>:8787` on the phone (`:5173` under `npm run dev`). Use the IP
rather than a hostname; Vite rejects unknown hostnames unless they are in
`server.allowedHosts`. In Chrome, **⋮ → Add to Home screen** installs it standalone.

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

The three typefaces are self-hosted from `web/public/fonts` (latin subsets, 224 KB over
nine files) rather than fetched from Google, because an exported snapshot has to render
with no network at all. `npm run fonts` regenerates them.

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
  export.ts      Freezes a player into a portable snapshot
web/
  screens/       Dashboard, Library, Review, Patterns, Import, Settings
  components/    Board, baseline bars, time-class band, masthead
  snapshot.ts    Serves the read endpoints when there is no server
  styles.css     The design system
  public/fonts/  Self-hosted typefaces, so an export needs no network
```

## Tests

```bash
npm test
```

Covers the scoring model, PGN and clock parsing, time-class inference, motif detection,
the aggregation layer and snapshot inlining. The analysis tests run a real engine against fixture games —
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
- **Only the dark squares are drawn.** The light ones are the board itself, so no two
  painted squares share an edge and no seam can saw along the diagonals.
- **Your markup is teal**, which is neither the vermilion of your mistakes nor the green
  of the engine's move — a square you marked is never mistaken for a finding.
- **A snapshot says when it was taken.** The one risk of reading a frozen sheet is
  mistaking last month's form for today's, so the date is in the masthead, not buried.
