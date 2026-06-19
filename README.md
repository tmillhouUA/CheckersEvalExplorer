# Checkers Evaluation Function Explorer

A web tool for designing and testing heuristic evaluation functions for depth-limited minimax search, using checkers (American / English draughts) as the domain. You decide how a function should score a board position — by weighting features such as pieces, kings, mobility, and piece placement — and the tool pits two such functions against each other across many fast parallel games, or in a single game you can watch or play. I built it as a teaching aid for exploring how an evaluation function shapes a search agent's play.

## How It Works

Each evaluation function is a weighted sum of board features used for a depth-limited minimax search (with alpha-beta pruning and optional quiescence). The search looks a fixed number of moves ahead and uses the evaluation to score the leaf positions it reaches; the weights determine what the agent values, and a positive weight rewards a feature while a negative one penalizes it. Because the horizon is shallow, the quality of play depends heavily on the evaluation functions you design and test.

## Usage

A live version is available at [tmillhouua.github.io/CheckersEvalExplorer](https://tmillhouua.github.io/CheckersEvalExplorer/).

Define each function in the two panels on the left. The **Test** tab then plays many games between them in parallel and charts the win / draw / loss proportions as they accumulate — a fast way to tell whether a change actually helped. The **Play** tab runs a single game you can watch or join (assign each color to a function or to yourself), with a live readout of how each agent evaluates the current position; pause to edit a function and watch its score respond. Full descriptions of every control are in the **How To** tab inside the tool, and background on evaluation functions and minimax is in the **About** tab.

## Implementation

The engine is written in C++ and compiled to WebAssembly with Emscripten. Games run off the main thread in Web Workers, one WASM instance per worker: the Test tab dispatches whole games across a pool of workers for parallel throughput, while the Play tab uses a single dedicated worker that holds one persistent game and advances it move by move. The main thread coordinates dispatch, draws the chart and the interactive board, and manages run history. It uses plain Web Workers (no `SharedArrayBuffer`), so it needs no special COOP/COEP headers and runs from any static host.

| Component | Description |
|---|---|
| `src/cpp/engine.cpp` | C++ engine: move generation, minimax (alpha-beta) with quiescence, weighted-feature evaluation, and the interactive single-game API |
| `coordinator.js` | Main thread: worker pool, win/draw/loss chart, run logs, interactive board, and UI |
| `worker.js` | Web Worker: loads the engine and plays whole games for the Test tab |
| `play-worker.js` | Web Worker: holds one persistent game and steps it move by move for the Play tab |
| `build.sh` | Emscripten compile script: builds `engine.cpp` into `engine.js` and `engine.wasm` |

## Building

Requires [Emscripten](https://emscripten.org/). With `emsdk` activated:

```bash
bash build.sh
```

Output (`engine.js`, `engine.wasm`) is written to the project root. Serve the directory over HTTP — Web Workers cannot be created from a `file://` origin, so opening `index.html` directly will not work. Any static server will do (for example, `python -m http.server`); no special headers are required.

## Dependencies

No runtime JavaScript dependencies. The C++ engine uses only the standard library.
