// engine.cpp — Checkers test-game engine (single-threaded, WASM)
//
// Variant: American checkers / English draughts.
//   - 8x8 board, 12 pieces each, dark squares only (32 playable squares).
//   - Men move/capture diagonally forward only; kings one square any diagonal.
//   - Mandatory capture; multi-jumps must be completed.
//   - Non-flying kings.
//
// Players ("modes"):
//   0 = random legal move
//   1 = minimax (MINIMAX_DEPTH, alpha-beta), piece-ratio eval + move ordering
//
// Evaluation: (mine - theirs) / total, from the perspective of the side
// to move.  Terminal: side-to-move with no moves loses.
//
// Single entry point play_game() returns the result of one game.

#include <cstdint>
#include <cstring>
#include <vector>

#include <emscripten/emscripten.h>

// ---------------------------------------------------------------------------
// Board representation
// ---------------------------------------------------------------------------
//
// 32 playable squares, numbered 0..31, mapped to (row, col) on the 8x8 board.
// Playable squares are the dark squares: (row + col) is odd.
//
// We store the board as a flat array of 32 cells.  Each cell is one of:
enum Cell : uint8_t {
  EMPTY = 0,
  R_MAN = 1,   // Red man   (player 0's pieces, moving "up", toward row 0)
  R_KING = 2,
  B_MAN = 3,   // Black man (player 1's pieces, moving "down", toward row 7)
  B_KING = 4,
};

// Side identifiers.
enum Side : uint8_t { RED = 0, BLACK = 1 };

// Convert a square index (0..31) to row/col on the 8x8 grid.
// Squares are numbered left-to-right, top-to-bottom over the dark squares.
static inline void sq_to_rc(int sq, int& row, int& col) {
  row = sq / 4;
  int offset = (row % 2 == 0) ? 1 : 0;  // dark square column parity per row
  col = (sq % 4) * 2 + offset;
}

// Convert row/col back to a square index; returns -1 if off-board or a light square.
static inline int rc_to_sq(int row, int col) {
  if (row < 0 || row > 7 || col < 0 || col > 7) return -1;
  if (((row + col) & 1) == 0) return -1;  // light square, not playable
  int offset = (row % 2 == 0) ? 1 : 0;
  return row * 4 + (col - offset) / 2;
}

static inline bool is_red(Cell c)   { return c == R_MAN || c == R_KING; }
static inline bool is_black(Cell c) { return c == B_MAN || c == B_KING; }
static inline bool is_king(Cell c)  { return c == R_KING || c == B_KING; }
static inline bool owned_by(Cell c, Side s) {
  return s == RED ? is_red(c) : is_black(c);
}

struct Board {
  Cell cells[32];
};

static void init_board(Board& b) {
  for (int i = 0; i < 32; ++i) b.cells[i] = EMPTY;
  // Black occupies the top three rows (squares 0..11), moving down.
  for (int i = 0; i < 12; ++i) b.cells[i] = B_MAN;
  // Red occupies the bottom three rows (squares 20..31), moving up.
  for (int i = 20; i < 32; ++i) b.cells[i] = R_MAN;
}

// ---------------------------------------------------------------------------
// Move representation
// ---------------------------------------------------------------------------
//
// A move is a sequence of squares (the path), plus the list of captured
// squares (empty for a simple step).  Multi-jumps have multiple captures.

struct Move {
  // Path of squares visited, including the start.  e.g. {from, mid1, mid2}.
  std::vector<int> path;
  // Squares of captured pieces (jumped over).
  std::vector<int> captured;

  int from() const { return path.front(); }
  int to()   const { return path.back();  }
  bool is_jump() const { return !captured.empty(); }
};

// Diagonal directions as (drow, dcol).
static const int DR[4] = { -1, -1, +1, +1 };
static const int DC[4] = { -1, +1, -1, +1 };

// Can a piece of cell type `c` move in direction index `d`?
// Men move only "forward"; kings move any direction.
static inline bool dir_allowed(Cell c, int d) {
  if (is_king(c)) return true;
  if (is_red(c))  return DR[d] < 0;   // red moves up (toward row 0)
  return DR[d] > 0;                    // black moves down (toward row 7)
}

// ---------------------------------------------------------------------------
// Move generation
// ---------------------------------------------------------------------------
//
// Mandatory capture: if any jumps exist, only jumps are legal.
// Multi-jumps are generated recursively; a jump sequence must continue as
// long as further jumps are available from the landing square (with the
// piece type fixed at its pre-promotion type during the chain, per English
// draughts: a man that reaches the back rank ends its move).

// Recursively extend a jump from the current square with the working board.
static void extend_jumps(const Board& b, Side side, Cell piece,
                         std::vector<int>& path, std::vector<int>& captured,
                         std::vector<Move>& out) {
  int sq = path.back();
  int row, col;
  sq_to_rc(sq, row, col);

  bool extended = false;
  for (int d = 0; d < 4; ++d) {
    if (!dir_allowed(piece, d)) continue;
    int mr = row + DR[d], mc = col + DC[d];     // square jumped over
    int lr = row + 2 * DR[d], lc = col + 2 * DC[d];  // landing square
    int mid = rc_to_sq(mr, mc);
    int land = rc_to_sq(lr, lc);
    if (mid < 0 || land < 0) continue;
    if (b.cells[land] != EMPTY) continue;        // landing must be empty
    Cell midc = b.cells[mid];
    if (midc == EMPTY) continue;
    if (owned_by(midc, side)) continue;          // can't jump own piece
    // Can't jump a square already captured in this chain.
    bool already = false;
    for (int c2 : captured) if (c2 == mid) { already = true; break; }
    if (already) continue;

    // Apply the jump on a working copy and recurse.
    Board nb = b;
    nb.cells[land] = piece;
    nb.cells[sq] = EMPTY;
    nb.cells[mid] = EMPTY;
    path.push_back(land);
    captured.push_back(mid);
    extend_jumps(nb, side, piece, path, captured, out);
    path.pop_back();
    captured.pop_back();
    extended = true;
  }

  // If we couldn't extend further and we've captured at least once, this is
  // a complete jump move.
  if (!extended && !captured.empty()) {
    Move m;
    m.path = path;
    m.captured = captured;
    out.push_back(m);
  }
}

// Generate all legal moves for `side`.  Enforces mandatory capture.
static void generate_moves(const Board& b, Side side, std::vector<Move>& out) {
  out.clear();
  std::vector<Move> jumps;
  std::vector<Move> steps;

  for (int sq = 0; sq < 32; ++sq) {
    Cell c = b.cells[sq];
    if (c == EMPTY || !owned_by(c, side)) continue;
    int row, col;
    sq_to_rc(sq, row, col);

    // Jumps from this square.
    {
      std::vector<int> path = { sq };
      std::vector<int> captured;
      extend_jumps(b, side, c, path, captured, jumps);
    }

    // Simple steps from this square.
    for (int d = 0; d < 4; ++d) {
      if (!dir_allowed(c, d)) continue;
      int nr = row + DR[d], nc = col + DC[d];
      int dest = rc_to_sq(nr, nc);
      if (dest < 0) continue;
      if (b.cells[dest] != EMPTY) continue;
      Move m;
      m.path = { sq, dest };
      steps.push_back(m);
    }
  }

  if (!jumps.empty()) {
    out = std::move(jumps);   // mandatory capture
  } else {
    out = std::move(steps);
  }
}

// Apply a move to the board, handling promotion at the back rank.
static void apply_move(Board& b, Side side, const Move& m) {
  int from = m.from();
  int to = m.to();
  Cell piece = b.cells[from];
  b.cells[from] = EMPTY;
  for (int cap : m.captured) b.cells[cap] = EMPTY;

  // Promotion: a man reaching the far back rank becomes a king.
  int trow, tcol;
  sq_to_rc(to, trow, tcol);
  if (piece == R_MAN && trow == 0) piece = R_KING;
  else if (piece == B_MAN && trow == 7) piece = B_KING;

  b.cells[to] = piece;
}

// True if this move results in a promotion (used for the no-progress counter).
static bool move_promotes(const Board& b, const Move& m) {
  Cell piece = b.cells[m.from()];
  int trow, tcol;
  sq_to_rc(m.to(), trow, tcol);
  return (piece == R_MAN && trow == 0) || (piece == B_MAN && trow == 7);
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------
//
// A weighted sum of board features, scored from `side`'s perspective.  Each
// search uses its own player's weights throughout the tree.
//
// Feature conventions (per the UI):
//   Pieces   : ALL of a side's pieces (men + kings).
//   Kings    : a BONUS added on top for kings.
//   Vanguard : pieces on the opponent's half of the board (overlapping --
//              counted in addition to Pieces/Kings).
//   AtRisk   : distinct pieces the OTHER side could capture next move (union
//              over all multi-jump sequences).  "Player At Risk" = player
//              pieces the opponent can take; "Opponent At Risk" = opponent
//              pieces the player can take.
//   Mobility : sum over pieces of (usable directions / max directions) -- a
//              man's max is 2, a king's is 4; usable = can step or jump that way
//              (ignoring forced-capture).  0..12 scale, like the piece counts.
//   BackRow  : pieces on the side's own back row / kinging edge (0-4), guarding
//              the squares the opponent needs to promote.
// "player" features apply to `side`; "opponent" features to the other side.
struct Weights {
  double playerPieces, oppPieces;
  double playerKings,  oppKings;
  double playerVanguard, oppVanguard;
  double playerAtRisk,  oppAtRisk;
  double playerMobility, oppMobility;
  double playerBackRow, oppBackRow;
};

// Is square `sq` on `side`'s opponent's half (i.e., `side`'s vanguard region)?
// RED starts at the bottom (rows 4-7) and advances UP, so RED's vanguard is the
// top half (rows 0-3).  BLACK is the mirror: its vanguard is the bottom half.
static inline bool in_vanguard(int sq, Side side) {
  int row = sq / 4;  // 0..7
  return side == RED ? (row <= 3) : (row >= 4);
}

// Count the distinct pieces of `victim` that `attacker` could capture if it
// were `attacker`'s turn -- i.e., the union of all squares captured across every
// legal multi-jump sequence `attacker` has.  A piece reachable only via one
// specific multi-jump path still counts ("can be captured").  Returns the size
// of that union, used for the "at risk" eval features.
static int count_at_risk(const Board& b, Side attacker) {
  bool jumped[32] = { false };
  for (int sq = 0; sq < 32; ++sq) {
    Cell c = b.cells[sq];
    if (c == EMPTY || !owned_by(c, attacker)) continue;
    std::vector<Move> seqs;
    std::vector<int> path = { sq };
    std::vector<int> captured;
    extend_jumps(b, attacker, c, path, captured, seqs);
    for (const Move& m : seqs)
      for (int cap : m.captured) jumped[cap] = true;
  }
  int n = 0;
  for (int i = 0; i < 32; ++i) if (jumped[i]) ++n;
  return n;
}

// Count `side`'s pieces sitting on its own back row (kinging edge) -- the
// squares the opponent must reach to promote.  RED's back row is row 7 (its
// home/bottom edge); BLACK's is row 0.  Range 0-4 (four dark squares per row).
// Counts any piece (man or king) occupying those squares.
static int count_back_row(const Board& b, Side side) {
  int backRow = (side == RED) ? 7 : 0;
  int n = 0;
  for (int sq = backRow * 4; sq < backRow * 4 + 4; ++sq) {
    Cell c = b.cells[sq];
    if (c != EMPTY && owned_by(c, side)) ++n;
  }
  return n;
}

// Fractional mobility for `side`: the sum over its pieces of (usable directions
// / that piece's maximum directions).  A man's maximum is 2 (its two forward
// diagonals); a king's is 4 (all diagonals).  A direction is "usable" if the
// piece can step OR jump that way, IGNORING the mandatory-capture restriction
// (pseudo-legal).  Examples: a king that can reach 3 of its 4 diagonals scores
// 0.75; a man with both forward diagonals open scores 1.0.  Range 0..12 (12
// fully-mobile pieces), the same scale as the piece counts, but finer than a
// per-piece can-move flag -- a piece with only one escape counts less than a
// free one.  Edge pieces normalize against the theoretical max, so a man with
// one off-board forward diagonal tops out at 0.5 (a gentle "walls box you in").
static double count_mobility(const Board& b, Side side) {
  double total = 0.0;
  for (int sq = 0; sq < 32; ++sq) {
    Cell c = b.cells[sq];
    if (c == EMPTY || !owned_by(c, side)) continue;
    int row, col;
    sq_to_rc(sq, row, col);
    int usable = 0, maxDirs = 0;
    for (int d = 0; d < 4; ++d) {
      if (!dir_allowed(c, d)) continue;  // men: forward only -> 2 dirs; kings: 4
      ++maxDirs;
      // Simple step into an adjacent empty square.
      int dest = rc_to_sq(row + DR[d], col + DC[d]);
      if (dest >= 0 && b.cells[dest] == EMPTY) { ++usable; continue; }
      // Jump over an adjacent enemy into an empty landing square.
      int mid  = rc_to_sq(row + DR[d],     col + DC[d]);
      int land = rc_to_sq(row + 2 * DR[d], col + 2 * DC[d]);
      if (mid >= 0 && land >= 0 && b.cells[land] == EMPTY &&
          b.cells[mid] != EMPTY && !owned_by(b.cells[mid], side)) {
        ++usable;
      }
    }
    if (maxDirs > 0) total += (double)usable / maxDirs;
  }
  return total;
}

static double eval_weighted(const Board& b, Side side, const Weights& w) {
  Side other = (side == RED) ? BLACK : RED;
  int myPieces = 0, myKings = 0, myVan = 0;
  int opPieces = 0, opKings = 0, opVan = 0;

  for (int i = 0; i < 32; ++i) {
    Cell c = b.cells[i];
    if (c == EMPTY) continue;
    if (owned_by(c, side)) {
      ++myPieces;
      if (is_king(c)) ++myKings;
      if (in_vanguard(i, side)) ++myVan;
    } else {
      ++opPieces;
      if (is_king(c)) ++opKings;
      if (in_vanguard(i, other)) ++opVan;
    }
  }

  // At-risk and mobility: only compute when their weight is nonzero (these
  // scan moves, so skip the work when unused).
  int myAtRisk = 0, opAtRisk = 0;
  if (w.playerAtRisk != 0.0) myAtRisk = count_at_risk(b, other);  // opp can take mine
  if (w.oppAtRisk    != 0.0) opAtRisk = count_at_risk(b, side);   // I can take opp's

  double myMob = 0.0, opMob = 0.0;  // fractional mobility (0..12)
  if (w.playerMobility != 0.0) myMob = count_mobility(b, side);
  if (w.oppMobility    != 0.0) opMob = count_mobility(b, other);

  // Back-row guard is cheap (4 squares); compute only when weighted anyway.
  int myBack = 0, opBack = 0;
  if (w.playerBackRow != 0.0) myBack = count_back_row(b, side);
  if (w.oppBackRow    != 0.0) opBack = count_back_row(b, other);

  return w.playerPieces   * myPieces  + w.oppPieces   * opPieces
       + w.playerKings    * myKings   + w.oppKings    * opKings
       + w.playerVanguard * myVan     + w.oppVanguard * opVan
       + w.playerAtRisk   * myAtRisk  + w.oppAtRisk   * opAtRisk
       + w.playerMobility * myMob     + w.oppMobility * opMob
       + w.playerBackRow  * myBack    + w.oppBackRow  * opBack;
}

// ---------------------------------------------------------------------------
// Minimax with alpha-beta (negamax framing)
// ---------------------------------------------------------------------------
//
// Minimax assumes optimal play by both sides: the side to move picks the move
// that MAXIMIZES its outcome, assuming the opponent then replies to MINIMIZE it,
// alternating down to the depth limit.  Rather than write separate "max" and
// "min" routines, we use the NEGAMAX form: a position is always scored from the
// perspective of the side to move, and the opponent's best reply is simply the
// NEGATION of our own search one ply deeper (their gain is our loss).  So a
// single routine serves both players, and "minimize" becomes "negate and
// maximize" -- that is the meaning of the `-negamax(...)` at the recursive call.
//
// Alpha-beta pruning makes this exact search much cheaper without changing the
// result.  `alpha` is the best score the side to move has already guaranteed
// itself somewhere; `beta` is the best the OPPONENT (one level up) will allow.
// Once a move proves at least as good as `beta`, the opponent would never let us
// reach this position -- it already has a reply at least this good elsewhere --
// so we stop examining the remaining moves here (the "beta cutoff").
//
// Returns the value of the position from `side`'s perspective.  A side with no
// legal moves loses: value -WIN, more negative than any heuristic eval can be.

// A forced win/loss must outweigh any heuristic score, so WIN is set far above
// the largest magnitude eval_weighted can produce (a few hundred at most).  The
// running `best` is seeded at -WIN*2 -- below even a loss -- so the first real
// move always replaces it.
static const double WIN = 1e9;

// Quiescence search (captures-only) used at the depth limit so the static eval
// isn't applied in the middle of a capture exchange (the "horizon effect").
// `qbudget` is the number of extra plies allowed.  We extend only while the
// side to move has a capture available (mandatory capture => its legal moves
// are jumps); when no capture is available (quiet) or the budget is spent, we
// apply the static eval.  Alpha-beta still prunes.
//
// Unlike textbook quiescence, there is no "stand-pat" option (taking the static
// eval as a floor before trying captures): in checkers a capture is MANDATORY,
// so the side to move cannot decline to capture -- there is nothing to stand pat
// on.  When captures exist we must play one; when none exist we just evaluate.
static double quiesce(const Board& b, Side side, int qbudget,
                      double alpha, double beta, const Weights& w) {
  std::vector<Move> moves;
  generate_moves(b, side, moves);

  if (moves.empty()) {
    return -WIN;  // side to move has lost
  }
  // Quiet (no captures) or out of budget -> static eval.
  if (qbudget == 0 || !moves[0].is_jump()) {
    return eval_weighted(b, side, w);
  }

  // Extend through the capture moves only.
  Side other = (side == RED) ? BLACK : RED;
  double best = -WIN * 2;
  for (const Move& m : moves) {
    Board nb = b;
    apply_move(nb, side, m);
    double val = -quiesce(nb, other, qbudget - 1, -beta, -alpha, w);
    if (val > best) best = val;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

static double negamax(const Board& b, Side side, int depth,
                      double alpha, double beta, const Weights& w,
                      int qbudget) {
  std::vector<Move> moves;
  generate_moves(b, side, moves);

  if (moves.empty()) {
    return -WIN;  // side to move has lost
  }
  if (depth == 0) {
    return quiesce(b, side, qbudget, alpha, beta, w);
  }

  // Move ordering: search the most promising moves first.  Alpha-beta prunes
  // well only when good moves come early -- with ideal ordering the cost drops
  // from ~b^depth toward ~b^(depth/2), so the search reaches nearly twice as
  // deep for the same work.  Ordering never changes the RESULT, only the speed.
  // Each child is scored by the same weighted eval (from the mover's
  // perspective) and sorted best-first.
  std::vector<std::pair<double, int>> ordered;
  ordered.reserve(moves.size());
  std::vector<Board> childs(moves.size());
  for (size_t i = 0; i < moves.size(); ++i) {
    childs[i] = b;
    apply_move(childs[i], side, moves[i]);
    ordered.push_back({ eval_weighted(childs[i], side, w), (int)i });
  }
  // Sort descending by heuristic score.
  for (size_t i = 1; i < ordered.size(); ++i) {
    auto key = ordered[i];
    size_t j = i;
    while (j > 0 && ordered[j - 1].first < key.first) {
      ordered[j] = ordered[j - 1];
      --j;
    }
    ordered[j] = key;
  }

  Side other = (side == RED) ? BLACK : RED;
  double best = -WIN * 2;
  for (auto& pr : ordered) {
    int i = pr.second;
    // Negamax: the opponent's best reply, negated, is this move's value to us;
    // the window flips to (-beta, -alpha) because their bounds are ours mirrored.
    double val = -negamax(childs[i], other, depth - 1, -beta, -alpha, w, qbudget);
    if (val > best) best = val;
    if (best > alpha) alpha = best;          // raise our own guaranteed floor
    if (alpha >= beta) break;  // beta cutoff: the opponent won't allow this line
  }
  return best;
}

// ---------------------------------------------------------------------------
// Simple RNG (xorshift) so games are reproducible from a seed.
// ---------------------------------------------------------------------------
struct Rng {
  uint64_t s;
  Rng(uint64_t seed) : s(seed ? seed : 0x9E3779B97F4A7C15ULL) {}
  uint64_t next() {
    s ^= s << 13; s ^= s >> 7; s ^= s << 17;
    return s;
  }
  int below(int n) { return n > 0 ? (int)(next() % (uint64_t)n) : 0; }
};

// Pick a move for `side` according to `mode`.
//   mode 0: random legal move
//   mode 1: minimax at search depth `depth`, with `qbudget` quiescence plies
static int pick_move(const Board& b, Side side, int mode, int depth, int qbudget,
                     const Weights& w, const std::vector<Move>& moves,
                     Rng& rng) {
  if (moves.size() == 1) return 0;

  if (mode == 0) {
    return rng.below((int)moves.size());
  }

  // mode 1: minimax at the root, searching `depth` plies.
  const int DEPTH = depth;
  Side other = (side == RED) ? BLACK : RED;

  // Order root moves by the same weighted eval (see negamax for why ordering
  // speeds the search), but with a tie-shuffle described below.
  std::vector<std::pair<double, int>> ordered;
  std::vector<Board> childs(moves.size());
  for (size_t i = 0; i < moves.size(); ++i) {
    childs[i] = b;
    apply_move(childs[i], side, moves[i]);
    ordered.push_back({ eval_weighted(childs[i], side, w), (int)i });
  }
  // Randomize tie order: Fisher-Yates shuffle first, then a STABLE sort by eval
  // (the insertion sort below uses strict `<`, so it never reorders equal-eval
  // elements).  Net effect: moves are ranked best-eval-first as before, but
  // moves sharing the same EF value get a random relative order.  Because the
  // root keeps the first move achieving the best searched value, this breaks
  // deterministic ties (e.g. the king-shuffle 2-cycle in flat endgames) by
  // choosing randomly among genuinely co-equal moves.  Uses the seeded per-game
  // rng, so games stay reproducible.
  for (int i = (int)ordered.size() - 1; i > 0; --i) {
    int j = rng.below(i + 1);
    auto tmp = ordered[i]; ordered[i] = ordered[j]; ordered[j] = tmp;
  }
  for (size_t i = 1; i < ordered.size(); ++i) {
    auto key = ordered[i];
    size_t j = i;
    while (j > 0 && ordered[j - 1].first < key.first) {
      ordered[j] = ordered[j - 1];
      --j;
    }
    ordered[j] = key;
  }

  double alpha = -WIN * 2, beta = WIN * 2;
  double best = -WIN * 2;
  int bestIdx = ordered[0].second;
  for (auto& pr : ordered) {
    int i = pr.second;
    double val = -negamax(childs[i], other, DEPTH - 1, -beta, -alpha, w, qbudget);
    if (val > best) { best = val; bestIdx = i; }
    if (best > alpha) alpha = best;
    // No cutoff at root: we need the actual best move, not just a bound,
    // but since alpha only rises this still prunes correctly below.
  }
  return bestIdx;
}

// ---------------------------------------------------------------------------
// Game driver
// ---------------------------------------------------------------------------
//
// Result codes (from the caller's fixed seating perspective set by params):
//   0 = player 0 (RED seat) wins
//   1 = player 1 (BLACK seat) wins
//   2 = draw
//
// modeRed / modeBlack choose the controller for each seat.
// noProgressCap is the number of plies without a capture or promotion that
// forces a draw.

// Debug telemetry from the most recent run_game().  Lets the host inspect
// why a game ended without changing the main play_game() return contract.
//   g_term_reason: 0 = no legal moves (win/loss), 1 = no-progress draw,
//                  2 = ply-cap draw
//   g_plies:       number of plies played
//   g_red_count / g_black_count: final piece counts
static int g_term_reason = -1;
static int g_plies = 0;
static int g_red_count = 0;
static int g_black_count = 0;

// Per-seat move-time telemetry for the most recent game (minimax moves only;
// random rollout plies are excluded).  Totals in milliseconds and the count of
// timed moves, so the host can form a per-EF average move time.
static double g_red_move_ms = 0.0;
static double g_black_move_ms = 0.0;
static int g_red_move_n = 0;
static int g_black_move_n = 0;
// swapColors of the most recent play_game(), so the dbg accessors can report
// move-time telemetry by EF index rather than by board seat.
static int g_last_swap = 0;

static void count_pieces(const Board& b, int& red, int& black) {
  red = black = 0;
  for (int i = 0; i < 32; ++i) {
    Cell c = b.cells[i];
    if (is_red(c)) ++red; else if (is_black(c)) ++black;
  }
}

static int run_game(int modeRed, int modeBlack, int depthRed, int depthBlack,
                    int qRed, int qBlack,
                    const Weights& wRed, const Weights& wBlack,
                    uint64_t seed, int noProgressCap, int rollout) {
  Board b;
  init_board(b);
  Rng rng(seed);

  // Reset per-game move-time telemetry.
  g_red_move_ms = g_black_move_ms = 0.0;
  g_red_move_n = g_black_move_n = 0;

  Side side = RED;  // Red moves first in checkers.
  int noProgress = 0;

  // Random opening rollout: each side plays 1-2 random legal moves before its
  // evaluation function takes over.  This is essential when both players are
  // deterministic minimax -- without varied openings, every game would be an
  // identical replay.  The per-side budget is drawn from the seed, so games
  // remain reproducible while differing from one another.  When disabled, both
  // sides play their evaluation function from the opening position.
  int openingRed   = rollout ? (1 + rng.below(2)) : 0;
  int openingBlack = rollout ? (1 + rng.below(2)) : 0;

  // Hard ply cap as an absolute safety net (in addition to no-progress).
  const int MAX_PLIES = 2000;

  for (int ply = 0; ply < MAX_PLIES; ++ply) {
    std::vector<Move> moves;
    generate_moves(b, side, moves);
    if (moves.empty()) {
      // Side to move loses; the other side wins.
      g_term_reason = 0;
      g_plies = ply;
      count_pieces(b, g_red_count, g_black_count);
      return (side == RED) ? 1 : 0;
    }

    int mode  = (side == RED) ? modeRed  : modeBlack;
    int depth = (side == RED) ? depthRed : depthBlack;
    int qb    = (side == RED) ? qRed     : qBlack;
    const Weights& w = (side == RED) ? wRed : wBlack;

    // During its opening budget, the side plays a random legal move regardless
    // of its configured mode.
    int& opening = (side == RED) ? openingRed : openingBlack;
    if (opening > 0) {
      mode = 0;        // random
      --opening;
    }

    // Time minimax moves (mode 1) per seat; rollout/random moves are excluded.
    int idx;
    if (mode == 1) {
      double t0 = emscripten_get_now();
      idx = pick_move(b, side, mode, depth, qb, w, moves, rng);
      double dt = emscripten_get_now() - t0;
      if (side == RED) { g_red_move_ms += dt; ++g_red_move_n; }
      else             { g_black_move_ms += dt; ++g_black_move_n; }
    } else {
      idx = pick_move(b, side, mode, depth, qb, w, moves, rng);
    }
    const Move& m = moves[idx];

    bool progress = m.is_jump() || move_promotes(b, m);
    apply_move(b, side, m);
    noProgress = progress ? 0 : (noProgress + 1);

    if (noProgress >= noProgressCap) {
      g_term_reason = 1;
      g_plies = ply + 1;
      count_pieces(b, g_red_count, g_black_count);
      return 2;  // draw by no progress
    }

    side = (side == RED) ? BLACK : RED;
  }
  g_term_reason = 2;
  g_plies = MAX_PLIES;
  count_pieces(b, g_red_count, g_black_count);
  return 2;  // draw by ply cap (should be rare)
}

// ---------------------------------------------------------------------------
// Interactive game (Play tab) — a single persistent game stepped one move at a
// time.  Unlike play_game (which plays a whole game internally), this keeps the
// board in a global so the host can render each move and pace the game itself.
// The host drives it: ig_reset() to set the opening, then ig_pick(...) once per
// ply for whichever side is to move.  After each ig_pick the host reads the move
// that was played (to animate it) and the resulting board.
// ---------------------------------------------------------------------------

static Board g_ig_board;
static Side  g_ig_side = RED;
// Used only for random/tie cases.  Deliberately NOT reseeded in ig_reset(): the
// Play tab keeps one continuous RNG stream so successive games (and tie-broken
// agent moves) vary from one another, which is desirable for hands-on
// exploration.  This contrasts with the Test tab, where each game seeds its own
// Rng from its game index for reproducibility.
static Rng   g_ig_rng(0x12345678u);
static int   g_ig_status = 0;         // see ig_pick return codes

// The move just played by ig_pick, exposed square-by-square for animation.
// path[] is the ordered list of squares the piece visited (>=2 entries: from..to,
// with intermediate landings for multi-jumps).  captured[] are the jumped squares.
static int g_ig_path[16];
static int g_ig_path_n = 0;
static int g_ig_captured[16];
static int g_ig_captured_n = 0;
static int g_ig_mover_side = RED;     // side that made the move
static int g_ig_promoted = 0;         // 1 if the move ended in a promotion

// Legal moves for the side to move, enumerated by ig_gen() for the host (used
// for human input on the Play tab).  ig_apply(i) applies the i-th of these.
static std::vector<Move> g_ig_gen;

// After a move flips the side to move, decide a win immediately if the new side
// to move has no legal moves (annihilation or blockade).  Without this, that
// loss is only discovered on the NEXT ig_pick/ig_gen, so the result would lag a
// half-ply behind the deciding move on the Play tab.  No-op if the game already
// ended this ply (e.g. a no-progress draw was just set).
static void ig_detect_terminal() {
  if (g_ig_status != 0) return;
  std::vector<Move> moves;
  generate_moves(g_ig_board, g_ig_side, moves);
  if (moves.empty())
    g_ig_status = (g_ig_side == RED) ? 2 : 1;  // side to move can't move -> other wins
}

// Record the move just played into the g_ig_* accessor globals so the host can
// animate it: the path squares, the captured squares, and the promotion flag,
// with the buffer copies clamped to their 16-entry size.  Must be called BEFORE
// apply_move -- move_promotes inspects the moving piece on its origin square.
static void ig_record_move(const Move& m) {
  g_ig_mover_side = g_ig_side;
  g_ig_path_n = (int)m.path.size();
  if (g_ig_path_n > 16) g_ig_path_n = 16;
  for (int i = 0; i < g_ig_path_n; ++i) g_ig_path[i] = m.path[i];
  g_ig_captured_n = (int)m.captured.size();
  if (g_ig_captured_n > 16) g_ig_captured_n = 16;
  for (int i = 0; i < g_ig_captured_n; ++i) g_ig_captured[i] = m.captured[i];
  g_ig_promoted = move_promotes(g_ig_board, m) ? 1 : 0;
}

// ---------------------------------------------------------------------------

extern "C" {

// Reset the interactive board to the opening position, RED to move.
EMSCRIPTEN_KEEPALIVE
void ig_reset() {
  init_board(g_ig_board);
  g_ig_side = RED;
  g_ig_status = 0;
  g_ig_path_n = 0;
  g_ig_captured_n = 0;
  g_ig_promoted = 0;
  g_ig_gen.clear();
}

// Advance the game by one ply: pick a move for the side to move using the given
// controller settings, apply it, and flip the side.  Records the played move
// for the host to animate.  Returns a status code:
//   0 = ongoing (a move was played; more to come)
//   1 = RED wins   (the side now to move has no legal moves and it is BLACK)
//   2 = BLACK wins
//   3 = draw (no-progress cap reached)
//   4 = game already over (no move played)
// Move details are read via the ig_move_* / ig_board accessors after this call.
EMSCRIPTEN_KEEPALIVE
int ig_pick(int mode, int depth, int q,
            double wpp, double wop, double wpk, double wok,
            double wpv, double wov, double wpr, double wor,
            double wpm, double wom, double wpb, double wob,
            int noProgress, int noProgressCap) {
  if (g_ig_status != 0) return 4;  // already terminal

  Weights w = { wpp, wop, wpk, wok, wpv, wov, wpr, wor, wpm, wom, wpb, wob };

  std::vector<Move> moves;
  generate_moves(g_ig_board, g_ig_side, moves);
  if (moves.empty()) {
    // Side to move loses; the other side wins.
    g_ig_status = (g_ig_side == RED) ? 2 : 1;  // RED can't move -> BLACK wins
    g_ig_path_n = 0;
    g_ig_captured_n = 0;
    return g_ig_status;
  }

  int idx = pick_move(g_ig_board, g_ig_side, mode, depth, q, w, moves, g_ig_rng);
  const Move& m = moves[idx];

  ig_record_move(m);  // snapshot the move for the host to animate (before apply)

  bool progress = m.is_jump() || move_promotes(g_ig_board, m);
  apply_move(g_ig_board, g_ig_side, m);

  // No-progress draw: the host tracks the running counter and passes it in.
  int newNoProgress = progress ? 0 : (noProgress + 1);
  if (newNoProgress >= noProgressCap) {
    g_ig_status = 3;  // draw
  }

  g_ig_side = (g_ig_side == RED) ? BLACK : RED;
  ig_detect_terminal();  // does this move leave the opponent with no reply?
  return g_ig_status;  // 0 unless the no-progress cap or a win just triggered
}

// Board + move accessors for the host (read after ig_pick / ig_reset).
EMSCRIPTEN_KEEPALIVE int ig_cell(int sq) {
  return (sq >= 0 && sq < 32) ? (int)g_ig_board.cells[sq] : 0;
}
EMSCRIPTEN_KEEPALIVE int ig_side()       { return (int)g_ig_side; }       // side to move
EMSCRIPTEN_KEEPALIVE int ig_status()     { return g_ig_status; }
EMSCRIPTEN_KEEPALIVE int ig_mover()      { return g_ig_mover_side; }      // side that just moved
EMSCRIPTEN_KEEPALIVE int ig_promoted()   { return g_ig_promoted; }
EMSCRIPTEN_KEEPALIVE int ig_path_len()   { return g_ig_path_n; }
EMSCRIPTEN_KEEPALIVE int ig_path_sq(int i) {
  return (i >= 0 && i < g_ig_path_n) ? g_ig_path[i] : -1;
}
EMSCRIPTEN_KEEPALIVE int ig_cap_len()    { return g_ig_captured_n; }
EMSCRIPTEN_KEEPALIVE int ig_cap_sq(int i) {
  return (i >= 0 && i < g_ig_captured_n) ? g_ig_captured[i] : -1;
}

// Static evaluation of the CURRENT position from a side's perspective, using the
// given weights.  For the EF-value readout (the host can show each agent's
// estimate of who is ahead).  side: 0 = RED, 1 = BLACK.
EMSCRIPTEN_KEEPALIVE
double ig_eval(int side,
               double wpp, double wop, double wpk, double wok,
               double wpv, double wov, double wpr, double wor,
               double wpm, double wom, double wpb, double wob) {
  Weights w = { wpp, wop, wpk, wok, wpv, wov, wpr, wor, wpm, wom, wpb, wob };
  return eval_weighted(g_ig_board, (Side)(side ? BLACK : RED), w);
}

// ---- legal-move enumeration (for human input on the Play tab) ----
//
// ig_gen() generates the legal moves for the side to move and stores them for
// the host to read (accessors below) and for ig_apply(i).  Because this reuses
// the engine's generate_moves, the host gets correct mandatory-capture and
// multi-jump rules for free.  Returns the move count; if zero, the side to move
// has no legal moves and has lost (status set, like ig_pick's empty case).
EMSCRIPTEN_KEEPALIVE
int ig_gen() {
  g_ig_gen.clear();
  if (g_ig_status != 0) return 0;  // game already over
  generate_moves(g_ig_board, g_ig_side, g_ig_gen);
  if (g_ig_gen.empty()) {
    g_ig_status = (g_ig_side == RED) ? 2 : 1;  // can't move -> the other side wins
  }
  return (int)g_ig_gen.size();
}

EMSCRIPTEN_KEEPALIVE int ig_gen_count() { return (int)g_ig_gen.size(); }
EMSCRIPTEN_KEEPALIVE int ig_gen_from(int i) {
  return (i >= 0 && i < (int)g_ig_gen.size()) ? g_ig_gen[i].from() : -1;
}
EMSCRIPTEN_KEEPALIVE int ig_gen_to(int i) {
  return (i >= 0 && i < (int)g_ig_gen.size()) ? g_ig_gen[i].to() : -1;
}
EMSCRIPTEN_KEEPALIVE int ig_gen_path_len(int i) {
  return (i >= 0 && i < (int)g_ig_gen.size()) ? (int)g_ig_gen[i].path.size() : 0;
}
EMSCRIPTEN_KEEPALIVE int ig_gen_path_sq(int i, int j) {
  if (i < 0 || i >= (int)g_ig_gen.size()) return -1;
  const Move& m = g_ig_gen[i];
  return (j >= 0 && j < (int)m.path.size()) ? m.path[j] : -1;
}
EMSCRIPTEN_KEEPALIVE int ig_gen_cap_len(int i) {
  return (i >= 0 && i < (int)g_ig_gen.size()) ? (int)g_ig_gen[i].captured.size() : 0;
}
EMSCRIPTEN_KEEPALIVE int ig_gen_cap_sq(int i, int k) {
  if (i < 0 || i >= (int)g_ig_gen.size()) return -1;
  const Move& m = g_ig_gen[i];
  return (k >= 0 && k < (int)m.captured.size()) ? m.captured[k] : -1;
}

// Apply the i-th enumerated move (from the most recent ig_gen) as the side to
// move's move.  Records the played move like ig_pick and advances the side.
// Returns ig_pick's status codes.  noProgress/noProgressCap drive the draw rule.
EMSCRIPTEN_KEEPALIVE
int ig_apply(int i, int noProgress, int noProgressCap) {
  if (g_ig_status != 0) return 4;                     // already terminal
  if (i < 0 || i >= (int)g_ig_gen.size()) return 4;   // invalid index, no-op
  const Move& m = g_ig_gen[i];

  ig_record_move(m);  // snapshot the move for the host to animate (before apply)

  bool progress = m.is_jump() || move_promotes(g_ig_board, m);
  apply_move(g_ig_board, g_ig_side, m);

  int newNoProgress = progress ? 0 : (noProgress + 1);
  if (newNoProgress >= noProgressCap) g_ig_status = 3;  // draw

  g_ig_side = (g_ig_side == RED) ? BLACK : RED;
  g_ig_gen.clear();  // move list consumed
  ig_detect_terminal();  // does this move leave the opponent with no reply?
  return g_ig_status;
}

}  // extern "C"

// ---------------------------------------------------------------------------
// WASM entry point
// ---------------------------------------------------------------------------
//
// play_game(mode1, mode2, depth1, depth2, q1, q2, seed, swapColors,
//           noProgressCap, rollout, w1[8], w2[8])
//   mode1, mode2   : controller for evaluation function #1 and #2
//   depth1, depth2 : minimax search depth for #1 and #2 (ignored if random)
//   q1, q2         : quiescence plies for #1 / #2 (0 = off)
//   seed           : RNG seed for reproducibility
//   swapColors     : 0 -> EF1 plays RED, EF2 plays BLACK
//                    1 -> EF1 plays BLACK, EF2 plays RED  (color alternation)
//   noProgressCap  : plies without capture/promotion before a draw
//   rollout        : 1 -> 1-2 random opening plies per side; 0 -> none
//   w1*/w2*        : the twelve eval weights for EF1 / EF2, in slider order:
//                    playerPieces, oppPieces, playerKings, oppKings,
//                    playerVanguard, oppVanguard, playerAtRisk, oppAtRisk,
//                    playerMobility, oppMobility, playerBackRow, oppBackRow
//
// Returns, from EF1/EF2 perspective:
//   0 = EF1 wins, 1 = EF2 wins, 2 = draw
extern "C" {

EMSCRIPTEN_KEEPALIVE
int play_game(int mode1, int mode2, int depth1, int depth2, int q1, int q2,
              double seed, int swapColors, int noProgressCap, int rollout,
              double w1pp, double w1op, double w1pk, double w1ok,
              double w1pv, double w1ov, double w1pr, double w1or,
              double w1pm, double w1om, double w1pb, double w1ob,
              double w2pp, double w2op, double w2pk, double w2ok,
              double w2pv, double w2ov, double w2pr, double w2or,
              double w2pm, double w2om, double w2pb, double w2ob) {
  Weights w1 = { w1pp, w1op, w1pk, w1ok, w1pv, w1ov, w1pr, w1or, w1pm, w1om, w1pb, w1ob };
  Weights w2 = { w2pp, w2op, w2pk, w2ok, w2pv, w2ov, w2pr, w2or, w2pm, w2om, w2pb, w2ob };

  g_last_swap = swapColors;
  int modeRed, modeBlack, depthRed, depthBlack, qRed, qBlack;
  Weights wRed, wBlack;
  if (!swapColors) {
    modeRed = mode1; modeBlack = mode2;
    depthRed = depth1; depthBlack = depth2;
    qRed = q1; qBlack = q2;
    wRed = w1; wBlack = w2;
  } else {
    modeRed = mode2; modeBlack = mode1;
    depthRed = depth2; depthBlack = depth1;
    qRed = q2; qBlack = q1;
    wRed = w2; wBlack = w1;
  }

  int seatResult = run_game(modeRed, modeBlack, depthRed, depthBlack,
                            qRed, qBlack, wRed, wBlack, (uint64_t)seed,
                            noProgressCap, rollout);
  if (seatResult == 2) return 2;  // draw

  // seatResult: 0 = RED seat won, 1 = BLACK seat won.  Map back to EF index.
  bool redIsEF1 = !swapColors;
  bool redWon = (seatResult == 0);
  bool ef1Won = (redWon == redIsEF1);
  return ef1Won ? 0 : 1;
}

// Debug accessors for the most recent play_game() call.
EMSCRIPTEN_KEEPALIVE int dbg_term_reason() { return g_term_reason; }
EMSCRIPTEN_KEEPALIVE int dbg_plies()       { return g_plies; }
EMSCRIPTEN_KEEPALIVE int dbg_red_count()   { return g_red_count; }
EMSCRIPTEN_KEEPALIVE int dbg_black_count() { return g_black_count; }

// Move-time telemetry by EF index (accounts for the color swap).  EF1 played
// the RED seat when !g_last_swap, else the BLACK seat.
EMSCRIPTEN_KEEPALIVE double dbg_ef1_move_ms() { return g_last_swap ? g_black_move_ms : g_red_move_ms; }
EMSCRIPTEN_KEEPALIVE double dbg_ef2_move_ms() { return g_last_swap ? g_red_move_ms : g_black_move_ms; }
EMSCRIPTEN_KEEPALIVE int dbg_ef1_move_n()  { return g_last_swap ? g_black_move_n : g_red_move_n; }
EMSCRIPTEN_KEEPALIVE int dbg_ef2_move_n()  { return g_last_swap ? g_red_move_n : g_black_move_n; }

}  // extern "C"
