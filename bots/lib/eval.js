/*
 * Position evaluation shared by the bots: JieqiBots.lib.eval
 *
 *   const E = JieqiBots.lib.eval;
 *   const w = E.resolveWeights(ctx.params);        // default weights + overrides from params
 *   E.evaluate(state, J, 'r', w)                   // score from Red's point of view (positive = Red is better)
 *   E.explain(state, J, 'r', w)                    // { score, material, mobility, check, phase, pieces: [...] }
 *   E.pieceValue(state, J, square, w)              // value of one piece (hidden piece = expected value)
 *
 * Override weights via params (also in a bot spec): 'eval-1ply:R.endgame=11,mobility=0,P.crossed=2.5'
 */
JieqiBots.module(function (root) {
  'use strict';

  const DEFAULT_WEIGHTS = {
    // Pawn: own palace centre (blocks the King) / not crossed / crossed the river / bottomed out (opponent's last rank)
    P: { palaceCenter: -1, home: 1, crossed: 2, bottom: 0.5 },
    E: 1,                                              // Elephant
    A: { single: 2, paired: 3 },                       // Advisor; "paired" = 2 Advisors diagonally adjacent, protecting each other
    H: { opening: 3, middlegame: 4, endgame: 5 },      // Horse
    C: { opening: 5, middlegame: 4, endgame: 3 },      // Cannon
    R: { opening: 9.5, middlegame: 9, endgame: 10 },   // Rook
    // Game phase by the ratio of pieces left on the board / 32
    phase: { openingAbove: 0.9, middlegameAbove: 0.5 },
    hiddenBonus: 0,     // bonus per piece still hidden ("mystery" value), off by default
    development: 0,     // penalty for still-hidden pieces by reveal priority (lib/opening.js): pieces that should be revealed
                        // early (edge Pawns) are penalised most, a hidden Rook barely at all. 0 = off
    crossedAE: 0,       // bonus for a revealed Advisor/Elephant across the river ("Sĩ/Tượng chiến"). 0 = off
    hiddenTrapped: 0,   // penalty per own hidden piece that has moves but every target square is attacked by the
                        // opponent – it cannot be revealed safely ("bị cấm"; the opponent controls it). 0 = off
    horseReach: 0,      // score per square a revealed Horse can jump to in the opponent's half. Makes the bot
                        // block an enemy Horse's legs ("cản mã", e.g. push the Pawn in front of an edge Horse). 0 = off
    // King safety / cannon placement (step 8, user's experience; all 0 = off until arena-tested):
    horseCheckThreat: 0,    // per square from which an enemy revealed Horse could check our King next move, that we
                            // do not guard
    horseCheckCap: 2.5,     // at most this many squares counted per Horse
    cannonFacingKing: 0,    // enemy revealed Cannon on our King's file with exactly one piece between ("pháo đầu"),
                            // while our King is still on its starting square
    cannonEmptyFile: 0,     // "pháo trống": enemy revealed Cannon on our King's file with NOTHING between (worse than
                            // "pháo đầu": anything that steps in becomes its screen); defence = reveal Advisor/Elephant
                            // into the centre so that two pieces stand between
    centralCannon: 0,       // our revealed Cannon on the centre file (e) in the opening, while the opponent still has
                            // >= 2 hidden pieces on its Advisor/Elephant squares (it stops them revealing to the centre)
    bottomCannon: 0,        // "pháo giác": our revealed Cannon on the opponent's back rank, per enemy hidden piece on an
                            // Advisor/Elephant square that it stops from being revealed safely
    mobility: 0.02,     // score per legal move more than the opponent
    check: 0.3,         // score when giving check
    win: 1000,          // win score (checkmate / opponent has no moves)
  };

  const TOTAL_PIECES = 32;

  // ── Weights ────────────────────────────────────────────────────────────
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /** Merge DEFAULT_WEIGHTS with params.weights (object) and keys like 'R.endgame' / 'mobility' in params. */
  function resolveWeights(params = {}) {
    const w = clone(DEFAULT_WEIGHTS);
    const apply = (path, value) => {
      const keys = path.split('.');
      let o = w;
      for (let i = 0; i < keys.length - 1; i++) {
        if (typeof o[keys[i]] !== 'object') return false;
        o = o[keys[i]];
      }
      if (!(keys[keys.length - 1] in o)) return false;
      o[keys[keys.length - 1]] = value;
      return true;
    };
    const walk = (obj, prefix) => {
      for (const [k, v] of Object.entries(obj || {})) {
        if (v && typeof v === 'object') walk(v, prefix + k + '.');
        else apply(prefix + k, v);
      }
    };
    walk(params.weights, '');
    for (const [k, v] of Object.entries(params)) if (k !== 'weights') apply(k, v);
    return w;
  }

  // ── Game phase ─────────────────────────────────────────────────────────
  function piecesOnBoard(state) {
    let n = 0;
    for (const p of state.board) if (p) n++;
    return n;
  }

  /** 'opening' | 'middlegame' | 'endgame' */
  function gamePhase(state, w = DEFAULT_WEIGHTS) {
    const ratio = piecesOnBoard(state) / TOTAL_PIECES;
    if (ratio > w.phase.openingAbove) return 'opening';
    if (ratio > w.phase.middlegameAbove) return 'middlegame';
    return 'endgame';
  }

  // ── Piece values ───────────────────────────────────────────────────────
  const isPalaceCenter = (side, x, y) => x === 4 && y === (side === 'r' ? 8 : 1);
  const crossedRiver = (side, y) => (side === 'r' ? y <= 4 : y >= 5);
  const atBottom = (side, y) => (side === 'r' ? y === 0 : y === 9);

  /** A (revealed) Advisor of `side` diagonally adjacent to `sq` – excluding `sq` itself. */
  function hasPairedAdvisor(state, J, sq, side) {
    const x = J.X(sq), y = J.Y(sq);
    for (const [dx, dy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || nx > 8 || ny < 0 || ny > 9) continue;
      const q = state.board[J.idx(nx, ny)];
      if (q && q.side === side && !q.hidden && q.type === 'A') return true;
    }
    return false;
  }

  /** Value of a (revealed) piece of type `type` standing on square `sq`. */
  function typeValueAt(state, J, type, side, sq, phase, w) {
    const x = J.X(sq), y = J.Y(sq);
    switch (type) {
      case 'K': return 0; // the King is not part of material; losing it = loss (handled separately)
      case 'P':
        if (isPalaceCenter(side, x, y)) return w.P.palaceCenter;
        if (atBottom(side, y)) return w.P.bottom;
        return crossedRiver(side, y) ? w.P.crossed : w.P.home;
      case 'E': return w.E + (w.crossedAE && crossedRiver(side, y) ? w.crossedAE : 0);
      case 'A': return (hasPairedAdvisor(state, J, sq, side) ? w.A.paired : w.A.single)
        + (w.crossedAE && crossedRiver(side, y) ? w.crossedAE : 0);
      case 'H': return w.H[phase];
      case 'C': return w.C[phase];
      case 'R': return w.R[phase];
    }
    return 0;
  }

  /** Value of the piece on `sq`. Hidden piece = average over reveal probabilities (+ hiddenBonus). */
  function pieceValue(state, J, sq, w = DEFAULT_WEIGHTS, phase = gamePhase(state, w)) {
    const p = state.board[sq];
    if (!p) return 0;
    if (!p.hidden) return typeValueAt(state, J, p.type, p.side, sq, phase, w);
    // Note: a hidden piece revealed as an Advisor counts as a single Advisor (pairing unknown)
    let ev = 0;
    for (const [t, prob] of Object.entries(J.revealProbabilities(state, p.side))) {
      ev += prob * (t === 'A' ? w.A.single : typeValueAt(state, J, t, p.side, sq, phase, w));
    }
    return ev + w.hiddenBonus - developmentPenalty(p, J.X(sq), w);
  }

  /** Penalty for a still-hidden piece by reveal rank: rank 1 (edge Pawn) gets the full `development`, rank 9 (Rook) none. */
  function developmentPenalty(p, x, w) {
    if (!w.development) return 0;
    const op = root.JieqiBots.lib.opening;
    return op ? (w.development * (9 - op.hiddenRank(p, x))) / 8 : 0;
  }

  /** Total material of `side`. */
  function material(state, J, side, w = DEFAULT_WEIGHTS, phase = gamePhase(state, w)) {
    let sum = 0;
    for (let i = 0; i < state.board.length; i++) {
      const p = state.board[i];
      if (p && p.side === side) sum += pieceValue(state, J, i, w, phase);
    }
    return sum;
  }

  // ── Full evaluation ────────────────────────────────────────────────────
  function mobilityCount(state, J, side) {
    return J.countPseudoMoves(state, side);
  }

  /** Hidden pieces of `side` that have moves, but every target square is attacked by the opponent ("bị cấm"). */
  const trappedHidden = (state, J, side) => J.countTrappedHidden(state, side);
  const controlScore = (state, J, side, w) => (w.hiddenTrapped
    ? w.hiddenTrapped * (trappedHidden(state, J, J.opp(side)) - trappedHidden(state, J, side)) : 0);

  /** Squares in the opponent's half that the revealed Horses of `side` can jump to (legs not blocked). */
  function horseReach(state, J, side) {
    const board = state.board;
    let n = 0;
    for (let i = 0; i < board.length; i++) {
      const p = board[i];
      if (!p || p.hidden || p.side !== side || p.type !== 'H') continue;
      for (const t of J.pseudoTargets(board, i)) if (crossedRiver(side, J.Y(t))) n++;
    }
    return n;
  }
  // ── King safety and cannon placement (step 8) ──────────────────────────
  const HORSE_JUMPS = [[1, 2], [-1, 2], [1, -2], [-1, -2], [2, 1], [-2, 1], [2, -1], [-2, -1]];
  /** Does a Horse standing on `from` attack square `to` (leg free)? */
  function horseHits(board, J, from, to) {
    const dx = J.X(to) - J.X(from), dy = J.Y(to) - J.Y(from);
    if (!((Math.abs(dx) === 1 && Math.abs(dy) === 2) || (Math.abs(dx) === 2 && Math.abs(dy) === 1))) return false;
    const lx = J.X(from) + (Math.abs(dx) === 2 ? Math.sign(dx) : 0), ly = J.Y(from) + (Math.abs(dy) === 2 ? Math.sign(dy) : 0);
    return !board[J.idx(lx, ly)];
  }

  /** Squares an enemy Horse can jump to next move and check `side`'s King from, not guarded by `side`. */
  function horseCheckThreats(state, J, side, w, k = J.kingSquare(state.board, side), horses = null) {
    const board = state.board;
    if (k < 0) return 0;
    const kx = J.X(k), ky = J.Y(k);
    let total = 0;
    const n90 = horses ? horses.length : 90;
    for (let hi = 0; hi < n90; hi++) {
      const i = horses ? horses[hi] : hi;                       // horses: precomputed squares of the enemy Horses
      const h = board[i];
      if (!h || h.hidden || h.side === side || h.type !== 'H') continue;
      const hx = J.X(i), hy = J.Y(i);
      if (Math.abs(hx - kx) > 4 || Math.abs(hy - ky) > 4) continue;   // too far to check next move
      let n = 0;
      // the checking squares around the King that this Horse can jump to (quietly) next move
      for (const [dx, dy] of HORSE_JUMPS) {
        const cx = kx - dx, cy = ky - dy;
        if (cx < 0 || cx > 8 || cy < 0 || cy > 9) continue;
        const c = J.idx(cx, cy);
        if (board[c] || !horseHits(board, J, i, c)) continue;
        board[c] = h; board[i] = null;                          // try the jump in place
        const ok = horseHits(board, J, c, k) && !J.isSquareAttacked(board, c, side);
        board[i] = h; board[c] = null;
        if (ok) n++;
      }
      total += Math.min(n, w.horseCheckCap);
    }
    return total;
  }

  /** Reference version (pseudoTargets + board copies) – kept for cross-checking in tests. */
  function horseCheckThreatsSlow(state, J, side, w) {
    const board = state.board, k = J.kingSquare(board, side);
    if (k < 0) return 0;
    let total = 0;
    for (let i = 0; i < 90; i++) {
      const h = board[i];
      if (!h || h.hidden || h.side === side || h.type !== 'H') continue;
      let n = 0;
      for (const t of J.pseudoTargets(board, i)) {
        if (t === k || board[t]) continue;
        let checks = false;
        for (const [dx, dy] of HORSE_JUMPS) if (J.X(t) + dx === J.X(k) && J.Y(t) + dy === J.Y(k)) { checks = true; break; }
        if (!checks) continue;
        const b2 = board.slice(); b2[t] = h; b2[i] = null;
        if (horseHits(b2, J, t, k) && !J.isSquareAttacked(b2, t, side)) n++;
      }
      total += Math.min(n, w.horseCheckCap);
    }
    return total;
  }

  const backRank = (side) => (side === 'r' ? 9 : 0);
  /** Hidden pieces of `side` still on its Advisor/Elephant starting squares (c, d, f, g of its back rank). */
  function hiddenAESquares(board, J, side) {
    let n = 0;
    for (const x of [2, 3, 5, 6]) { const p = board[J.idx(x, backRank(side))]; if (p && p.hidden && p.side === side) n++; }
    return n;
  }

  /**
   * Enemy revealed Cannon on `side`'s King file, looking from the King towards the opponent:
   * 1 if it has exactly one piece between ("pháo đầu", only while the King is on its start square), else 0.
   */
  function cannonsFacingKing(state, J, side, k = J.kingSquare(state.board, side)) {
    if (k !== J.idx(4, backRank(side))) return 0;
    return cannonOnKingFile(state, J, side, k) === 1 ? 1 : 0;
  }

  /** "Pháo trống": 1 if an enemy revealed Cannon is on `side`'s King file with nothing between (any King square). */
  function cannonsEmptyFile(state, J, side, k = J.kingSquare(state.board, side)) {
    return k >= 0 && cannonOnKingFile(state, J, side, k) === 0 ? 1 : 0;
  }

  /** Pieces between `side`'s King and the nearest enemy revealed Cannon on its file towards the opponent (0/1), or -1. */
  function cannonOnKingFile(state, J, side, k) {
    const board = state.board, x = J.X(k), dir = side === 'r' ? -1 : 1;
    let between = 0;
    for (let y = J.Y(k) + dir; y >= 0 && y < 10; y += dir) {
      const p = board[J.idx(x, y)];
      if (!p) continue;
      if (p.side !== side && !p.hidden && p.type === 'C') return between;
      between++;
      if (between > 1) return -1;
    }
    return -1;
  }

  /** `side`'s revealed Cannons on the centre file in the opening, while the opponent has hidden A/E-square pieces. */
  function centralCannons(state, J, side, phase) {
    if (phase !== 'opening' || hiddenAESquares(state.board, J, J.opp(side)) < 2) return 0;
    let n = 0;
    for (let y = 0; y < 10; y++) { const p = state.board[J.idx(4, y)]; if (p && p.side === side && !p.hidden && p.type === 'C') n++; }
    return n;
  }

  /**
   * "Pháo giác": `side`'s revealed Cannons on the opponent's back rank; counts the opponent's hidden pieces on
   * Advisor/Elephant squares that cannot be revealed safely because of that Cannon (they could without it): every
   * reveal either lands on an attacked square or is illegal (it would uncover a Cannon check on its own King).
   */
  function bottomCannonControl(state, J, side) {
    const board = state.board, enemy = J.opp(side), y = backRank(enemy);
    let n = 0;
    for (let x = 0; x < 9; x++) {
      const c = board[J.idx(x, y)];
      if (!c || c.side !== side || c.hidden || c.type !== 'C') continue;
      const without = board.slice(); without[J.idx(x, y)] = null;
      for (const ax of [2, 3, 5, 6]) {
        const sq = J.idx(ax, y), p = board[sq];
        if (!p || !p.hidden || p.side !== enemy) continue;
        // can it be revealed safely: a legal move (no discovered check on its own King) to an unattacked square
        const safe = (b) => J.getLegalMoves({ board: b, turn: enemy, pools: state.pools }, { ignoreRepetition: true })
          .some((m) => m.from === sq && !b[m.to] && (() => { const b2 = b.slice(); b2[m.to] = p; b2[sq] = null; return !J.isSquareAttacked(b2, m.to, side); })());
        if (!safe(board) && safe(without)) n++;
      }
    }
    return n;
  }

  /** King safety + cannon placement from `side`'s point of view (0 when all four weights are 0). */
  /** pre (optional, from evaluate's board loop): { kR, kB, hR: [squares of red Horses], hB } */
  function kingSafetyScore(state, J, side, w, phase, pre = null) {
    let s = 0;
    const opp = J.opp(side);
    const kS = pre ? (side === 'r' ? pre.kR : pre.kB) : J.kingSquare(state.board, side);
    const kO = pre ? (side === 'r' ? pre.kB : pre.kR) : J.kingSquare(state.board, opp);
    const hS = pre ? (side === 'r' ? pre.hR : pre.hB) : null, hO = pre ? (side === 'r' ? pre.hB : pre.hR) : null;
    if (w.horseCheckThreat) s += w.horseCheckThreat * (horseCheckThreats(state, J, opp, w, kO, hS) - horseCheckThreats(state, J, side, w, kS, hO));
    if (w.cannonFacingKing) s += w.cannonFacingKing * (cannonsFacingKing(state, J, opp, kO) - cannonsFacingKing(state, J, side, kS));
    if (w.cannonEmptyFile) s += w.cannonEmptyFile * (cannonsEmptyFile(state, J, opp, kO) - cannonsEmptyFile(state, J, side, kS));
    if (w.centralCannon) s += w.centralCannon * (centralCannons(state, J, side, phase) - centralCannons(state, J, opp, phase));
    if (w.bottomCannon) s += w.bottomCannon * (bottomCannonControl(state, J, side) - bottomCannonControl(state, J, opp));
    return s;
  }

  const horseScore = (state, J, side, w) => (w.horseReach
    ? w.horseReach * (horseReach(state, J, side) - horseReach(state, J, J.opp(side))) : 0);

  /**
   * Detailed breakdown from `side`'s point of view.
   * If the game is over (state.result), returns ±win (draw = 0).
   */
  function explain(state, J, side, w = DEFAULT_WEIGHTS) {
    const opp = J.opp(side);
    const phase = gamePhase(state, w);
    if (state.result) {
      const score = state.result.winner == null ? 0 : state.result.winner === side ? w.win : -w.win;
      return { score, terminal: true, phase, material: 0, mobility: 0, check: 0, pieces: [] };
    }
    const pieces = [];
    let mat = 0;
    for (let i = 0; i < state.board.length; i++) {
      const p = state.board[i];
      if (!p || p.type === 'K') continue;
      const v = pieceValue(state, J, i, w, phase);
      mat += p.side === side ? v : -v;
      pieces.push({ square: i, side: p.side, type: p.hidden ? null : p.type, hidden: p.hidden, value: +v.toFixed(2) });
    }
    const mob = w.mobility ? w.mobility * (mobilityCount(state, J, side) - mobilityCount(state, J, opp)) : 0;
    let chk = 0;
    if (w.check && J.isInCheck(state, opp)) chk += w.check;
    if (w.check && J.isInCheck(state, side)) chk -= w.check;
    const ctl = controlScore(state, J, side, w) + horseScore(state, J, side, w) + kingSafetyScore(state, J, side, w, phase);
    const score = mat + mob + chk + ctl;
    return { score, terminal: false, phase, material: mat, mobility: mob, check: chk, control: ctl, pieces };
  }

  // ── Fast version for search (same result as explain, without building the piece list) ──
  /** Value of a hidden piece of `side` = base + pawnProb * (Pawn value on that square). */
  function hiddenStats(state, J, side, phase, w) {
    const probs = J.revealProbabilities(state, side);
    let base = w.hiddenBonus, pawnProb = 0;
    for (const t in probs) {
      if (t === 'P') pawnProb = probs[t];
      else base += probs[t] * (t === 'A' ? w.A.single : t === 'E' ? w.E : w[t][phase]);
    }
    return { base, pawnProb };
  }

  const SCAN = {};
  const PRE = { kR: -1, kB: -1, hR: [], hB: [] };
  /** Score from `side`'s point of view (positive = `side` is better). */
  function evaluate(state, J, side, w = DEFAULT_WEIGHTS) {
    if (state.result) return state.result.winner == null ? 0 : state.result.winner === side ? w.win : -w.win;
    const phase = gamePhase(state, w);
    const hs = { r: null, b: null };
    let mat = 0;
    const board = state.board;
    const pre = PRE; pre.kR = -1; pre.kB = -1; pre.hR.length = 0; pre.hB.length = 0;
    for (let i = 0; i < board.length; i++) {
      const p = board[i];
      if (!p) continue;
      if (p.type === 'K') { if (p.side === 'r') pre.kR = i; else pre.kB = i; continue; }
      if (p.type === 'H') (p.side === 'r' ? pre.hR : pre.hB).push(i);
      let v;
      if (p.hidden) {
        const h = hs[p.side] || (hs[p.side] = hiddenStats(state, J, p.side, phase, w));
        v = h.base + (h.pawnProb ? h.pawnProb * typeValueAt(state, J, 'P', p.side, i, phase, w) : 0)
          - (w.development ? developmentPenalty(p, i % 9, w) : 0);
      } else {
        v = typeValueAt(state, J, p.type, p.side, i, phase, w);
      }
      mat += p.side === side ? v : -v;
    }
    const opp = J.opp(side);
    let score = mat;
    if (J.scanPosition && (w.mobility || w.check || w.hiddenTrapped)) {
      // one pass: mobility, check and trapped hidden pieces for both sides (same numbers as the calls below)
      const sc = J.scanPosition(state, SCAN);
      const red = side === 'r';
      if (w.mobility) score += w.mobility * (red ? sc.mobR - sc.mobB : sc.mobB - sc.mobR);
      if (w.check) {
        if (red ? sc.checkB : sc.checkR) score += w.check;
        if (red ? sc.checkR : sc.checkB) score -= w.check;
      }
      if (w.hiddenTrapped) score += w.hiddenTrapped * (red ? sc.trapB - sc.trapR : sc.trapR - sc.trapB);
    } else {
      if (w.mobility) score += w.mobility * (mobilityCount(state, J, side) - mobilityCount(state, J, opp));
      if (w.check) {
        if (J.isInCheck(state, opp)) score += w.check;
        if (J.isInCheck(state, side)) score -= w.check;
      }
      if (w.hiddenTrapped) score += controlScore(state, J, side, w);
    }
    if (w.horseReach) score += horseScore(state, J, side, w);
    if (w.horseCheckThreat || w.cannonFacingKing || w.cannonEmptyFile || w.centralCannon || w.bottomCannon) {
      score += kingSafetyScore(state, J, side, w, phase, pre);
    }
    return score;
  }

  const lib = (root.JieqiBots.lib = root.JieqiBots.lib || {});
  lib.eval = {
    DEFAULT_WEIGHTS, resolveWeights, gamePhase, piecesOnBoard,
    typeValueAt, pieceValue, material, evaluate, explain, trappedHidden, horseReach,
    horseCheckThreats, horseCheckThreatsSlow, cannonsFacingKing, cannonsEmptyFile, centralCannons, bottomCannonControl,
  };
});
