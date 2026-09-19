# Stockfish, in WebAssembly

Vendored from `stockfish@19.0.0` by `scripts/fetch-engine.mjs`, unmodified.

Stockfish is free software under the **GNU General Public License v3**, whose text is
in `LICENSE-stockfish.txt`. The corresponding source is at https://github.com/nmrugg/stockfish.js, which is in
turn a build of <https://github.com/official-stockfish/Stockfish>.

Only the lite single-threaded build is kept: the full net is 99 MB, and every
multi-threaded build needs SharedArrayBuffer and therefore COOP/COEP headers that a
statically hosted app cannot set.
