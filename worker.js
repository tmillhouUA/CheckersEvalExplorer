// Web Worker — loads one engine instance and plays test games.
// Stays alive across jobs; the coordinator reuses it for the entire run.
//
// Games are fully independent, so no SharedArrayBuffer is needed: each worker
// has its own WASM heap and plays whole games, returning a single result int.

importScripts('./engine.js');

let playGame = null;
let ef1MoveMs, ef2MoveMs, ef1MoveN, ef2MoveN;

EngineModule().then((mod) => {
  // play_game(mode1, mode2, depth1, depth2, q1, q2, seed, swapColors,
  //           noProgressCap, rollout, w1[12], w2[12]) -- 10 scalars + 24 doubles.
  playGame = mod.cwrap('play_game', 'number', new Array(34).fill('number'));
  // Per-EF move-time telemetry from the last game (minimax moves only).
  ef1MoveMs = mod.cwrap('dbg_ef1_move_ms', 'number', []);
  ef2MoveMs = mod.cwrap('dbg_ef2_move_ms', 'number', []);
  ef1MoveN  = mod.cwrap('dbg_ef1_move_n',  'number', []);
  ef2MoveN  = mod.cwrap('dbg_ef2_move_n',  'number', []);
  self.postMessage({ type: 'ready' });
});

self.onmessage = function (e) {
  const job = e.data;
  if (job.type !== 'play') return;

  // result: 0 = EF1 wins, 1 = EF2 wins, 2 = draw.  w1/w2 are 12-element weight
  // arrays in slider order (playerPieces, oppPieces, playerKings, oppKings,
  // playerVanguard, oppVanguard, playerAtRisk, oppAtRisk, playerMobility,
  // oppMobility, playerBackRow, oppBackRow).
  const result = playGame(
    job.ef1Mode, job.ef2Mode,
    job.ef1Depth, job.ef2Depth,
    job.ef1Quiesce, job.ef2Quiesce,
    job.seed, job.swapColors, job.noProgressCap, job.rollout,
    ...job.w1, ...job.w2
  );

  self.postMessage({
    type: 'game_done',
    token: job.token,   // run token, so stale results can be discarded
    result,
    // Per-EF move-time totals + counts for this game (minimax moves only),
    // aggregated by the coordinator into a running average move time per EF.
    ef1MoveMs: ef1MoveMs(), ef1MoveN: ef1MoveN(),
    ef2MoveMs: ef2MoveMs(), ef2MoveN: ef2MoveN(),
  });
};
