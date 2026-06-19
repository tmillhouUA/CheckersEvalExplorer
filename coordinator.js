// coordinator.js — main thread entry point
//
// Multi-threaded: a pool of Web Workers each hold their own engine instance and
// play whole games in parallel.  The games are independent, so no shared memory
// is needed -- jobs carry a few ints, results come back as a single int.  The
// main thread tallies outcomes, smooths the cumulative shares, and draws the
// stacked-proportion plot.
//
// Determinism is preserved regardless of worker count: each game's seed and
// color assignment come from its global game index, and results are applied in
// index order (buffered if they arrive out of order), so the graph is identical
// to the single-threaded version.

// ------------------------------------------------------------
// Layout: keep the center panel square (driven by viewer height).
// ------------------------------------------------------------
function updatePanelSize() {
  const viewer = document.getElementById('viewer');
  const h = viewer.getBoundingClientRect().height;
  document.documentElement.style.setProperty('--panel-h', h + 'px');
}

// ------------------------------------------------------------
// Worker pool + game-loop state
// ------------------------------------------------------------
const HW_CORES = navigator.hardwareConcurrency || 4;
const DEFAULT_WORKERS = Math.max(1, Math.floor(HW_CORES * 0.75));
let workers = [];           // Worker instances (length = current core count)
let workerBusy = [];        // parallel array: is workers[i] mid-game?
let workersReady = 0;       // count of workers that have loaded the engine

let running = false;        // is the test loop actively dispatching?
let paused = false;         // halted via Pause (resumable) vs. Stop (fresh next time)
let gamesPlayed = 0;        // games whose results have been applied
let nextGameIndex = 0;      // count of games dispatched so far
let targetGames = 1000;     // N: how many games this run should play
let ef1Wins = 0;
let ef2Wins = 0;
let draws = 0;

// Per-EF move-time aggregation (minimax moves only): total ms and move count
// across all applied games, for a running average move time per EF.
let ef1MoveMsTotal = 0, ef1MoveCount = 0;
let ef2MoveMsTotal = 0, ef2MoveCount = 0;

// Run token: incremented on every fresh run (resetRun).  Dispatched jobs carry
// the token; results from a stale run (paused, or a previous matchup whose
// in-flight games land late) are discarded so they can't corrupt the tally.
let runToken = 0;

// Throughput: moving average over the last RATE_SAMPLES completed games.  A
// cumulative-since-Start average (used previously) permanently baked in the
// slow startup ramp, so the readout climbed for the whole run instead of
// reflecting current speed.  A fixed-TIME window instead swings wildly under
// bursty high-depth completion (a window can hold zero games).  Counting by a
// fixed number of recent GAMES avoids both: it always has samples and
// self-adjusts its time span to the current pace.
const RATE_SAMPLES = 200;   // games in the moving-average window
let completionTimes = [];   // performance.now() of recent game completions (ring)

// Running outcome-share histories, one point per game.  The UNDERLYING signal
// is the cumulative all-time share (ef1Wins/games, etc.), so a rare win is
// recorded permanently and only dilutes slowly as more games accrue -- it
// never decays away.  These histories store an EMA-smoothed view of those
// cumulative shares purely to take the visual jitter off the curve.
// ef1Rate + drawRate + ef2Rate == 1 at every game (smoothing three cumulative
// values that sum to 1 still sums to 1), keeping the stacked bands full-height.
let ef1RateHistory = [];
let ef2RateHistory = [];

// EMA state: the smoothed cumulative shares.  null until the first game.
let emaEf1 = null, emaDraw = null, emaEf2 = null;
const EMA_ALPHA = 0.2;  // weight on the newest cumulative value: 0.8*old + 0.2*new

// Run history ("Logs" tab).  One entry per started run; created the moment a
// fresh run begins (never on refresh/idle), updated live, finalized on
// completion or Stop.  Persisted to localStorage so a student's runs survive a
// refresh and can be compared over time.  See the Logs section below.
const LOGS_KEY = 'checkersEvalExplorer.logs.v1';
const LOGS_CAP = 50;                 // keep only the most recent N runs
const LOGS_SAVE_THROTTLE_MS = 1500;  // trailing disk-write interval during a run
let logs = [];                 // loaded in init(); newest entries at the end
let currentRunLogId = null;    // id of the in-progress entry, or null when idle
let logsSaveTimer = 0;         // setTimeout handle for the throttled save
let logsDirty = false;         // a throttled write is pending

// Plot colors, drawn from the reference project's pastel-on-dark palette.
const EF1_COLOR = '#7af';   // blue  (matches reference L2)
const EF2_COLOR = '#f77';   // red   (red analog in the same #Xyy idiom)
const DRAW_COLOR = '#888';  // neutral gray for draws

// Both evaluation functions are piece-ratio minimax for this increment;
// they differ only in search depth (set per panel).
const EF1_MODE = 1;   // minimax
const EF2_MODE = 1;   // minimax
const NO_PROGRESS_CAP = 50;  // plies without capture/promotion -> draw (tuned empirically)

// ------------------------------------------------------------
// Eval-panel row spec — single source of truth for the per-function controls.
// Each row becomes a slider (with live value + per-row reset) in both panels.
// `key` is the suffix used in element ids (ef1_<key> / ef2_<key>).  `dec` =
// decimal places for the value label.  Order here is the display order.
// The eight weight rows (Player Pieces .. Opponent At Risk) must stay in the
// engine's weight-argument order; Depth and Quiescence are handled separately.
// ------------------------------------------------------------
const EVAL_ROWS = [
  { key: 'depth',   label: 'Depth',           min: 2,  max: 10, step: 1,   def: 4,  dec: 0 },
  { key: 'quiesce', label: 'Quiescence',      min: 0,  max: 5,  step: 1,   def: 0,  dec: 0 },
  { key: 'pp',      label: 'Player Pieces',   min: -3, max: 3,  step: 0.1, def: 1,  dec: 1 },
  { key: 'op',      label: 'Enemy Pieces',    min: -3, max: 3,  step: 0.1, def: -1, dec: 1 },
  { key: 'pk',      label: 'Player Kings',    min: -3, max: 3,  step: 0.1, def: 0,  dec: 1 },
  { key: 'ok',      label: 'Enemy Kings',     min: -3, max: 3,  step: 0.1, def: 0,  dec: 1 },
  { key: 'pv',      label: 'Player Vanguard', min: -3, max: 3,  step: 0.1, def: 0,  dec: 1 },
  { key: 'ov',      label: 'Enemy Vanguard',  min: -3, max: 3,  step: 0.1, def: 0,  dec: 1 },
  { key: 'pr',      label: 'Player At Risk',  min: -3, max: 3,  step: 0.1, def: 0,  dec: 1 },
  { key: 'or',      label: 'Enemy At Risk',   min: -3, max: 3,  step: 0.1, def: 0,  dec: 1 },
  { key: 'pm',      label: 'Player Mobility', min: -3, max: 3,  step: 0.1, def: 0,  dec: 1 },
  { key: 'om',      label: 'Enemy Mobility',  min: -3, max: 3,  step: 0.1, def: 0,  dec: 1 },
  { key: 'pb',      label: 'Player Back Row', min: -3, max: 3,  step: 0.1, def: 0,  dec: 1 },
  { key: 'ob',      label: 'Enemy Back Row',  min: -3, max: 3,  step: 0.1, def: 0,  dec: 1 },
];
// The twelve weight keys, in engine argument order (excludes depth/quiesce).
const WEIGHT_KEYS = ['pp', 'op', 'pk', 'ok', 'pv', 'ov', 'pr', 'or', 'pm', 'om', 'pb', 'ob'];

// Settings snapshotted when a fresh run starts.  Setup controls are disabled
// during a run, so these stay consistent for the whole run.  ef1Weights /
// ef2Weights are 8-element arrays in engine order (see WEIGHT_KEYS).
let runSettings = {
  ef1Depth: 4, ef2Depth: 4, ef1Quiesce: 0, ef2Quiesce: 0, rollout: true,
  ef1Weights: [1, -1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  ef2Weights: [1, -1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
};

let plotCanvas, plotCtx;
let boardCanvas, boardCtx;

// ------------------------------------------------------------
// Init
// ------------------------------------------------------------
window.addEventListener('DOMContentLoaded', init);

function init() {
  updatePanelSize();
  new ResizeObserver(() => {
    updatePanelSize();
    resizePlot(); drawPlot();
    resizeBoard(); refreshBoard();
  }).observe(document.getElementById('viewer'));

  plotCanvas = document.getElementById('plot');
  plotCtx = plotCanvas.getContext('2d');
  boardCanvas = document.getElementById('boardCanvas');
  boardCtx = boardCanvas.getContext('2d');
  boardCanvas.addEventListener('click', onBoardClick);

  // Output-panel tabs: Test (plot) <-> Play (board).
  document.getElementById('tabTest').addEventListener('click', () => switchOutputTab('test'));
  document.getElementById('tabPlay').addEventListener('click', () => switchOutputTab('play'));
  // Seat dropdowns (Red/Black -> EF1/EF2/User) + pacing sliders + play controls.
  document.getElementById('redSeat').addEventListener('change', readSeats);
  document.getElementById('blackSeat').addEventListener('change', readSeats);
  document.getElementById('moveSpeedSlider').addEventListener('input', updatePaceLabels);
  document.getElementById('turnGapSlider').addEventListener('input', updatePaceLabels);
  document.getElementById('playStartBtn').addEventListener('click', onPlayStart);
  document.getElementById('playStepBtn').addEventListener('click', onPlayStep);
  document.getElementById('playResetBtn').addEventListener('click', onPlayReset);
  updatePaceLabels();    // initialize the "0.5s" readouts
  // Live EF readout recompute when weights are edited at the opening or while
  // paused (eval panels are locked while running, so this is a no-op then).
  document.getElementById('ef1Body').addEventListener('input', onEvalEdited);
  document.getElementById('ef2Body').addEventListener('input', onEvalEdited);
  readSeats();           // sync seat state from the DOM defaults (also updates controls)
  ensurePlayWorker();    // dedicated worker for interactive play; loads its engine

  document.getElementById('startPauseBtn')
    .addEventListener('click', onStartPause);

  // Build both eval panels from the row spec (sliders + per-row reset).
  buildEvalPanel('ef1');
  buildEvalPanel('ef2');

  // Eval-panel title-bar tools.
  document.getElementById('ef1ResetAll').addEventListener('click', () => resetPanel('ef1'));
  document.getElementById('ef2ResetAll').addEventListener('click', () => resetPanel('ef2'));
  document.getElementById('ef1Copy').addEventListener('click', () => copyPanel('ef1', 'ef2'));
  document.getElementById('ef2Copy').addEventListener('click', () => copyPanel('ef2', 'ef1'));
  document.getElementById('ef1Save').addEventListener('click', () => savePanel('ef1'));
  document.getElementById('ef2Save').addEventListener('click', () => savePanel('ef2'));
  document.getElementById('ef1Load').addEventListener('click', () => loadPanelFromFile('ef1'));
  document.getElementById('ef2Load').addEventListener('click', () => loadPanelFromFile('ef2'));
  document.getElementById('evalFileInput').addEventListener('change', onEvalFileChosen);

  // Setup controls.
  document.getElementById('stopBtn').addEventListener('click', onStop);
  const coresSlider = document.getElementById('coresSlider');
  coresSlider.max = String(HW_CORES);
  coresSlider.value = String(DEFAULT_WORKERS);
  document.getElementById('coresVal').textContent = DEFAULT_WORKERS;
  coresSlider.addEventListener('input', () => {
    document.getElementById('coresVal').textContent = coresSlider.value;
    persistSettings();
  });
  document.getElementById('nGamesInput').addEventListener('input', persistSettings);
  document.getElementById('rolloutChk').addEventListener('change', persistSettings);

  // Restore any persisted settings (panels + setup) from a previous session.
  loadPersisted();

  // Logs: load history (normalizing stale 'running' entries), wire the
  // info-panel tabs, and delegate all log-list clicks through one handler that
  // survives re-renders.
  logs = loadLogs();
  document.getElementById('tabAbout').addEventListener('click', () => switchInfoTab('about'));
  document.getElementById('tabHowTo').addEventListener('click', () => switchInfoTab('howto'));
  document.getElementById('tabLogs').addEventListener('click', () => switchInfoTab('logs'));
  document.getElementById('logsInner').addEventListener('click', onLogsClick);

  resizePlot();
  drawPlot();
  updateCounters();

  // Spawn the initial worker pool; each worker loads its own engine instance.
  document.getElementById('progress').textContent =
    `Loading engine (${DEFAULT_WORKERS} workers)…`;
  spawnWorkers(DEFAULT_WORKERS, () => {
    document.getElementById('startPauseBtn').disabled = false;
    updateCounters();  // show the zeroed progress line once ready
  });
}

// ------------------------------------------------------------
// Worker pool
// ------------------------------------------------------------

// Spawn exactly `n` workers, replacing any existing pool.  `onReady` fires once
// all n have loaded the engine.  Used at init and whenever the core-count
// slider changes the pool size on Start.
let onPoolReady = null;

function spawnWorkers(n, onReady) {
  // Tear down any existing workers first.
  for (const w of workers) w.terminate();
  workers = [];
  workerBusy = [];
  workersReady = 0;
  onPoolReady = onReady || null;

  // Web Workers cannot be constructed from a file:// origin (treated as a
  // unique/null origin).  Catch this early and tell the user to use a server,
  // rather than throwing mid-loop and leaving the page in a half-dead state.
  try {
    for (let i = 0; i < n; i++) {
      const w = new Worker('./worker.js');
      w.onmessage = (e) => handleWorkerMessage(i, e.data);
      w.onerror = (e) => console.error('[worker] error', e.message || e);
      workers.push(w);
      workerBusy.push(false);
    }
  } catch (err) {
    const onFileProtocol = location.protocol === 'file:';
    const msg = onFileProtocol
      ? 'This page must be served over http:// — open it through a local server, not from the filesystem.'
      : 'Failed to start workers: ' + (err && err.message ? err.message : err);
    document.getElementById('progress').textContent = msg;
    document.getElementById('startPauseBtn').disabled = true;
    console.error('[workers] spawn failed', err);
  }
}

function handleWorkerMessage(workerIdx, msg) {
  if (msg.type === 'ready') {
    workersReady++;
    if (workersReady === workers.length && onPoolReady) {
      const cb = onPoolReady;
      onPoolReady = null;
      cb();
    }
    return;
  }
  if (msg.type === 'game_done') {
    workerBusy[workerIdx] = false;
    // Only count results from the current run; discard stragglers from a run
    // that was paused or stopped while this game was in flight.
    if (msg.token === runToken) {
      ef1MoveMsTotal += msg.ef1MoveMs; ef1MoveCount += msg.ef1MoveN;
      ef2MoveMsTotal += msg.ef2MoveMs; ef2MoveCount += msg.ef2MoveN;
      onGameResult(msg.result);
    }
    if (!running) return;
    if (gamesPlayed >= targetGames) {
      finishRun();                       // target reached -> end the run
    } else if (nextGameIndex < targetGames) {
      dispatchTo(workerIdx);             // more to dispatch -> keep this worker fed
    }
    // else: all games dispatched but some still in flight elsewhere -> wait.
  }
}

// ------------------------------------------------------------
// Eval panel construction + controls (spec-driven, see EVAL_ROWS)
// ------------------------------------------------------------

// Build the slider rows for one panel (prefix 'ef1' or 'ef2') into its body.
// Each row: label, range slider (id `${prefix}_${key}`), an editable number box
// for exact entry (two-way bound with the slider; spinners hidden via CSS), and
// a per-row reset button (↺) that restores the row's default.
function buildEvalPanel(prefix) {
  const body = document.getElementById(`${prefix}Body`);
  for (const row of EVAL_ROWS) {
    const id = `${prefix}_${row.key}`;
    const div = document.createElement('div');
    div.className = 'cpRow';
    div.innerHTML =
      `<label>${row.label}</label>` +
      `<input type="range" id="${id}" min="${row.min}" max="${row.max}" ` +
        `step="${row.step}" value="${row.def}">` +
      `<input type="number" class="cpNum" id="${id}_num" ` +
        `min="${row.min}" max="${row.max}" step="${row.step}">` +
      `<button class="rowResetBtn" title="Reset to ${row.def.toFixed(row.dec)}">↺</button>`;
    body.appendChild(div);

    const slider = div.querySelector('input[type=range]');
    const box = div.querySelector('input[type=number]');

    // Focus the slider on click so the focus outline shows for mouse use too,
    // not only keyboard (some browsers don't focus a range input on click).
    slider.addEventListener('mousedown', () => slider.focus());

    // slider -> box
    slider.addEventListener('input', () => {
      box.value = parseFloat(slider.value).toFixed(row.dec);
      markRow(div, row, slider.value);
      persistSettings();
    });
    // box -> slider (clamp to range; ignore transient empty/partial input)
    box.addEventListener('input', () => {
      const v = parseFloat(box.value);
      if (Number.isNaN(v)) return;
      slider.value = Math.max(row.min, Math.min(row.max, v));
      markRow(div, row, slider.value);
      persistSettings();
    });
    // On blur, normalize the box text to the slider's clamped/stepped value.
    box.addEventListener('change', () => {
      box.value = parseFloat(slider.value).toFixed(row.dec);
    });

    div.querySelector('button').addEventListener('click', () => {
      setRow(id, row, row.def);
      persistSettings();
    });

    setRow(id, row, row.def);  // initialize both controls
  }
}

// Show the per-row reset (↺) only when the row differs from its default; the
// button thus doubles as the "this slider is off-default" indicator.
function markRow(div, row, value) {
  const off = Math.abs(parseFloat(value) - row.def) > 1e-9;
  div.classList.toggle('offDefault', off);
}

// Set a row's slider + box to value v (clamped/normalized to the row's spec),
// and refresh its off-default marker.
function setRow(id, row, v) {
  const slider = document.getElementById(id);
  const box = document.getElementById(`${id}_num`);
  const clamped = Math.max(row.min, Math.min(row.max, v));
  slider.value = clamped;
  box.value = parseFloat(slider.value).toFixed(row.dec);  // slider re-snaps to step
  markRow(slider.closest('.cpRow'), row, slider.value);
}

// Reset every row in one panel to its default.
function resetPanel(prefix) {
  for (const row of EVAL_ROWS) setRow(`${prefix}_${row.key}`, row, row.def);
  persistSettings();
}

// Read the eight weights for one eval panel as an array in engine order.
function readWeights(prefix) {
  return WEIGHT_KEYS.map(k =>
    parseFloat(document.getElementById(`${prefix}_${k}`).value));
}

// Read a single integer control (depth/quiesce) for a panel.
function readInt(prefix, key) {
  return parseInt(document.getElementById(`${prefix}_${key}`).value, 10);
}

// ------------------------------------------------------------
// Panel state: copy, save/load JSON, localStorage persistence
// ------------------------------------------------------------

// Snapshot one panel's full state (all EVAL_ROWS) as {key: number}.
function panelState(prefix) {
  const s = {};
  for (const row of EVAL_ROWS) {
    s[row.key] = parseFloat(document.getElementById(`${prefix}_${row.key}`).value);
  }
  return s;
}

// Apply a {key: number} state object to a panel (missing keys keep default).
function applyPanelState(prefix, state) {
  for (const row of EVAL_ROWS) {
    const v = (state && state[row.key] != null) ? state[row.key] : row.def;
    setRow(`${prefix}_${row.key}`, row, v);
  }
}

// True when the eval functions must not change: a Test run (running/paused) OR
// an active (not-paused) Play game.  Anything that edits an EF -- copy, load,
// log "-> EF" apply -- checks this, in addition to the eval panels being
// disabled.  (playStarted/playPaused are defined in the Play section below;
// this is only ever called at runtime, after they exist.)
function efsLocked() {
  return running || paused || (playStarted && !playPaused);
}

// Copy one panel's settings into the other.
function copyPanel(from, to) {
  if (efsLocked()) return;  // settings locked during a run / active play
  applyPanelState(to, panelState(from));
  persistSettings();
  onEvalEdited();  // refresh the EF readout (bulk change fires no slider input)
}

// Save one panel's settings to a downloaded JSON file.
function savePanel(prefix) {
  const data = { kind: 'checkers-eval-func', version: 1, settings: panelState(prefix) };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${prefix === 'ef1' ? 'eval-func-1' : 'eval-func-2'}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// Load settings from a chosen JSON file into the given panel.
let loadTargetPrefix = null;
function loadPanelFromFile(prefix) {
  if (efsLocked()) return;
  loadTargetPrefix = prefix;
  document.getElementById('evalFileInput').click();
}
function onEvalFileChosen(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';  // allow re-loading the same file later
  if (!file || !loadTargetPrefix) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      const state = data && data.settings ? data.settings : data;  // tolerate bare objects
      applyPanelState(loadTargetPrefix, state);
      persistSettings();
      onEvalEdited();  // refresh the EF readout (bulk change fires no slider input)
    } catch (err) {
      console.error('[load] invalid JSON', err);
      alert('Could not load: the file is not valid evaluation-function JSON.');
    }
  };
  reader.readAsText(file);
}

// ---- localStorage persistence (both panels + setup controls) ----
const STORAGE_KEY = 'checkersEvalExplorer.v1';

function persistSettings() {
  try {
    const state = {
      ef1: panelState('ef1'),
      ef2: panelState('ef2'),
      setup: {
        nGames: document.getElementById('nGamesInput').value,
        rollout: document.getElementById('rolloutChk').checked,
        cores: document.getElementById('coresSlider').value,
      },
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    // localStorage may be unavailable (private mode, etc.) -- non-fatal.
  }
}

function loadPersisted() {
  let state;
  try {
    state = JSON.parse(localStorage.getItem(STORAGE_KEY));
  } catch (err) { return; }
  if (!state) return;
  if (state.ef1) applyPanelState('ef1', state.ef1);
  if (state.ef2) applyPanelState('ef2', state.ef2);
  if (state.setup) {
    const su = state.setup;
    if (su.nGames != null) document.getElementById('nGamesInput').value = su.nGames;
    if (su.rollout != null) document.getElementById('rolloutChk').checked = su.rollout;
    if (su.cores != null) {
      const cs = document.getElementById('coresSlider');
      cs.value = su.cores;
      document.getElementById('coresVal').textContent = cs.value;
    }
  }
}

// ------------------------------------------------------------
// Logs — run history
// ------------------------------------------------------------
//
// A log entry is created the instant a FRESH run starts (in startFreshRun's
// begin()), updated live as games complete, and finalized on natural completion
// ('done') or Stop ('stopped').  Refreshing, idling, or adjusting sliders never
// creates an entry.  The headline number is games ACTUALLY played, so a run
// stopped early at 1000 is directly comparable to a real N=1000 run.  Entries
// persist in localStorage (capped) so students can compare runs over a session.

// ---- persistence ----

// Read + parse the log array, normalizing any entry left 'running' (the app was
// closed mid-run) to 'stopped'.  Returns [] on any failure (localStorage off,
// bad JSON), so the feature still works fully in memory.
function loadLogs() {
  let arr;
  try {
    arr = JSON.parse(localStorage.getItem(LOGS_KEY));
  } catch (err) { return []; }
  if (!Array.isArray(arr)) return [];
  for (const e of arr) if (e && e.status === 'running') e.status = 'stopped';
  return arr;
}

// Persist the log array (cap-trimmed to the most recent LOGS_CAP).  Non-fatal.
function saveLogs() {
  try {
    if (logs.length > LOGS_CAP) logs.splice(0, logs.length - LOGS_CAP);
    localStorage.setItem(LOGS_KEY, JSON.stringify(logs));
  } catch (err) {
    // localStorage may be unavailable (private mode, quota) -- non-fatal.
  }
}

// ---- throttled writes ----
// The in-memory entry is updated every game (so a refresh recovers exact
// numbers); the disk write trails at LOGS_SAVE_THROTTLE_MS to spare localStorage.

function scheduleLogsSave() {
  logsDirty = true;
  if (logsSaveTimer) return;  // a trailing write is already pending
  logsSaveTimer = setTimeout(() => {
    logsSaveTimer = 0;
    if (logsDirty) { logsDirty = false; saveLogs(); }
  }, LOGS_SAVE_THROTTLE_MS);
}

function flushLogsSave() {  // immediate authoritative write (finalize / pause)
  if (logsSaveTimer) { clearTimeout(logsSaveTimer); logsSaveTimer = 0; }
  logsDirty = false;
  saveLogs();
}

// ---- entry lifecycle ----

function logFindCurrent() {
  return currentRunLogId ? logs.find(e => e.id === currentRunLogId) : null;
}

// Copy the live run tallies into an entry (in memory; no disk write here).
function logWriteTallies(entry) {
  entry.gamesPlayed = gamesPlayed;
  entry.results.ef1Wins = ef1Wins;
  entry.results.draws = draws;
  entry.results.ef2Wins = ef2Wins;
  entry.results.ef1AvgMoveMs = ef1MoveCount > 0 ? ef1MoveMsTotal / ef1MoveCount : 0;
  entry.results.ef2AvgMoveMs = ef2MoveCount > 0 ? ef2MoveMsTotal / ef2MoveCount : 0;
}

// Create the entry for a freshly-started run.  Settings are snapshot from the
// (now-locked) panels; tallies start at zero and fill in via logUpdateCurrent.
function logCreateEntry() {
  const entry = {
    id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()),
    startedAt: new Date().toISOString(),
    status: 'running',
    targetGames,
    gamesPlayed: 0,
    cores: parseInt(document.getElementById('coresSlider').value, 10),
    rollout: runSettings.rollout,
    ef1: panelState('ef1'),
    ef2: panelState('ef2'),
    results: { ef1Wins: 0, draws: 0, ef2Wins: 0, ef1AvgMoveMs: 0, ef2AvgMoveMs: 0 },
  };
  logs.push(entry);
  if (logs.length > LOGS_CAP) logs.splice(0, logs.length - LOGS_CAP);
  currentRunLogId = entry.id;
  saveLogs();
  renderLogs();
  scrollLogsToBottom();  // bring the new run into view (console-style)
}

// Refresh the in-progress entry's tallies (called per game).  No-op when idle.
function logUpdateCurrent() {
  const entry = logFindCurrent();
  if (!entry) return;
  logWriteTallies(entry);
  scheduleLogsSave();
}

// Close out the current run: write final tallies + status, persist immediately,
// re-render, and clear the current id.  Self-guarded so an idle Stop is a no-op.
function logFinalize(status) {
  const entry = logFindCurrent();
  if (!entry) return;
  logWriteTallies(entry);
  entry.status = status;  // 'done' | 'stopped'
  currentRunLogId = null;
  flushLogsSave();
  renderLogs();
}

// ---- matchup descriptor ----
//
// Build a per-EF descriptor for the compact row, formatted as:
//   [DX, QY] Feature 1; Feature 2
// A bracketed (depth, quiescence) tuple always leads, followed by up to two
// abbreviated weight features.  Features are the weights that differ MOST
// between the two EFs, tagged per EF against that EF's OWN default value:
// up-arrow = above default, down-arrow = below default, dash = at default.
// (Tagging vs. default, not vs. the other EF, makes the two lines independently
// meaningful -- a feature can be off-default on one EF and default on the
// other.)  If the two EFs are fully identical, the features read "Self-Play".
function buildDescriptor(ef1, ef2) {
  const EPS = 1e-9;
  const labelOf = (key) => abbrevLabel(EVAL_ROWS.find(r => r.key === key).label);
  const defOf = (key) => EVAL_ROWS.find(r => r.key === key).def;
  // value vs. that key's default: up / down / dash (at default).
  const tagOf = (key, v) => {
    const d = v - defOf(key);
    return d > EPS ? '↑' : (d < -EPS ? '↓' : '–');
  };
  const prefix = (ef) => `[D${fmtInt(ef.depth)}, Q${fmtInt(ef.quiesce)}]`;

  // Weights that differ between the two EFs, largest gap first (ties by
  // EVAL_ROWS order).  Depth/quiescence now live in the prefix, so both feature
  // slots are available for weights.
  const weightDiffs = [];
  WEIGHT_KEYS.forEach((key, orderIdx) => {
    const d = ef1[key] - ef2[key];
    if (Math.abs(d) > EPS) weightDiffs.push({ key, mag: Math.abs(d), orderIdx });
  });
  weightDiffs.sort((a, b) => (b.mag - a.mag) || (a.orderIdx - b.orderIdx));

  // Fully identical: bracket tuple + a "Self-Play" tag.
  const identical = weightDiffs.length === 0 &&
    Math.abs(ef1.depth - ef2.depth) <= EPS &&
    Math.abs(ef1.quiesce - ef2.quiesce) <= EPS;
  if (identical) {
    return { ef1Label: `${prefix(ef1)} Self-Play`,
             ef2Label: `${prefix(ef2)} Self-Play` };
  }

  const feats = weightDiffs.slice(0, 2).map(w => ({
    e1: labelOf(w.key) + tagOf(w.key, ef1[w.key]),
    e2: labelOf(w.key) + tagOf(w.key, ef2[w.key]),
  }));
  const join = (pfx, parts) => parts.length ? `${pfx} ${parts.join('; ')}` : pfx;
  return {
    ef1Label: join(prefix(ef1), feats.map(f => f.e1)),
    ef2Label: join(prefix(ef2), feats.map(f => f.e2)),
  };
}

// ---- apply logged settings into a live panel ----
// Mirrors copyPanel: locked during a run / active play, persists afterward.
function applyLoggedSettings(state, targetPrefix) {
  if (efsLocked()) return;
  applyPanelState(targetPrefix, state);
  persistSettings();
  onEvalEdited();  // refresh the EF readout (bulk change fires no slider input)
}

// ------------------------------------------------------------
// Logs — tab switching + rendering
// ------------------------------------------------------------

// Switch the right-hand info panel between About / How To / Logs.
function switchInfoTab(name) {
  const tabs = { about: 'tabAbout', howto: 'tabHowTo', logs: 'tabLogs' };
  const panes = { about: 'aboutInner', howto: 'howToInner', logs: 'logsInner' };
  for (const key of Object.keys(tabs)) {
    document.getElementById(tabs[key]).classList.toggle('active', key === name);
    document.getElementById(panes[key]).style.display = (key === name) ? '' : 'none';
  }
  if (name === 'logs') { renderLogs(); scrollLogsToBottom(); }
}

// Scroll the log list to the newest entry (bottom), console-style.
function scrollLogsToBottom() {
  const host = document.getElementById('logsInner');
  if (host) host.scrollTop = host.scrollHeight;
}

const esc = (s) => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtInt = (n) => String(Math.round(n));
const fmtVal = (n, dec) => Number(n).toFixed(dec);
const fmtMs = (n) => n > 0 ? `${n.toFixed(1)} ms` : '—';
// Compact a settings-list label: "Player Pieces" -> "P. Pieces", etc.
const abbrevLabel = (s) => s.replace(/^Player /, 'P. ').replace(/^Enemy /, 'E. ');
function fmtTime(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleString([], { month: 'short', day: 'numeric',
                                hour: '2-digit', minute: '2-digit' });
}

// Rebuild the whole log list, console-style: oldest at the top, newest at the
// bottom (logs is stored in chronological order).  Cheap: a few dozen rows of
// string-built HTML.  Detail bodies are filled lazily on first expand.
function renderLogs() {
  const host = document.getElementById('logsInner');
  if (!host) return;
  const header =
    '<div id="logHeader"><span>Run History</span>' +
    '<button id="clearLogBtn" data-act="clear">Clear</button></div>';
  const body = logs.length === 0
    ? '<p class="logEmpty">No runs logged yet. Start a run to record it here.</p>'
    : logs.map(logRowHtml).join('');
  host.innerHTML = header + body;
}

// One compact three-line row: EF1 descriptor / EF2 descriptor / outcome pcts.
// (Status and game count live in the dropdown; a 'live' tag marks only the
// in-progress run so it stands out while updating.)
function logRowHtml(entry) {
  const { ef1Label, ef2Label } = buildDescriptor(entry.ef1, entry.ef2);
  const isCurrent = entry.id === currentRunLogId || entry.status === 'running';
  const liveTag = isCurrent ? '<span class="logLive">live</span>' : '';
  return `<div class="logRow" data-id="${entry.id}">
    <div class="logRowHead">
      <button class="logChevron" data-act="toggle" aria-label="Expand">&#9656;</button>
      <div class="logMatchup">
        <div class="logDescLine logEf1">${esc(ef1Label)}${liveTag}</div>
        <div class="logDescLine logEf2">${esc(ef2Label)}</div>
        <div class="logPcts">${outcomePctsHtml(entry)}</div>
      </div>
      <button class="logDel" data-act="delete" ${isCurrent ? 'disabled' : ''} aria-label="Delete">&times;</button>
    </div>
    <div class="logDetail" data-detail style="display:none;"></div>
  </div>`;
}

// The three outcome percentages (EF1 win / draw / EF2 win), color-coded.
// Rounding slop is absorbed into the EF2 figure so the three sum to 100; all
// read 0% before any games complete.
function outcomePctsHtml(entry) {
  const g = entry.gamesPlayed || 0;
  const r = entry.results;
  const p1 = g ? Math.round(r.ef1Wins / g * 100) : 0;
  const pd = g ? Math.round(r.draws / g * 100) : 0;
  const p2 = g ? 100 - p1 - pd : 0;
  return `<span class="logPct logPctEf1">${p1}%</span>` +
    `<span class="logPct logPctDraw">${pd}%</span>` +
    `<span class="logPct logPctEf2">${p2}%</span>`;
}

// Expanded detail: run meta + two settings columns (with apply buttons).
function logDetailHtml(entry) {
  return `<div class="logMeta">${entry.gamesPlayed} / ${entry.targetGames} games &middot; ` +
    `${entry.cores} cores &middot; rollout ${entry.rollout ? 'on' : 'off'} &middot; ` +
    `started ${esc(fmtTime(entry.startedAt))}</div>
    <div class="logCols">
      ${settingsColumnHtml(entry, 'ef1')}
      ${settingsColumnHtml(entry, 'ef2')}
    </div>`;
}

// One settings column (EF1 or EF2): all EVAL_ROWS values, diff-highlighted vs
// the other column, plus two apply buttons ("-> EF1" / "-> EF2").
function settingsColumnHtml(entry, which) {
  const self = entry[which];
  const other = entry[which === 'ef1' ? 'ef2' : 'ef1'];
  const avg = which === 'ef1' ? entry.results.ef1AvgMoveMs : entry.results.ef2AvgMoveMs;
  const EPS = 1e-9;
  const rows = EVAL_ROWS.map(row => {
    const v = self[row.key];
    const differs = Math.abs(v - other[row.key]) > EPS;
    return `<div class="logSetRow${differs ? ' logDiff' : ''}">` +
      `<dt>${esc(abbrevLabel(row.label))}</dt><dd>${fmtVal(v, row.dec)}</dd></div>`;
  }).join('');
  const dis = efsLocked() ? 'disabled' : '';
  return `<div class="logCol">
    <div class="logColHdr">${which === 'ef1' ? 'EF1' : 'EF2'}</div>
    <div class="logColAvg">avg move ${fmtMs(avg)}</div>
    <dl class="logSettings">${rows}</dl>
    <div class="logColBtns">
      <button class="toolBtn" data-act="apply" data-col="${which}" data-target="ef1" ${dis}>&rarr; EF1</button>
      <button class="toolBtn" data-act="apply" data-col="${which}" data-target="ef2" ${dis}>&rarr; EF2</button>
    </div>
  </div>`;
}

// Delegated click handler for the whole log list (bound once in init).
function onLogsClick(e) {
  const btn = e.target.closest('button');
  if (!btn) return;
  const act = btn.dataset.act;
  if (act === 'clear') { clearLogs(); return; }
  const row = e.target.closest('.logRow');
  const id = row && row.dataset.id;
  if (act === 'toggle') { toggleLogDetail(row, id); return; }
  if (act === 'delete') { deleteLog(id); return; }
  if (act === 'apply') {
    const entry = logs.find(x => x.id === id);
    if (!entry) return;
    const state = btn.dataset.col === 'ef1' ? entry.ef1 : entry.ef2;
    applyLoggedSettings(state, btn.dataset.target);
  }
}

// Expand/collapse a row; the detail body is built on first open.
function toggleLogDetail(row, id) {
  if (!row) return;
  const detail = row.querySelector('[data-detail]');
  const open = row.classList.toggle('open');
  if (open) {
    const entry = logs.find(x => x.id === id);
    if (entry) detail.innerHTML = logDetailHtml(entry);
    detail.style.display = '';
  } else {
    detail.style.display = 'none';
  }
}

// Remove a finished entry.  The in-progress run can't be deleted.
function deleteLog(id) {
  if (id === currentRunLogId) return;
  const i = logs.findIndex(x => x.id === id);
  if (i === -1) return;
  logs.splice(i, 1);
  saveLogs();
  renderLogs();
}

// Clear run history, keeping only the currently-running entry (if any).
function clearLogs() {
  logs = logs.filter(e => e.id === currentRunLogId);
  saveLogs();
  renderLogs();
}

// ------------------------------------------------------------
// Start / Pause / Stop control
// ------------------------------------------------------------
//
// State model:
//   running=false, paused=false  -> idle/stopped; next Start is a FRESH run.
//   running=true                 -> actively dispatching; button shows Pause.
//   running=false, paused=true   -> paused; next Start RESUMES (no reset).
// Stop ends a run but keeps results on screen and re-enables setup controls;
// the next Start is then a fresh run.

function onStartPause() {
  if (running) {        // -> Pause
    pauseRun();
    return;
  }
  // -> Start (resume if paused, else fresh run).
  if (!paused) startFreshRun();
  else resumeRun();
}

// Begin a brand-new run from the current setup controls.  May respawn the
// worker pool if the core count changed.
function startFreshRun() {
  if (document.getElementById('startPauseBtn').disabled) return;  // not ready

  // Snapshot setup.
  runSettings.ef1Depth = readInt('ef1', 'depth');
  runSettings.ef2Depth = readInt('ef2', 'depth');
  runSettings.ef1Quiesce = readInt('ef1', 'quiesce');
  runSettings.ef2Quiesce = readInt('ef2', 'quiesce');
  runSettings.rollout = document.getElementById('rolloutChk').checked;
  runSettings.ef1Weights = readWeights('ef1');
  runSettings.ef2Weights = readWeights('ef2');
  targetGames = Math.max(1, parseInt(document.getElementById('nGamesInput').value, 10) || 1);
  const cores = parseInt(document.getElementById('coresSlider').value, 10);

  resetRun();
  setControlsEnabled(false);

  const begin = () => {
    running = true;
    paused = false;
    logCreateEntry();  // record this run (only a real start logs; not refresh/idle)
    document.getElementById('startPauseBtn').textContent = 'Pause';
    document.getElementById('stopBtn').disabled = false;
    fillWorkersStaggered();
    startPlotLoop();
  };

  if (cores !== workers.length) {
    // Respawn the pool at the new size, then begin once ready.
    document.getElementById('progress').textContent = `Loading ${cores} workers…`;
    document.getElementById('startPauseBtn').disabled = true;
    spawnWorkers(cores, () => {
      document.getElementById('startPauseBtn').disabled = false;
      begin();
    });
  } else {
    begin();
  }
}

// Resume a paused run with the same settings and tallies.  The first few
// completions after resuming will briefly include the pause gap in their
// interval, but those age out of the moving-average window quickly.
function resumeRun() {
  running = true;
  paused = false;
  // No log change: resume continues the existing entry (currentRunLogId).
  document.getElementById('startPauseBtn').textContent = 'Pause';
  completionTimes = [];  // drop the pre-pause window so the rate restarts clean
  fillWorkersStaggered();
  startPlotLoop();
}

// Pause: halt dispatch, keep controls disabled, results preserved, resumable.
function pauseRun() {
  running = false;
  paused = true;
  logUpdateCurrent();  // flush current numbers in case the page is refreshed while paused
  document.getElementById('startPauseBtn').textContent = 'Start';
  stopPlotLoop();
}

// Stop: end the run, keep results on screen, re-enable setup.  Next Start is
// fresh.  Triggered by the Stop button.
function onStop() {
  if (!running && !paused) return;  // nothing to stop
  running = false;
  paused = false;
  runToken++;  // discard any in-flight results
  document.getElementById('startPauseBtn').textContent = 'Start';
  document.getElementById('stopBtn').disabled = true;
  setControlsEnabled(true);
  stopPlotLoop();
  updateCounters();
  logFinalize('stopped');  // record actual games played + status
}

// The run reached its target game count: end it like a Stop, but it completed
// naturally.
function finishRun() {
  running = false;
  paused = false;
  document.getElementById('startPauseBtn').textContent = 'Start';
  document.getElementById('stopBtn').disabled = true;
  setControlsEnabled(true);
  stopPlotLoop();
  updateCounters();
  logFinalize('done');
}

// Enable/disable all setup controls (everything except Play/Pause, Stop, and
// the read-only Save buttons, which are safe mid-run).
function setControlsEnabled(enabled) {
  const ids = ['nGamesInput', 'rolloutChk', 'coresSlider',
               'ef1ResetAll', 'ef2ResetAll',
               'ef1Copy', 'ef2Copy', 'ef1Load', 'ef2Load'];
  for (const prefix of ['ef1', 'ef2'])
    for (const row of EVAL_ROWS) ids.push(`${prefix}_${row.key}`, `${prefix}_${row.key}_num`);
  for (const id of ids) document.getElementById(id).disabled = !enabled;
  // Per-row reset buttons (created dynamically) — toggle them too.
  for (const btn of document.querySelectorAll('.rowResetBtn'))
    btn.disabled = !enabled;
  refreshLogApplyLock();  // the Logs tab's "-> EF" buttons also change the EFs
}

// Feed idle workers, but spread their starts over a short interval so their
// (similar-length) games finish at staggered times rather than in one lump.
// This desynchronizes completions into a steadier stream -- at high depth the
// chart then animates continuously instead of jumping once per batch.
const WORKER_STAGGER_MS = 50;  // delay between successive worker starts

function fillWorkersStaggered() {
  const idle = [];
  for (let i = 0; i < workers.length; i++) if (!workerBusy[i]) idle.push(i);
  // Never dispatch more games than remain to reach the target.
  const remaining = targetGames - nextGameIndex;
  const toStart = idle.slice(0, Math.max(0, remaining));
  toStart.forEach((workerIdx, k) => {
    if (k === 0) {
      dispatchTo(workerIdx);  // first worker starts immediately
    } else {
      setTimeout(() => {
        // Re-check: the run may have been paused/stopped during the stagger.
        if (running && !workerBusy[workerIdx] && nextGameIndex < targetGames) {
          dispatchTo(workerIdx);
        }
      }, k * WORKER_STAGGER_MS);
    }
  });
}

// Zero the counters, graph, and dispatch counters for a fresh run.
function resetRun() {
  runToken++;          // invalidate any in-flight games from the previous run
  gamesPlayed = 0;
  nextGameIndex = 0;
  ef1Wins = 0;
  ef2Wins = 0;
  draws = 0;
  ef1RateHistory = [];
  ef2RateHistory = [];
  emaEf1 = null; emaDraw = null; emaEf2 = null;
  completionTimes = [];
  ef1MoveMsTotal = 0; ef1MoveCount = 0;
  ef2MoveMsTotal = 0; ef2MoveCount = 0;
  updateCounters();
  drawPlot();
}

// ------------------------------------------------------------
// Dispatch + result application
// ------------------------------------------------------------

// Hand the next game to an idle worker.  Seed and color assignment derive from
// the dispatch index, so each game gets a distinct, reproducible opening.
function dispatchTo(workerIdx) {
  if (!running || nextGameIndex >= targetGames) return;  // run done / capped
  const dispatchIndex = nextGameIndex++;
  const swapColors = dispatchIndex % 2;                 // alternate starting color
  const seed = (dispatchIndex + 1) * 2654435761 >>> 0;  // distinct opening per game

  workerBusy[workerIdx] = true;
  workers[workerIdx].postMessage({
    type: 'play',
    token: runToken,
    ef1Mode: EF1_MODE,
    ef2Mode: EF2_MODE,
    ef1Depth: runSettings.ef1Depth,
    ef2Depth: runSettings.ef2Depth,
    ef1Quiesce: runSettings.ef1Quiesce,
    ef2Quiesce: runSettings.ef2Quiesce,
    seed,
    swapColors,
    noProgressCap: NO_PROGRESS_CAP,
    rollout: runSettings.rollout ? 1 : 0,
    w1: runSettings.ef1Weights,
    w2: runSettings.ef2Weights,
  });
}

// A worker returned a result.  Apply it immediately in completion order.
//
// We deliberately do NOT wait for index order: with many parallel workers and
// games that can take 10+ seconds, strict in-order application would block the
// entire display behind the single slowest in-flight game (head-of-line
// blocking).  The win/draw/loss TOTALS are independent of order, so they are
// unaffected; only the smoothed curve's exact wiggle becomes timing-dependent,
// which does not matter for reading the proportions.
function onGameResult(result) {
  applyGameResult(result);
  // Cheap text counters update immediately; the canvas redraw is paced by the
  // wall-clock plot loop (below).
  updateCounters();
  logUpdateCurrent();  // keep the in-progress log entry fresh (throttled disk write)
}

// ------------------------------------------------------------
// Wall-clock-paced plotting.
//
// While a run is active, redraw on a fixed time cadence rather than per game,
// so the chart feels live regardless of how fast games complete.  This also
// keeps plotting off the per-game dispatch path on fast (low-depth) runs.
// ------------------------------------------------------------
const PLOT_INTERVAL_MS = 100;  // ~10 redraws/sec while running
let plotRafId = 0;
let lastPlotTime = 0;

function startPlotLoop() {
  if (plotRafId) return;
  lastPlotTime = 0;  // force an immediate first draw
  plotRafId = requestAnimationFrame(plotTick);
}

function stopPlotLoop() {
  if (plotRafId) cancelAnimationFrame(plotRafId);
  plotRafId = 0;
  drawPlot();  // final paint so the last games are shown
}

function plotTick(now) {
  if (now - lastPlotTime >= PLOT_INTERVAL_MS) {
    lastPlotTime = now;
    drawPlot();
  }
  if (running) plotRafId = requestAnimationFrame(plotTick);
  else plotRafId = 0;
}

// Apply one game result (in completion order) to the tallies and the smoothed
// history.  Order doesn't affect totals; see onGameResult.
function applyGameResult(result) {
  if (result === 0) ef1Wins++;
  else if (result === 1) ef2Wins++;
  else draws++;
  gamesPlayed++;

  // Cumulative all-time shares (each in [0,1], summing to 1).
  const c1 = ef1Wins / gamesPlayed;
  const cd = draws   / gamesPlayed;
  const c2 = ef2Wins / gamesPlayed;

  // EMA-smooth the cumulative shares for display: seed with the first game,
  // then 0.8*old + 0.2*new.  This only damps the curve's wiggle; the value it
  // tracks is the cumulative share, so wins are never forgotten.
  if (emaEf1 === null) {
    emaEf1 = c1; emaDraw = cd; emaEf2 = c2;
  } else {
    emaEf1 = (1 - EMA_ALPHA) * emaEf1 + EMA_ALPHA * c1;
    emaDraw = (1 - EMA_ALPHA) * emaDraw + EMA_ALPHA * cd;
    emaEf2 = (1 - EMA_ALPHA) * emaEf2 + EMA_ALPHA * c2;
  }
  ef1RateHistory.push(emaEf1);
  ef2RateHistory.push(emaEf2);

  // Record completion time for the moving-average rate; keep only the window.
  completionTimes.push(performance.now());
  if (completionTimes.length > RATE_SAMPLES) completionTimes.shift();
}

function updateCounters() {
  // Raw counts.
  document.getElementById('ef1WinsVal').textContent = ef1Wins;
  document.getElementById('ef2WinsVal').textContent = ef2Wins;
  document.getElementById('drawsVal').textContent = draws;

  // Percentages above the counts (rounded to nearest %; slop summing to ~100
  // is acceptable).
  const pct = (n) => gamesPlayed > 0 ? Math.round((n / gamesPlayed) * 100) + '%' : '—';
  document.getElementById('ef1PctVal').textContent = pct(ef1Wins);
  document.getElementById('drawsPctVal').textContent = pct(draws);
  document.getElementById('ef2PctVal').textContent = pct(ef2Wins);

  // Progress line: % complete • games • games/s.  All three fields always show
  // (rate falls back to 0.0 before there is enough data) so the user sees the
  // layout from the start.
  const pctComplete = Math.min(100, Math.round((gamesPlayed / targetGames) * 100));
  const rate = currentRate();
  const parts = [
    `${pctComplete}% complete`,
    `${gamesPlayed} / ${targetGames} games`,
    `${(rate !== null ? rate : 0).toFixed(1)} games/s`,
  ];
  document.getElementById('progress').textContent = parts.join('  •  ');

  // Per-EF average move time (minimax moves only).  Shows the asymmetric
  // compute cost of each function's depth/quiescence settings.
  const avg = (ms, n) => n > 0 ? `${(ms / n).toFixed(1)} ms` : '—';
  document.getElementById('moveTimes').textContent =
    `avg move time:  #1 ${avg(ef1MoveMsTotal, ef1MoveCount)}` +
    `  •  #2 ${avg(ef2MoveMsTotal, ef2MoveCount)}`;
}

// Games/sec over the last RATE_SAMPLES completed games (a moving average).
// Reflects current speed without baking in the startup ramp, and is immune to
// empty-window swings because it counts a fixed number of games, not a fixed
// time span.  Returns null until there are at least two samples.
function currentRate() {
  const k = completionTimes.length;
  if (k < 2) return null;
  const span = completionTimes[k - 1] - completionTimes[0];
  if (span <= 0) return null;
  return ((k - 1) / span) * 1000;  // (k-1) intervals between k timestamps
}

// ------------------------------------------------------------
// Plot — stacked proportion chart (win / draw / loss shares)
//
// At every game the three running shares (#1 wins, draws, #2 wins) sum to 1
// and fill the full plot height.  Bands, bottom to top: #1 (blue), draws
// (gray), #2 (red).  The relative heights ARE the outcome proportions, so a
// single glance distinguishes "50 wins / 50 losses" from "50 wins / 50 draws".
// ------------------------------------------------------------
function resizePlot() {
  if (!plotCanvas) return;
  const rect = plotCanvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  plotCanvas.width = Math.max(1, Math.round(rect.width * dpr));
  plotCanvas.height = Math.max(1, Math.round(rect.height * dpr));
  plotCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// Fill the band between two cumulative-fraction edge-functions, sampling only
// at the given history indices `idx` (so cost is O(pixels), not O(games)).
// lowerOf/upperOf map a history index to the band's lower/upper fraction.
function drawBand(idx, lowerOf, upperOf, color, geom) {
  const { PAD_L, PAD_T, pw, ph, xMax } = geom;
  const m = idx.length;
  if (m === 0) return;
  const xAt = i => PAD_L + (i / xMax) * pw;
  const yAt = f => PAD_T + ph - f * ph;  // fraction [0,1] -> pixel y

  plotCtx.fillStyle = color;
  plotCtx.beginPath();
  // Upper edge, left to right.
  plotCtx.moveTo(xAt(idx[0]), yAt(upperOf(idx[0])));
  for (let k = 1; k < m; k++) plotCtx.lineTo(xAt(idx[k]), yAt(upperOf(idx[k])));
  // Lower edge, right to left.
  for (let k = m - 1; k >= 0; k--) plotCtx.lineTo(xAt(idx[k]), yAt(lowerOf(idx[k])));
  plotCtx.closePath();
  plotCtx.fill();
}

// Build an evenly-spaced set of history indices, at most `maxPts`, always
// including the last index so the latest value is shown.
function sampledIndices(n, maxPts) {
  if (n <= maxPts) {
    const idx = new Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    return idx;
  }
  const idx = [];
  const step = (n - 1) / (maxPts - 1);
  for (let k = 0; k < maxPts; k++) idx.push(Math.round(k * step));
  idx[idx.length - 1] = n - 1;  // guarantee the last point
  return idx;
}

function drawPlot() {
  if (!plotCtx) return;
  const dpr = window.devicePixelRatio || 1;
  const W = plotCanvas.width / dpr;
  const H = plotCanvas.height / dpr;
  const PAD_L = 48, PAD_R = 14, PAD_T = 18, PAD_B = 44;
  const pw = W - PAD_L - PAD_R;
  const ph = H - PAD_T - PAD_B;

  plotCtx.fillStyle = '#111';
  plotCtx.fillRect(0, 0, W, H);

  const n = ef1RateHistory.length;
  // X auto-scales to the data so the curve fills the panel width, but not below
  // a floor (~100 games) -- so early on the plot isn't a wild, near-empty
  // stretch of 2-3 points; it eases in, reaching full width by ~100 games and
  // rescaling thereafter as more games arrive.
  const X_FLOOR = 100;
  const xMax = Math.max(n - 1, X_FLOOR);
  const geom = { PAD_L, PAD_T, pw, ph, xMax };

  // Draw the stacked bands first, so axis/labels sit on top.  Sample at most
  // ~plot-width points so redraw cost stays constant regardless of run length.
  if (n > 0) {
    const idx = sampledIndices(n, Math.max(2, Math.ceil(pw)));

    // Bands stack bottom->top: #2 (red), draws (gray), #1 (blue).  Because
    // fraction 1 maps to the TOP of the plot, this renders top->bottom as
    // blue / gray / red, matching the left panel order (#1 above #2).
    // Cumulative boundaries: 0 -> #2 -> #2+draws -> 1.
    const zero = () => 0;
    const top2 = i => ef2RateHistory[i];                       // top of #2 band
    const topD = i => 1 - ef1RateHistory[i];                   // top of draws band
    const one  = () => 1;

    drawBand(idx, zero, top2, EF2_COLOR, geom);   // #2 wins (bottom)
    drawBand(idx, top2, topD, DRAW_COLOR, geom);  // draws (middle)
    drawBand(idx, topD, one,  EF1_COLOR, geom);   // #1 wins (top)
  }

  // Horizontal grid lines + Y tick labels (0, 0.25, 0.5, 0.75, 1).
  plotCtx.font = '10px monospace';
  const yTicks = 4;
  for (let i = 0; i <= yTicks; i++) {
    const y = PAD_T + ph - (i / yTicks) * ph;
    const v = i / yTicks;
    plotCtx.beginPath();
    plotCtx.moveTo(PAD_L, y);
    plotCtx.lineTo(PAD_L + pw, y);
    plotCtx.strokeStyle = 'rgba(255,255,255,0.12)';
    plotCtx.lineWidth = 1;
    plotCtx.stroke();
    plotCtx.fillStyle = '#777';
    plotCtx.textAlign = 'right';
    plotCtx.fillText(v.toFixed(2), PAD_L - 6, y + 3);
  }

  // Frame the plot area.
  plotCtx.strokeStyle = '#333';
  plotCtx.lineWidth = 1;
  plotCtx.strokeRect(PAD_L, PAD_T, pw, ph);

  // Y axis label.
  plotCtx.fillStyle = '#555';
  plotCtx.save();
  plotCtx.translate(14, PAD_T + ph / 2);
  plotCtx.rotate(-Math.PI / 2);
  plotCtx.textAlign = 'center';
  plotCtx.fillText('Proportion', 0, 0);
  plotCtx.restore();

  // X axis label — centered on the whole panel, not the plot area.
  plotCtx.fillStyle = '#555';
  plotCtx.textAlign = 'center';
  plotCtx.fillText('Games', W / 2, H - PAD_B + 18);

  // Legend: colored swatch + label for each band — centered on the panel.
  const legendY = H - PAD_B + 36;
  const items = [
    { label: '#1 Wins', color: EF1_COLOR },
    { label: 'Draws',   color: DRAW_COLOR },
    { label: '#2 Wins', color: EF2_COLOR },
  ];
  const totalW = items.reduce((a, it) => a + it.label.length * 6 + 24, 0);
  let lx = (W - totalW) / 2;
  for (const it of items) {
    plotCtx.fillStyle = it.color;
    plotCtx.fillRect(lx, legendY - 8, 10, 8);
    plotCtx.fillStyle = '#aaa';
    plotCtx.textAlign = 'left';
    plotCtx.fillText(it.label, lx + 14, legendY);
    lx += it.label.length * 6 + 24;
  }
}

// ------------------------------------------------------------
// Output-panel tabs (Test plot <-> Play board) + seat assignment
// ------------------------------------------------------------

// Which agent occupies each color seat: 'ef1' | 'ef2' | 'user'.  Read from the
// dropdowns; consumed by the game loop (added in the next step).
let seats = { red: 'user', black: 'ef1' };  // synced from the DOM at init (readSeats)

// True when both seats are agents (no human) -- the only mode where Step makes
// sense.
function isAgentVsAgent() {
  return seats.red !== 'user' && seats.black !== 'user';
}

function readSeats() {
  seats.red = document.getElementById('redSeat').value;
  seats.black = document.getElementById('blackSeat').value;
  updatePlayControls();
  // Seats only change at the opening (locked during play): refresh the EF
  // readouts for the new assignment, starting their deltas fresh.
  efPrev = { red: null, black: null };
  requestEval('start');
}

// Live pacing read from the sliders (seconds).  Read at the moment each timing
// is needed so adjustments take effect immediately, mid-game.
function moveSpeedSec() {
  return parseFloat(document.getElementById('moveSpeedSlider').value) || 0.5;
}
function turnGapSec() {
  return parseFloat(document.getElementById('turnGapSlider').value) || 0.5;
}

// Reflect a pacing slider's value in its label (e.g. "0.5s").
function updatePaceLabels() {
  document.getElementById('moveSpeedVal').textContent = moveSpeedSec().toFixed(1) + 's';
  document.getElementById('turnGapVal').textContent = turnGapSec().toFixed(1) + 's';
}

// Enable/disable the Play-tab controls per the current seat assignment.  The
// pacing sliders are always live (they work mid-game); Play/Step/Reset
// availability depends on the game's run state (handled in setPlayButtons).
function updatePlayControls() {
  setPlayButtons();
}

// Toggle the output panel between the Test (plot) and Play (board) views.
// Switching tabs suspends whatever was running: entering Play pauses an active
// Test run; leaving Play pauses the live game (so it doesn't advance unseen, and
// its eval is in a clean editable state).
function switchOutputTab(name) {
  const isTest = name === 'test';
  if (!isTest && running) pauseRun();  // pause a live Test run when entering Play
  if (isTest && playStarted && !playPaused && playState !== 'over') pausePlay();
  document.getElementById('tabTest').classList.toggle('active', isTest);
  document.getElementById('tabPlay').classList.toggle('active', !isTest);
  document.getElementById('testView').style.display = isTest ? '' : 'none';
  document.getElementById('playView').style.display = isTest ? 'none' : '';
  // The board canvas has zero size while hidden; size and paint it on reveal.
  if (!isTest) { resizeBoard(); refreshBoard(); }
}

// ------------------------------------------------------------
// Board — 8x8 checkers board (render + animation)
//
// Geometry matches the engine: 32 dark playable squares numbered 0..31.  The
// engine's sq_to_rc is mirrored here (sqToRC) so engine move data maps onto the
// 8x8 render grid.  RED starts on the bottom three rows (5-7), BLACK on the top
// (0-2); row 0 is the top of the canvas.  The board model is kept in sync from
// the play worker's authoritative post-move board after each ply.
// ------------------------------------------------------------
const BOARD_N = 8;
const SQ_LIGHT = '#3a3a3a';   // inert (non-playable) squares
const SQ_DARK  = '#202020';   // playable squares
const PIECE_RED   = '#e0584f';
const PIECE_BLACK = '#1b1b1b';
const PIECE_RED_EDGE   = '#f4988f';
const PIECE_BLACK_EDGE = '#555';
const KING_MARK = '#f0c040';  // crown glyph color (contrasting but soft)
const SELECT_EDGE = '#ffd24a';  // stroke on the selected piece (human input)
const GHOST_PATH = 'rgba(240, 192, 64, 0.6)';  // dotted multi-jump path preview

// Engine cell codes (must match engine.cpp Cell enum).
const CELL_EMPTY = 0, CELL_R_MAN = 1, CELL_R_KING = 2, CELL_B_MAN = 3, CELL_B_KING = 4;

// Board model: 8x8 grid.  Each cell is null or { side:'red'|'black', king:bool }.
let board = makeStartBoard();

// Mirror of engine sq_to_rc: square 0..31 -> {row, col} on the 8x8 grid.
function sqToRC(sq) {
  const row = Math.floor(sq / 4);
  const offset = (row % 2 === 0) ? 1 : 0;
  const col = (sq % 4) * 2 + offset;
  return { row, col };
}

// Mirror of engine rc_to_sq: {row, col} -> square 0..31, or -1 if off-board or a
// light (non-playable) square.  Used to map board clicks to engine squares.
function rcToSq(row, col) {
  if (row < 0 || row > 7 || col < 0 || col > 7) return -1;
  if (((row + col) & 1) === 0) return -1;  // light square
  const offset = (row % 2 === 0) ? 1 : 0;
  return row * 4 + (col - offset) / 2;
}

// Convert an engine cell code to a render piece (or null).
function cellToPiece(code) {
  switch (code) {
    case CELL_R_MAN:  return { side: 'red',   king: false };
    case CELL_R_KING: return { side: 'red',   king: true  };
    case CELL_B_MAN:  return { side: 'black', king: false };
    case CELL_B_KING: return { side: 'black', king: true  };
    default:          return null;
  }
}

function makeStartBoard() {
  const g = [];
  for (let r = 0; r < BOARD_N; r++) {
    const row = [];
    for (let c = 0; c < BOARD_N; c++) {
      const playable = (r + c) % 2 === 1;
      if (playable && r <= 2) row.push({ side: 'black', king: false });
      else if (playable && r >= 5) row.push({ side: 'red', king: false });
      else row.push(null);
    }
    g.push(row);
  }
  return g;
}

// Replace the board model from an engine board array (32 cell codes).
function syncBoardFromCells(cells) {
  for (let r = 0; r < BOARD_N; r++)
    for (let c = 0; c < BOARD_N; c++) board[r][c] = null;
  for (let sq = 0; sq < 32; sq++) {
    const { row, col } = sqToRC(sq);
    board[row][col] = cellToPiece(cells[sq]);
  }
}

function resizeBoard() {
  if (!boardCanvas) return;
  const rect = boardCanvas.getBoundingClientRect();
  if (rect.width === 0) return;  // hidden (Test tab active): skip until shown
  const dpr = window.devicePixelRatio || 1;
  const side = Math.max(1, Math.round(Math.min(rect.width, rect.height) * dpr));
  boardCanvas.width = side;
  boardCanvas.height = side;
  boardCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// Draw the whole board.  Optional layers (mutually exclusive in practice):
//   `anim`    — a move in flight: { fromRC, toRC, t, piece, captured:Set, hideRC }
//   `overlay` — human input cues: { movable:Set<"r,c">, selected:{row,col}|null,
//               ghosts:[{row,col,side,king,path:[{row,col}],isJump}] }
function drawBoard(anim, overlay) {
  if (!boardCtx) return;
  const dpr = window.devicePixelRatio || 1;
  const W = boardCanvas.width / dpr;
  if (W <= 1) return;  // not sized yet (hidden)
  const cell = W / BOARD_N;
  const radius = cell * 0.38;
  const center = (idx) => idx * cell + cell / 2;

  // Squares.
  for (let r = 0; r < BOARD_N; r++) {
    for (let c = 0; c < BOARD_N; c++) {
      const playable = (r + c) % 2 === 1;
      boardCtx.fillStyle = playable ? SQ_DARK : SQ_LIGHT;
      boardCtx.fillRect(c * cell, r * cell, cell, cell);
    }
  }

  // Glow behind movable pieces (under the pieces) during human input.  The
  // selected piece gets the stroke highlight instead, so skip its glow.
  if (overlay && overlay.movable) {
    const selKey = overlay.selected
      ? overlay.selected.row + ',' + overlay.selected.col : null;
    for (const key of overlay.movable) {
      if (key === selKey) continue;
      const [r, c] = key.split(',').map(Number);
      drawGlow(center(c), center(r), cell);
    }
  }

  // Static pieces (skip the moving piece's origin and any captured/hidden ones).
  for (let r = 0; r < BOARD_N; r++) {
    for (let c = 0; c < BOARD_N; c++) {
      const p = board[r][c];
      if (!p) continue;
      if (anim) {
        if (anim.hideRC && anim.hideRC.row === r && anim.hideRC.col === c) continue;
        if (anim.captured && anim.captured.has(r + ',' + c)) continue;
      }
      const selected = overlay && overlay.selected &&
        overlay.selected.row === r && overlay.selected.col === c;
      drawPiece(center(c), center(r), radius, p, selected ? SELECT_EDGE : null);
    }
  }

  // The moving piece, interpolated between its from/to squares.
  if (anim && anim.piece) {
    const fx = center(anim.fromRC.col), fy = center(anim.fromRC.row);
    const tx = center(anim.toRC.col),   ty = center(anim.toRC.row);
    drawPiece(fx + (tx - fx) * anim.t, fy + (ty - fy) * anim.t, radius, anim.piece);
  }

  // Ghost destinations + dotted jump paths (on top), during human input.
  if (overlay && overlay.ghosts) {
    for (const g of overlay.ghosts) {
      if (g.isJump && g.path && g.path.length > 1) {
        boardCtx.save();
        boardCtx.setLineDash([cell * 0.12, cell * 0.1]);
        boardCtx.lineWidth = Math.max(1.5, cell * 0.04);
        boardCtx.strokeStyle = GHOST_PATH;
        boardCtx.beginPath();
        boardCtx.moveTo(center(g.path[0].col), center(g.path[0].row));
        for (let i = 1; i < g.path.length; i++)
          boardCtx.lineTo(center(g.path[i].col), center(g.path[i].row));
        boardCtx.stroke();
        boardCtx.restore();
      }
      boardCtx.save();
      boardCtx.globalAlpha = 0.32;
      drawPiece(center(g.col), center(g.row), radius, { side: g.side, king: g.king }, null);
      boardCtx.restore();
    }
  }
}

// Redraw the board, preserving the human-input overlay if a human turn is
// awaiting input (used by resize/tab-switch so the glow/selection survive).
function refreshBoard() {
  if (awaitingHuman) drawHumanOverlay();
  else drawBoard();
}

function drawGlow(cx, cy, cell) {
  const r = cell * 0.52;
  const grad = boardCtx.createRadialGradient(cx, cy, r * 0.2, cx, cy, r);
  grad.addColorStop(0, 'rgba(240, 192, 64, .9)');
  grad.addColorStop(1, 'rgba(240, 192, 64, 0)');
  boardCtx.fillStyle = grad;
  boardCtx.beginPath();
  boardCtx.arc(cx, cy, r, 0, Math.PI * 2);
  boardCtx.fill();
}

function drawPiece(cx, cy, radius, piece, highlightEdge) {
  boardCtx.beginPath();
  boardCtx.arc(cx, cy, radius, 0, Math.PI * 2);
  boardCtx.fillStyle = piece.side === 'red' ? PIECE_RED : PIECE_BLACK;
  boardCtx.fill();
  if (highlightEdge) {
    boardCtx.lineWidth = Math.max(2, radius * 0.22);
    boardCtx.strokeStyle = highlightEdge;
  } else {
    boardCtx.lineWidth = Math.max(1, radius * 0.12);
    boardCtx.strokeStyle = piece.side === 'red' ? PIECE_RED_EDGE : PIECE_BLACK_EDGE;
  }
  boardCtx.stroke();

  // King: a crown glyph in a soft contrasting color, centered on the piece.
  if (piece.king) {
    boardCtx.fillStyle = KING_MARK;
    boardCtx.font = `${Math.round(radius * 1.1)}px serif`;
    boardCtx.textAlign = 'center';
    boardCtx.textBaseline = 'middle';
    // Nudge down slightly so the crown sits visually centered.
    boardCtx.fillText('♛', cx, cy + radius * 0.08);
  }
}

// ------------------------------------------------------------
// Play loop — interactive game (dedicated play worker)
//
// One extra worker (play-worker.js) holds the engine's persistent interactive
// game, off the main thread.  Each seat is an agent (EF1/EF2) or a human (User).
//   Play -> Pause -> Resume controls the game in both modes.  Pausing unlocks
//     the eval panels so the user can edit an EF and watch its readout shift on
//     the frozen position; Resume re-locks and the agents use the new weights.
//   Step (agent-vs-agent only) plays exactly one ply, then pauses.
//   Reset returns to the opening and re-enables the seat dropdowns.
// See advanceTurn / enterHumanInput / onBoardClick / pausePlay / resumePlay.
// ------------------------------------------------------------

// Move slide + turn-gap durations come live from the pacing sliders (seconds),
// read at use time so changes take effect immediately, even mid-game.

const PLAY_NO_PROGRESS_CAP = NO_PROGRESS_CAP;  // same draw rule as the Test tab

let playWorker = null;
let playReady = false;
// 'idle'  : at a stable position, not animating (start position or between plies)
// 'busy'  : a move is in flight (awaiting worker) or animating/pausing
// 'over'  : game ended (win/draw); only Reset proceeds
let playState = 'idle';
// Game-progress model (replaces the old playMode):
//   playStarted : a game is underway (Play/Step pressed; cleared on reset/over)
//   playPaused  : user-suspended for editing -- eval panels are unlocked, the
//             game halts at the next stable point, and Play shows "Resume"
//   playAutoRun : agent-vs-agent continuous (Play) vs single-step (Step)
let playStarted = false;
let playPaused = false;
let playAutoRun = false;
let playNoProgress = 0;      // host-tracked no-progress counter for the draw rule
let playAnimToken = 0;       // bumped on reset/stop to cancel in-flight animations
let playSideToMove = 0;      // 0 RED, 1 BLACK; RED moves first

// Human input state (Play tab).  awaitingHuman is true while we wait for the
// side-to-move (a 'user' seat) to click; legalMoves holds that turn's legal
// moves (from the worker), and selectedSq is the picked piece's square or -1.
let awaitingHuman = false;
let legalMoves = [];
let selectedSq = -1;

// Spawn the dedicated play worker (once).  Safe to call repeatedly.
function ensurePlayWorker() {
  if (playWorker) return;
  try {
    playWorker = new Worker('./play-worker.js');
    playWorker.onmessage = (e) => handlePlayMessage(e.data);
    playWorker.onerror = (e) => console.error('[play-worker] error', e.message || e);
  } catch (err) {
    console.error('[play-worker] spawn failed', err);
  }
}

// Resolve an agent seat ('ef1'|'ef2') to its engine settings, read live from the
// eval panels.  ('user' seats never call this -- they go through human input.)
function seatSettings(seat) {
  const prefix = seat === 'ef2' ? 'ef2' : 'ef1';
  return {
    mode: 1,  // minimax
    depth: readInt(prefix, 'depth'),
    q: readInt(prefix, 'quiesce'),
    w: readWeights(prefix),
  };
}

// Which seat ('red'/'black') is to move, given the engine side code (0 RED).
function sideToSeat(sideCode) { return sideCode === 0 ? 'red' : 'black'; }

// ---- EF-value readout (Play tab) ----
//
// For each EF seat, show its evaluation of the CURRENT position (from its own
// side's perspective) plus the change since the prior position.  The value is
// computed by the engine (ig_eval) via the worker; the delta is shown in
// green/gray/red and flashes when a move changes it.
let efPrev = { red: null, black: null };  // previous (rounded) eval per seat; null = none

function round2(x) { const r = Math.round(x * 100) / 100; return r === 0 ? 0 : r; }

// Resolve a seat to its EF readout info, or null if the seat is a human.
function efSeatInfo(seatKey) {
  const seat = seats[seatKey];
  if (seat === 'user') return null;
  const prefix = seat === 'ef2' ? 'ef2' : 'ef1';
  return {
    label: seat === 'ef2' ? 'EF2' : 'EF1',
    side: seatKey === 'red' ? 0 : 1,
    w: readWeights(prefix),
  };
}

// Ask the worker to evaluate the current position for each EF seat.  Human seats
// have their readout cleared.  `reason` ('move' | 'edit' | 'start') is echoed
// back so the delta field can be rendered appropriately.  No-op until the worker
// is ready (which is also after the eval panels exist, so reading weights here
// is safe).
function requestEval(reason) {
  if (!playReady) return;
  const r = efSeatInfo('red'), b = efSeatInfo('black');
  if (!r) updateEfReadout('red', null, reason);
  if (!b) updateEfReadout('black', null, reason);
  if (!r && !b) return;
  playWorker.postMessage({
    type: 'eval',
    reason: reason || 'start',
    red: r ? { side: r.side, w: r.w } : null,
    black: b ? { side: b.side, w: b.w } : null,
  });
}

// Render one seat's readout from a fresh eval value (or null to clear it).
// Delta field by `reason`:
//   'move' : the position changed via a move -> colored (+/-) with a flash, or
//            "( = )" if the value is genuinely unchanged.
//   'edit' / 'start' / first reading : "(NA)" in gray (no meaningful delta).
function updateEfReadout(seatKey, rawValue, reason) {
  const wrap = document.getElementById(seatKey === 'red' ? 'redEval' : 'blackEval');
  if (!wrap) return;
  const info = efSeatInfo(seatKey);
  if (!info || rawValue === null || rawValue === undefined) {
    wrap.innerHTML = '';
    efPrev[seatKey] = null;
    return;
  }
  const val = round2(rawValue);
  const prev = efPrev[seatKey];

  let cls = 'efNeutral', txt = '(NA)', flash = false;
  if (reason === 'move' && prev !== null) {
    const delta = round2(val - prev);
    if (delta > 0) { cls = 'efPos'; txt = `(+${delta.toFixed(2)})`; flash = true; }
    else if (delta < 0) { cls = 'efNeg'; txt = `(${delta.toFixed(2)})`; flash = true; }
    else { cls = 'efNeutral'; txt = '( = )'; }  // a move that left the value unchanged
  }

  wrap.innerHTML =
    `<span class="efVal">${info.label}(state) = ${val.toFixed(2)}</span>` +
    `<span class="efDelta ${cls}">${txt}</span>`;
  if (flash) {
    const d = wrap.querySelector('.efDelta');
    d.classList.add('efFlash');
    d.addEventListener('animationend', () => d.classList.remove('efFlash'), { once: true });
  }
  efPrev[seatKey] = val;
}

// Debounced recompute of the readouts when an eval weight is edited while the
// game is editable (at the opening, or paused).  Shows the new value with an
// "(NA)" delta (see updateEfReadout).
let evalEditTimer = 0;
function onEvalEdited() {
  if (playStarted && !playPaused) return;  // eval panels are locked while running
  if (evalEditTimer) clearTimeout(evalEditTimer);
  evalEditTimer = setTimeout(() => { evalEditTimer = 0; requestEval('edit'); }, 60);
}

// Enable/disable the EF1/EF2 eval-panel controls (sliders, number boxes, per-row
// resets, and the reset-all/copy/load tools).  Save stays available (read-only).
// Locked while a game runs; unlocked at the opening and while paused.
function setEvalPanelsEnabled(enabled) {
  const ids = ['ef1ResetAll', 'ef2ResetAll', 'ef1Copy', 'ef2Copy', 'ef1Load', 'ef2Load'];
  for (const prefix of ['ef1', 'ef2'])
    for (const row of EVAL_ROWS) ids.push(`${prefix}_${row.key}`, `${prefix}_${row.key}_num`);
  for (const id of ids) { const el = document.getElementById(id); if (el) el.disabled = !enabled; }
  for (const btn of document.querySelectorAll('.rowResetBtn')) btn.disabled = !enabled;
  refreshLogApplyLock();  // the Logs tab's "-> EF" buttons also change the EFs
}

// Disable/enable the Logs-tab "-> EF1 / -> EF2" apply buttons currently in the
// DOM to match efsLocked().  (New rows are rendered with the right state via
// settingsColumnHtml; this keeps already-rendered ones in sync when play state
// changes while the Logs tab is open alongside the board.)
function refreshLogApplyLock() {
  const locked = efsLocked();
  for (const b of document.querySelectorAll('#logsInner button[data-act="apply"]'))
    b.disabled = locked;
}

function setPlayButtons() {
  const playBtn = document.getElementById('playStartBtn');
  const stepBtn = document.getElementById('playStepBtn');
  const resetBtn = document.getElementById('playResetBtn');
  const over = (playState === 'over');
  const ava = isAgentVsAgent();
  resetBtn.disabled = !playReady;

  // Play button cycles Play -> Pause -> Resume over the game's life (both modes).
  if (over) playBtn.textContent = 'Play Again';
  else if (!playStarted) playBtn.textContent = 'Play';
  else if (playPaused) playBtn.textContent = 'Resume';
  else playBtn.textContent = 'Pause';
  playBtn.disabled = !playReady;

  // Step (agent-vs-agent only): advances exactly one ply.  Usable when not over,
  // not mid-move, and the game is either not started yet or paused.
  stepBtn.disabled =
    !playReady || !ava || over || playState === 'busy' || (playStarted && !playPaused);
}

// Pause the game: unlock the eval panels for editing and halt at the next stable
// point.  In-flight animations finish (finishMove halts on `paused`); a pending
// agent turn-gap bails; human clicks are blocked (onBoardClick checks `paused`).
function pausePlay() {
  playPaused = true;
  setEvalPanelsEnabled(true);
  setPlayButtons();
}

// Resume after a pause: re-lock the eval panels (agents now use the edited
// weights) and continue -- finish the human's turn, or hand off the next turn.
function resumePlay() {
  playPaused = false;
  playAutoRun = true;  // Resume implies continuous run for agents
  setEvalPanelsEnabled(false);
  setPlayButtons();
  if (playState === 'over') return;
  if (awaitingHuman) drawHumanOverlay();  // clicks re-enabled (playPaused is false)
  else advanceTurn();
}

// Lock/unlock the seat dropdowns.  Locked once a game is underway (any move
// played or running); unlocked at the opening / after Reset.  The pacing
// sliders are NOT locked -- they work live, mid-game.
function setSeatLock(locked) {
  document.getElementById('redSeat').disabled = locked;
  document.getElementById('blackSeat').disabled = locked;
  // Speed stays adjustable during play; only seats lock.
}

function handlePlayMessage(msg) {
  if (msg.type === 'ready') {
    playReady = true;
    // Paint the opening position now that the worker is up.
    playWorker.postMessage({ type: 'reset' });
    return;
  }
  if (msg.type === 'reset_done') {
    syncBoardFromCells(msg.board);
    playState = 'idle';
    playStarted = false; playPaused = false; playAutoRun = false;
    playNoProgress = 0;
    playSideToMove = msg.side;  // RED (0) moves first
    awaitingHuman = false; legalMoves = []; selectedSq = -1;
    efPrev = { red: null, black: null };  // fresh game: deltas start at "(NA)"
    setEvalPanelsEnabled(true);  // editable at the opening
    setSeatLock(false);
    setPlayButtons();
    setPlayStatus('');
    resizeBoard();
    drawBoard();
    requestEval('start');  // show the opening eval for each EF seat
    return;
  }
  if (msg.type === 'eval_result') {
    if (msg.red !== null && msg.red !== undefined) updateEfReadout('red', msg.red, msg.reason);
    if (msg.black !== null && msg.black !== undefined) updateEfReadout('black', msg.black, msg.reason);
    return;
  }
  if (msg.type === 'legal_result') {
    // Reply for a human turn.  No legal moves -> that side has lost (the worker
    // set the terminal status); the board is already current on screen.
    if (!msg.moves || msg.moves.length === 0) {
      endGame(msg.status);
      return;
    }
    legalMoves = msg.moves;
    awaitingHuman = true;
    selectedSq = -1;
    drawHumanOverlay();
    return;
  }
  if (msg.type === 'moved') {
    // A terminal status with no move played (path empty) means the side to move
    // had no legal moves -- the most common way to win in checkers.  There's
    // nothing to animate, so commit the (unchanged) board and end the game.
    if (!msg.path || msg.path.length === 0) {
      syncBoardFromCells(msg.board);
      drawBoard();
      requestEval('move');
      endGame(msg.status);
      return;
    }
    animateMove(msg);
    return;
  }
}

// Request the move for the side to move.  We track the side locally
// (playSideToMove, updated from each worker reply) so we can pass that seat's
// agent settings into the pick.
function requestMove() {
  if (!playReady || playState === 'over') return;
  const seat = sideToSeat(playSideToMove);
  if (seats[seat] === 'user') return;  // human turns go through enterHumanInput
  const s = seatSettings(seats[seat]);
  playState = 'busy';
  setPlayButtons();
  playWorker.postMessage({
    type: 'pick',
    mode: s.mode, depth: s.depth, q: s.q, w: s.w,
    noProgress: playNoProgress, noProgressCap: PLAY_NO_PROGRESS_CAP,
  });
}

// Hand the turn to whoever is to move: an agent computes (requestMove); a human
// gets prompted for input (enterHumanInput).
function advanceTurn() {
  if (playState === 'over' || playPaused) return;
  if (seats[sideToSeat(playSideToMove)] === 'user') enterHumanInput();
  else requestMove();
}

// Begin a human turn: ask the worker for the legal moves; the 'legal_result'
// handler then shows the movable-piece glow and waits for clicks.
function enterHumanInput() {
  if (!playReady || playState === 'over') return;
  awaitingHuman = false;  // becomes true once legal moves arrive
  selectedSq = -1;
  playState = 'idle';
  playWorker.postMessage({ type: 'legal' });
}

// Squares (as "r,c") of pieces the human can move this turn.
function movableSquareSet() {
  const set = new Set();
  for (const m of legalMoves) {
    const { row, col } = sqToRC(m.from);
    set.add(row + ',' + col);
  }
  return set;
}

// Draw the board with the human-input overlay for the current selection.
function drawHumanOverlay() {
  if (!awaitingHuman) { drawBoard(); return; }
  const overlay = { movable: movableSquareSet(), selected: null, ghosts: [] };
  if (selectedSq >= 0) {
    overlay.selected = sqToRC(selectedSq);
    const moverSide = playSideToMove === 0 ? 'red' : 'black';
    const sel = board[overlay.selected.row][overlay.selected.col];
    const king = sel ? sel.king : false;
    for (const m of legalMoves) {
      if (m.from !== selectedSq) continue;
      const dest = sqToRC(m.to);
      overlay.ghosts.push({
        row: dest.row, col: dest.col, side: moverSide, king,
        isJump: m.captured.length > 0,
        path: m.path.map(sqToRC),
      });
    }
  }
  drawBoard(null, overlay);
}

// A click on the board during a human turn.
function onBoardClick(e) {
  if (!awaitingHuman || playPaused) return;  // ignore clicks while paused
  const rect = boardCanvas.getBoundingClientRect();
  const cell = rect.width / BOARD_N;
  const col = Math.floor((e.clientX - rect.left) / cell);
  const row = Math.floor((e.clientY - rect.top) / cell);
  const sq = rcToSq(row, col);
  if (sq < 0) { selectedSq = -1; drawHumanOverlay(); return; }

  // If a piece is selected and this square is one of its legal destinations,
  // commit that move.
  if (selectedSq >= 0) {
    const moveIdx = legalMoves.findIndex(m => m.from === selectedSq && m.to === sq);
    if (moveIdx >= 0) { commitHumanMove(moveIdx); return; }
  }
  // Otherwise, select this square if it's a movable piece; else deselect.
  const isMovable = legalMoves.some(m => m.from === sq);
  selectedSq = isMovable ? sq : -1;
  drawHumanOverlay();
}

// Commit the human's chosen move (index into legalMoves) via the worker; the
// resulting 'moved' message animates through the shared pipeline.
function commitHumanMove(i) {
  awaitingHuman = false;
  selectedSq = -1;
  playState = 'busy';
  playWorker.postMessage({
    type: 'apply', index: i,
    noProgress: playNoProgress, noProgressCap: PLAY_NO_PROGRESS_CAP,
  });
}

// Animate a completed move, then commit the board and continue/stop.
function animateMove(msg) {
  const token = playAnimToken;
  setSeatLock(true);  // a move has happened: lock seats until Reset

  // Build the per-segment hop list from the path (>=2 squares).  Each segment
  // slides the piece from one square to the next; a captured piece (if any on
  // that segment) is removed when the hop lands.
  const rcPath = msg.path.map(sqToRC);
  const capturedRC = msg.captured.map(sqToRC);

  // The moving piece's appearance during the slide: its side, and king state
  // only if it was already a king before this move (promotion shows on commit).
  const startCell = board[rcPath[0].row][rcPath[0].col];
  const movingPiece = startCell
    ? { side: startCell.side, king: startCell.king }
    : { side: msg.mover === 0 ? 'red' : 'black', king: false };

  // Captured pieces stay visible until the hop that jumps them lands; this set
  // accumulates the ones already removed (hidden) as the animation progresses.
  const removed = new Set();

  let seg = 0;
  function runSegment() {
    if (token !== playAnimToken) return;  // canceled by reset/stop
    const fromRC = rcPath[seg];
    const toRC = rcPath[seg + 1];
    const start = performance.now();
    // Read pacing live so a slider change mid-move applies to remaining hops.
    // "Move Speed" is the time per hop: a simple step is one hop, and a
    // multi-jump takes one hop per jump -- so its total time scales with the
    // number of jumps.
    const segDuration = moveSpeedSec() * 1000;

    function frame(now) {
      if (token !== playAnimToken) return;
      const t = Math.min(1, (now - start) / segDuration);
      drawBoard({
        fromRC, toRC, t, piece: movingPiece,
        captured: removed,   // pieces already jumped (hidden); others stay shown
        hideRC: rcPath[0],   // keep the origin empty throughout
      });
      if (t < 1) {
        requestAnimationFrame(frame);
      } else {
        // Landed: if this hop jumped a piece (the midpoint), remove it now.
        const midR = (fromRC.row + toRC.row) / 2;
        const midC = (fromRC.col + toRC.col) / 2;
        for (const cap of capturedRC) {
          if (cap.row === midR && cap.col === midC) removed.add(cap.row + ',' + cap.col);
        }
        seg++;
        if (seg < rcPath.length - 1) {
          runSegment();
        } else {
          finishMove();
        }
      }
    }
    requestAnimationFrame(frame);
  }

  function finishMove() {
    if (token !== playAnimToken) return;
    // Commit the authoritative post-move board (handles capture removal +
    // promotion), update bookkeeping, then pause before the next ply.
    syncBoardFromCells(msg.board);
    drawBoard();
    requestEval('move');  // refresh each EF's eval of the new position (+ delta flash)
    playNoProgress = (msg.captured.length > 0 || msg.promoted) ? 0 : playNoProgress + 1;
    playSideToMove = msg.side;
    playState = 'idle';

    // Terminal?
    if (msg.status === 1 || msg.status === 2 || msg.status === 3) {
      endGame(msg.status);
      return;
    }

    // Pause armed during this move/animation: halt here (eval already unlocked).
    if (playPaused) { setPlayButtons(); return; }

    const nextIsAgent = seats[sideToSeat(playSideToMove)] !== 'user';
    if (!nextIsAgent) {
      advanceTurn();  // human's turn: wait for a click
    } else if (playAutoRun) {
      // Continuous: play the next ply after a turn-gap.  Re-check on fire so a
      // Pause/Step/Reset during the gap takes effect.
      setTimeout(() => {
        if (token !== playAnimToken) return;
        if (playPaused || !playAutoRun) return;
        advanceTurn();
      }, turnGapSec() * 1000);
    } else {
      // Single-step (Step) done: pause here so the eval is editable before the
      // next step, and the button shows Resume.
      playPaused = true;
      setEvalPanelsEnabled(true);
      setPlayButtons();
    }
  }

  runSegment();
}

function endGame(status) {
  playState = 'over';
  playPaused = false;
  playAutoRun = false;
  setEvalPanelsEnabled(true);  // editable again once the game is over
  setPlayButtons();
  let text;
  if (status === 1) text = 'Red wins';
  else if (status === 2) text = 'Black wins';
  else text = 'Draw';
  setPlayStatus(text);
}

// ---- control handlers ----

// Play / Pause / Resume / Play Again, for both agent and human games.
function onPlayStart() {
  if (!playReady) return;
  if (playState === 'over') { onPlayReset(); return; }  // Play Again

  if (!playStarted) {
    // Begin a new game (continuous for agents; human-paced for human games).
    playStarted = true; playPaused = false; playAutoRun = true;
    setEvalPanelsEnabled(false);  // lock eval while playing
    setSeatLock(true);
    setPlayButtons();
    advanceTurn();
  } else if (playPaused) {
    resumePlay();
  } else {
    pausePlay();
  }
}

// Step one ply (agent-vs-agent only), then pause so the eval is editable.
function onPlayStep() {
  if (!playReady || !isAgentVsAgent() || playState === 'busy' || playState === 'over') return;
  if (playStarted && !playPaused) return;  // can't step while running
  playStarted = true; playPaused = false; playAutoRun = false;
  setEvalPanelsEnabled(false);
  setSeatLock(true);
  setPlayButtons();
  advanceTurn();
}

function onPlayReset() {
  if (!playReady) return;
  playAnimToken++;        // cancel any in-flight animation/pause
  playStarted = false; playPaused = false; playAutoRun = false;
  playState = 'busy';     // until reset_done
  awaitingHuman = false; legalMoves = []; selectedSq = -1;
  setPlayStatus('');
  playWorker.postMessage({ type: 'reset' });
}

// Small status line under the board (winner/draw).  Created lazily.
function setPlayStatus(text) {
  const el = document.getElementById('playStatus');
  if (el) el.textContent = text || '';
}
