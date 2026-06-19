// Play worker — a single, dedicated engine instance for interactive play.
//
// Unlike the Test pool (which plays whole games via play_game), this worker
// holds ONE persistent game (the engine's ig_* interactive state) and steps it
// one move at a time on request.  Move computation runs here, off the main
// thread, so even a deep search never freezes the board animation.
//
// Protocol (main thread -> worker):
//   { type: 'reset' }                       -> board reset to opening
//   { type: 'pick', mode, depth, q, w[12],  -> agent computes+applies one move
//            noProgress, noProgressCap }
//   { type: 'legal' }                       -> enumerate legal moves for the
//                                              side to move (human input)
//   { type: 'apply', index,                 -> apply the human's chosen move
//            noProgress, noProgressCap }
// Replies (worker -> main thread):
//   { type: 'ready' }
//   { type: 'reset_done', board[32], side }
//   { type: 'moved', status, mover, side, promoted, path[], captured[],
//            board[32] }              (reply to both 'pick' and 'apply')
//   { type: 'legal_result', side, status, moves:[{from,to,path[],captured[]}] }

importScripts('./engine.js');

let igReset, igPick, igCell, igSide, igStatus, igMover, igPromoted,
    igPathLen, igPathSq, igCapLen, igCapSq,
    igGen, igGenCount, igGenFrom, igGenTo, igGenPathLen, igGenPathSq,
    igGenCapLen, igGenCapSq, igApply, igEval;

function readBoard() {
  const cells = new Array(32);
  for (let i = 0; i < 32; i++) cells[i] = igCell(i);
  return cells;
}

EngineModule().then((mod) => {
  igReset    = mod.cwrap('ig_reset', null, []);
  // ig_pick(mode, depth, q, w[12], noProgress, noProgressCap) = 17 number args.
  igPick     = mod.cwrap('ig_pick', 'number', new Array(17).fill('number'));
  igCell     = mod.cwrap('ig_cell', 'number', ['number']);
  igSide     = mod.cwrap('ig_side', 'number', []);
  igStatus   = mod.cwrap('ig_status', 'number', []);
  igMover    = mod.cwrap('ig_mover', 'number', []);
  igPromoted = mod.cwrap('ig_promoted', 'number', []);
  igPathLen  = mod.cwrap('ig_path_len', 'number', []);
  igPathSq   = mod.cwrap('ig_path_sq', 'number', ['number']);
  igCapLen   = mod.cwrap('ig_cap_len', 'number', []);
  igCapSq    = mod.cwrap('ig_cap_sq', 'number', ['number']);
  // Legal-move enumeration + apply-by-index (human input).
  igGen        = mod.cwrap('ig_gen', 'number', []);
  igGenCount   = mod.cwrap('ig_gen_count', 'number', []);
  igGenFrom    = mod.cwrap('ig_gen_from', 'number', ['number']);
  igGenTo      = mod.cwrap('ig_gen_to', 'number', ['number']);
  igGenPathLen = mod.cwrap('ig_gen_path_len', 'number', ['number']);
  igGenPathSq  = mod.cwrap('ig_gen_path_sq', 'number', ['number', 'number']);
  igGenCapLen  = mod.cwrap('ig_gen_cap_len', 'number', ['number']);
  igGenCapSq   = mod.cwrap('ig_gen_cap_sq', 'number', ['number', 'number']);
  igApply      = mod.cwrap('ig_apply', 'number', ['number', 'number', 'number']);
  // ig_eval(side, w[12]) = 13 number args -> static eval of the current position.
  igEval       = mod.cwrap('ig_eval', 'number', new Array(13).fill('number'));
  self.postMessage({ type: 'ready' });
});

// Read the played-move accessors + board into a 'moved' message (shared by the
// 'pick' and 'apply' handlers so both animate identically on the main thread).
function movedMessage(status) {
  const path = [];
  for (let i = 0; i < igPathLen(); i++) path.push(igPathSq(i));
  const captured = [];
  for (let i = 0; i < igCapLen(); i++) captured.push(igCapSq(i));
  return {
    type: 'moved',
    status,
    mover: igMover(),
    side: igSide(),
    promoted: igPromoted(),
    path,
    captured,
    board: readBoard(),
  };
}

self.onmessage = function (e) {
  const job = e.data;

  if (job.type === 'reset') {
    igReset();
    self.postMessage({ type: 'reset_done', board: readBoard(), side: igSide() });
    return;
  }

  if (job.type === 'pick') {
    // Agent move.  Status: 0 ongoing, 1 RED wins, 2 BLACK wins, 3 draw, 4 over.
    const status = igPick(
      job.mode, job.depth, job.q,
      ...job.w,
      job.noProgress, job.noProgressCap
    );
    self.postMessage(movedMessage(status));
    return;
  }

  if (job.type === 'legal') {
    // Enumerate the legal moves for the side to move (human input).  If there
    // are none, the side to move has lost; ig_gen sets the terminal status.
    const n = igGen();
    const moves = [];
    for (let i = 0; i < n; i++) {
      const path = [];
      for (let j = 0; j < igGenPathLen(i); j++) path.push(igGenPathSq(i, j));
      const captured = [];
      for (let k = 0; k < igGenCapLen(i); k++) captured.push(igGenCapSq(i, k));
      moves.push({ from: igGenFrom(i), to: igGenTo(i), path, captured });
    }
    self.postMessage({
      type: 'legal_result',
      side: igSide(),
      status: igStatus(),   // nonzero if the side to move has no moves (lost)
      moves,
    });
    return;
  }

  if (job.type === 'apply') {
    // Apply the human's chosen move (index into the last 'legal' enumeration).
    const status = igApply(job.index, job.noProgress, job.noProgressCap);
    self.postMessage(movedMessage(status));
    return;
  }

  if (job.type === 'eval') {
    // Static eval of the CURRENT position for each EF seat (its own side +
    // weights).  A null request (a non-EF/User seat) yields a null value.
    const ev = (req) => (req ? igEval(req.side, ...req.w) : null);
    self.postMessage({ type: 'eval_result', reason: job.reason, red: ev(job.red), black: ev(job.black) });
    return;
  }
};
