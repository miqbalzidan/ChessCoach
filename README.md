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
- **The game at a glance** — the whole game as one line above the board, the two
  territories filled in the pieces' own colours. Your own blunders, mistakes,
  inaccuracies and brilliancies sit on it as dots, sized by severity; click anywhere
  on it to put the board there. It is drawn from your side whichever colour you had,
  the same way round as the board and the eval bar, so a cliff is always your own fall
- Both players' names, ratings and accuracy either side of the board
- Pieces slide, and moves, captures and checks each sound different — synthesised in
  the browser, so no audio files and nothing to download
- Right-click a square to highlight it, right-drag for an arrow, left-click to clear
- **analyse** — the position on the board, opened on a free analysis board with an
  engine. This one goes to Lichess, for a reason worth knowing: on a phone the
  Chess.com app claims chess.com links and routes them to Game Review no matter what
  the URL asks for, so a Chess.com link cannot reliably open a board there.
- **chess.com** — the game itself, when it came from there. On a phone this opens the
  Chess.com app, which decides for itself which screen you land on.

**V2 — cross-game statistics**

- One dashboard over every analysed game
- Accuracy and blunder-rate trend, with each game hung above or below a baseline
- Time-class segmentation (all / bullet / blitz / rapid / daily) filtering every stat
- Mistake breakdown by phase (opening / middlegame / endgame)
- Win rate by opening, from the ECO codes in the PGN
- **Filter the whole sheet by opening** — pick one from the openings table, or from
  the band under the time-class rule, and every number on every screen is recomputed
  inside it: the patterns, the phases, the clock, the scouting report, the game list.
  Openings are held per side, because the Berlin as White and the Berlin as Black are
  different problems. The two lenses compose, so "my Sicilian in blitz" is a question
  you can ask.

**V3 — pattern detection and coaching**

- Mistakes clustered by *motif* — hung piece, allowed fork, back-rank, traded into a
  losing endgame, walked into a pin, and ten more — rather than by severity alone
- Clock-pressure correlation from the `[%clk]` data in live games
- A Claude-written summary of the recurring weaknesses, with a suggested follow-up
  attached to each pattern
- A link out to a lesson for whichever motif you keep repeating
- A scouting report: what holds up and what an opponent would aim at, measured
  against the players you actually face rather than an absolute bar

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

The opening filter works offline too: the export writes one frozen sheet per time class
*and* per opening, so the phone can narrow the numbers without an engine behind it.
Settings says how many openings a file carries. That costs about 7% more — the moves are
the bulk of a snapshot and they are shared.

Two flags, both rarely needed: `--coaching` asks Claude for any lens that has not got
coaching cached yet, and `--with-fallback` adds an uncompressed copy of the payload for
browsers without `DecompressionStream`, which roughly quadruples the file.

### No computer at all — run the whole thing on the phone

If there is no computer in the picture, the phone can be the whole app: Stockfish runs
in the browser as WebAssembly and your games live in it. **Settings → this device →
run everything on this device.** Nothing is uploaded and nothing needs to be switched
on somewhere else.

**Installing it.** The built site carries a service worker that precaches everything
it needs — the app, the fonts, the SQLite build and the 1.8 MB engine, about 3.7 MB in
all. Load it once, **Add to Home Screen**, and from then on it opens and analyses with
no network whatsoever.

It has to be served over **HTTPS**. Service workers and OPFS are withheld from any
plain `http://` origin that is not `localhost`, so an `http://` address gives you
neither the install nor the storage — see *Reading it on the same network* below for
what that route can and cannot do.

Publishing is a one-off. **GitHub Pages is free on public repositories only**; on a
private one it asks you to upgrade, so either make the repository public or publish
the built site somewhere else (Cloudflare Pages, Netlify and Vercel all take a private
repo on their free tiers — build `npm run build --workspace web`, publish `web/dist`,
and set `BASE_PATH` to `/` for a root domain). For Pages: enable **Settings → Pages →
Source: GitHub Actions**, then either merge to `main` or run the **CI** workflow from
the Actions tab (**Run workflow**) to publish a branch without merging it. Until Pages
is switched on, that job does nothing — it is your repository and your decision.

**Archive on the computer, top up on the phone.** That is the shape this is built for,
and it is worth following where you can:

| | on a phone | on a computer |
| --- | --- | --- |
| a week's games (5) | seconds | seconds |
| 50 games | a few minutes | under a minute |
| a back archive (300) | the best part of an hour | a few minutes |

So: analyse the archive on a computer, press **export analysis** beside that account
in **Settings** (or run `npm run export` if you prefer a terminal), and open the
`.leaksheet.json.gz` it saves under **Settings → start from a computer's export**. Those games
arrive already analysed, at the depth the computer used — 44 games seed in about a
second — and from then on the phone only has to keep up with what you play. Opening a
newer export later adds just the games since.

The phone can write one of these as well, from the same button. On a device with no
computer behind it that database is the only copy of your games, so exporting is the
only backup there is — and the file seeds a new phone without re-analysing anything.

Getting games onto the phone in the first place: **open a `.pgn` file**. Chess.com
will hand you your whole archive as a download, and the Import screen takes it without
asking the network for anything, so nothing can block it. Importing straight from
Chess.com by username is also offered, but a browser may not be allowed to call their
API — if it is refused, the screen says so and points at the file.

With no computer anywhere, import on the phone anyway. Before starting anything long
the app says how long it will take, measured on that handset rather than guessed, and
the analysis is resumable — leave and come back and it carries on. It is a warning,
not a refusal.

The phone analyses at depth 12 rather than the desktop's 16, and with a different
build of Stockfish. On 179 moves of real games the two agreed on every blunder and
differed only on two borderline inaccuracies, so the leaks are the same leaks — but
the sheet says which engine and depth produced which games rather than pretending one
instrument measured them all.

### Reading it on the same network instead

If the computer is on anyway, the phone can just open it over Wi-Fi — both servers bind
every interface and the client calls the API at a relative `/api`:

```bash
npm start                         # or: npm run dev
hostname -I                       # macOS: ipconfig getifaddr en0
```

Then `http://<that-address>:8787` on the phone (`:5173` under `npm run dev`). Use the IP
rather than a hostname; Vite rejects unknown hostnames unless they are in
`server.allowedHosts`.

**This route reads; it does not install.** A plain `http://` address that is not
`localhost` is not a secure context, and browsers withhold service workers, the cache
API and OPFS from those pages. Measured in Chromium against the built site:
`http://<LAN IP>:5400` reports `isSecureContext: false` and has no
`navigator.serviceWorker` and no `navigator.storage.getDirectory` at all. So there is
nothing to install and nothing to work offline — the sheet renders, because the
computer's server is answering, and that is the whole point of this section.

It also means **"run everything on this device" over a LAN address will not keep your
games**: with no OPFS the database falls back to memory, so an import analyses
correctly and then vanishes on reload. The app now says so on both Settings and
Import rather than letting you find out. For a phone that stores its own games, use an
`https://` address — publish to Pages as above, which is the reason that section
exists.

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

**Brilliant means a sacrifice the engine would play** — material the opponent could
profitably take, still the top engine move, in a position that is not already won.

"Could take" is settled by a full exchange evaluation on the square, read off the
opponent's *legal* moves. That matters more than it sounds. The obvious shortcut —
ask which pieces attack the square — counts pinned pieces and, far more often, an enemy
king standing beside a square its own side defends, which cannot capture into check. A
bishop giving check from a square the king may not enter is perfectly safe, and used to
read as a piece thrown away. Swapping the square off to the end also catches the
opposite error: Morphy's 13. Rxd7 in the Opera Game only shows its cost four ply in, so
a rule that looks one recapture deep cannot see the most famous sacrifice in chess.

**Verdicts can be recomputed without the engine.** Every input to a verdict — both
evaluations, the move played, the engine's choice, the positions either side — is
already a column in the database, so a change to these rules does not mean re-analysing
the archive:

```
npm run reclassify              # say what would change
npm run reclassify -- --write   # change it
```

Reporting is the default because this rewrites a column you cannot regenerate without
running Stockfish over every game again. It only ever touches the verdict; accuracy
comes from win-percentage loss and does not move.

**Phase is read off the board**, not the move number: a queenless four-piece position is
an endgame on move 18 as much as on move 60.

**The scouting report compares you to your own opponents.** Everyone blunders; what
matters is whether you blunder more than the people across the board from you. Using
the opponents in your own games as the baseline controls for rating without having to
know it, and the bar moves up as you improve. Below eight games in a segment the
report declines to say anything — a profile drawn from a handful of games mostly
describes the handful.

**Rating cost is derived, not invented.** A drop in winning chances is a drop in expected
score, and the Elo consequence of losing expected score is K times it. Chess.com uses
K ≈ 10, so a pattern that cost you 4.1 expected points reads as −41 Elo.

---

## Layout

```
core/            No Node, no DOM — so it runs on a server or inside a phone.
  engine.ts      UCI protocol and the engine queue, transport-agnostic
  analysis.ts    PGN → per-move evaluation, classification, clocks
  evaluation.ts  Win-percentage model, accuracy, classification thresholds
  motifs.ts      Why a move lost value — the vocabulary patterns cluster on
  patterns.ts    Mistake clustering and rating cost
  profile.ts     Strengths and weaknesses — the scouting report
  lens.ts        What a report is narrowed to: a time class, and maybe an opening
  stats.ts       Dashboard aggregation, through a lens
  store.ts       Every query, against core's DB interface
  db.ts          The schema, the migration, and the interface both hosts satisfy
  coach.ts       The brief, the offline summariser, the per-lens cache
  chesscom.ts    Public API client
server/          What only a computer can do.
  db-node.ts     SQLite as a native binding, in a file on disk
  engine-node.ts Stockfish as a spawned process
  coach-claude.ts The model call — the only part needing a key and a network
  api.ts         HTTP routes over core
  export.ts      Freezes a player into a portable snapshot
  seed.ts        Offline demo-history generator
web/
  screens/       Dashboard, Library, Review, Patterns, Import, Settings
  components/    Board, baseline bars, time-class and opening bands, masthead
  snapshot.ts    Serves the read endpoints when there is no server
  styles.css     The design system
  public/fonts/  Self-hosted typefaces, so an export needs no network
```

## Tests

```bash
npm test
```

Covers the scoring model, PGN and clock parsing, time-class inference, motif detection,
the aggregation layer, the opening lens and snapshot inlining. The analysis tests run a real engine against fixture games —
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
