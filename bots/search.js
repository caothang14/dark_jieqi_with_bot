/*
 * Search bot: alpha-beta (negamax) + chance nodes for reveals (expectimax, Star1-style pruning)
 * + quiescence (keeps searching captures) + time-based iterative deepening.
 *
 * Params (overridable via the spec, e.g. 'search:depth=3' or 'search:maxTimeMs=500,R.endgame=11'):
 *   depth        >0: search exactly this depth (reproducible, machine-independent); 0: time-based
 *   maxDepth     maximum depth for time-based search
 *   maxTimeMs    time cap per move (ms)
 *   timeScale    multiplier on the suggested time
 *   phaseTime    time multiplier per game phase { opening, middlegame, endgame }
 *   qDepth       maximum quiescence depth in plies
 *   qHiddenPly   hidden pieces may capture in quiescence only at plies < this value
 *   qCheckPly    consider all check evasions in quiescence at plies < this value
 *   deltaMargin  delta-pruning margin in quiescence
 *   chanceBound  score bound at chance nodes (child scores are clamped to [-b, b])
 *   probe        probe first at chance nodes (Star2) – turn off to compare
 *   tt, ttSize   transposition table (on/off, max entries)
 *   qRevealUnknown in quiescence a hidden piece that captures stays hidden (expected value) instead of branching
 *                into every identity – approximation, much smaller trees in the opening
 *   ttKeep       keep the transposition table from one move to the next (same params) instead of starting empty
 *   nullMove, nullR, nullMinDepth   null-move pruning (let the opponent move twice)
 *   lmr, lmrMinDepth, lmrAfter      late move reduction: search later quiet moves 1 ply shallower
 *   pvs          search moves after the first with a null window (Principal Variation Search)
 *   repetition   understand the Chinese repetition rules (avoid perpetual check/chase when we are the violator)
 *   openingOrder order reveal moves by the priority table (lib/opening.js)
 *   revealTopK   >0: below the root only consider the top K reveal moves by priority (captures are always all considered)
 *   revealTopKRoot >0: at the root only consider the top K reveal moves by priority
 *   revealSkipRoles  e.g. 'RC': below the root never reveal (without capturing) a hidden piece standing on a Rook/Cannon
 *                square, unless it is attacked or we are in check – those stay hidden for defence ('' = off)
 *   revealTopKDeveloped >0: below the root, once the side to move has >= developedCount revealed Rooks/Cannons/
 *                Horses, consider at most this many reveal moves (instead of revealTopK)
 *   keepThreatened  a hidden piece attacked and not defended is "in danger": at the root no reveal move is pruned
 *                (the way out may be a low-priority reveal: moving it, blocking, freeing a square for it), below the
 *                root the piece's own moves are never pruned – only while the side still has at least
 *                keepThreatenedMinBig (3) Rooks/Cannons/Horses hidden in its pool (default on, step 7)
 *   cannonRaidMalus, hiddenRookCaptureMalus   root-only penalties (in Pawns) for moves experts avoid: a hidden
 *                Cannon capturing a hidden piece before we have a revealed Rook; a hidden Rook capturing anything but
 *                a revealed Rook/Cannon/Horse. See styleMalus(). 0 = off
 *   developFirstMalus, developFirstQuietMalus   root-only: when the opponent has a revealed Rook and we have no
 *                revealed Rook/Cannon/Horse, penalise moves of revealed pieces (capturing a hidden piece / other
 *                moves) so the bot reveals pieces first. 0 = off
 *   guardRookBonus root-only bonus for a quiet reveal that blocks a revealed enemy Cannon attacking our hidden Rook
 *   horseBlockBonus root-only bonus for revealing a hidden Pawn so that it blocks a leg of a revealed enemy Horse
 *                that could jump into our half ("cản mã")
 *   cannonRaidMalus applies unless we have a revealed Rook AND the opponent's hidden R/C/H are worth more than ours;
 *                when the Cannon is attacked and undefended it is multiplied by cannonRaidChasedFactor (0.5) if the
 *                Cannon also has a safe quiet move, else 0
 *   releaseControlMalus root-only penalty for pushing our revealed edge Pawn (a / i) from our river bank into the
 *                mouth of the enemy's hidden edge Pawn opposite – that Pawn is already held, reveal a piece instead
 *   cannonLeapMalus root-only, opening only: penalty × P(weak piece: A/E/P) for a hidden Cannon leaping into the
 *                opponent's half
 *   strengthGap  step 12 (user's experience): compare the revealed strength of both sides (Rook 9, Cannon 4.5,
 *                Horse 4, crossed Pawn 1) at the root, opening + middlegame only. D <= -gap: "behind", D >= gap:
 *                "ahead", otherwise "equal". 0 = rules 1–4 off. See balanceAdj().
 *   pawnRowRevealBonus  (behind / equal) root bonus for safely revealing a hidden piece on our Pawn row
 *   behindQuietMalus, behindCaptureMalus  (behind) root penalty for quiet moves of revealed pieces / revealed
 *                pieces capturing a Pawn or a hidden piece – reveal more pieces instead
 *   behindNoRootPrune  (behind) no root reveal pruning: back-rank reveals are considered too
 *   aheadRevealMalus  (ahead) root penalty for a quiet reveal of a piece off the Pawn row – play the revealed pieces
 *   controlBonus, controlEqualFactor  (ahead; equal × factor) root bonus per enemy hidden piece newly kept from
 *                revealing safely (J.countTrappedHidden definition), penalty per one released
 *   palaceGuardBonus  root bonus for a quiet reveal that removes a revealed enemy Rook's direct attack on our hidden
 *                piece on a back-rank Advisor square next to our King ("lên Sĩ khi Xe địch nhắm vào Cung")
 *   pawnOrder    reveal order of hidden Pawns: 'edge' (edge files first) or 'c37' (files 3/7 first)
 *   debug        true: no alpha narrowing at the root and info.root = [{ from, to, score, pen }] for every root move
 *   randomness   >0: weaker, more human play for the difficulty levels: every root move gets an exact score
 *                (no alpha narrowing at the root) and the move is picked at random among those at most
 *                `randomness` worse than the best (closer to the best = more likely). 0 = always the best move
 *   development  (evaluation weight) reward revealing in priority order
 *   + every evaluation weight (bots/lib/eval.js): 'R.endgame', 'mobility', ...
 */
JieqiBots.module(function (root) {
  'use strict';
  const Bots = root.JieqiBots;
  const E = Bots.lib.eval;

  const INF = 1e9;
  const TIMEOUT = { timeout: true };
  const ORDER_VALUE = { K: 0, R: 9, C: 4.5, H: 4, A: 2, E: 1, P: 1 };
  const HIDDEN_ORDER_VALUE = 3;

  /**
   * Outcomes of a move, by decreasing probability. Only split on what OUR piece is revealed as (since that decides
   * how it moves afterwards). Capturing a hidden piece does not split: the board after the capture is the same for
   * every identity, and leaving the pool unchanged gives exactly the expected probabilities (captureUnknown).
   */
  function outcomes(state, J, m, unknownReveal = false) {
    const mover = state.board[m.from];
    const target = state.board[m.to];
    const cap = target && target.hidden ? { captureUnknown: true } : null;
    if (!mover.hidden) return [{ prob: 1, opts: cap }];
    // approximation (quiescence): the capturing hidden piece stays hidden – one branch instead of up to 6
    if (unknownReveal) return [{ prob: 1, opts: { ...cap, revealUnknown: true } }];
    const list = Object.entries(J.revealProbabilities(state, mover.side))
      .map(([t, p]) => ({ prob: p, opts: { ...cap, revealAs: t } }));
    return list.sort((a, b) => b.prob - a.prob);
  }

  // ── Zobrist hashing: one random number per (square, piece), XORed; two 32-bit halves form a 53-bit key ──
  const PIECE_CODE = { K: 0, A: 1, E: 2, H: 3, R: 4, C: 5, P: 6 };
  const POOL_TYPES = ['A', 'E', 'H', 'R', 'C', 'P'];
  const Z = (() => {
    const rnd = Bots.seededRandom(0x5eed);
    const r32 = () => (rnd() * 4294967296) >>> 0;
    const mk = (n) => { const a = new Uint32Array(n); for (let i = 0; i < n; i++) a[i] = r32(); return a; };
    // piece key: side(2) × [7 revealed types + 7 hidden roles] = 28
    return { a: mk(90 * 28), b: mk(90 * 28), turnA: r32(), turnB: r32(), poolA: mk(2 * 6 * 16), poolB: mk(2 * 6 * 16) };
  })();
  function hashState(state) {
    let h1 = 0, h2 = 0;
    const board = state.board;
    for (let i = 0; i < 90; i++) {
      const pc = board[i];
      if (!pc) continue;
      const k = i * 28 + (pc.side === 'r' ? 0 : 14) + (pc.hidden ? 7 + PIECE_CODE[pc.role] : PIECE_CODE[pc.type]);
      h1 ^= Z.a[k]; h2 ^= Z.b[k];
    }
    if (state.turn === 'b') { h1 ^= Z.turnA; h2 ^= Z.turnB; }
    for (let s2 = 0; s2 < 2; s2++) {
      const pool = state.pools[s2 === 0 ? 'r' : 'b'];
      for (let t = 0; t < 6; t++) {
        const c = Math.min(15, pool[POOL_TYPES[t]] || 0);
        if (c) { const k = (s2 * 6 + t) * 16 + c; h1 ^= Z.poolA[k]; h2 ^= Z.poolB[k]; }
      }
    }
    return (h1 >>> 0) * 2097152 + (h2 & 0x1fffff);
  }

  const NULL_WINDOW = 0.01;
  /**
   * Does `side` have a hidden piece "in danger": attacked by the opponent and not defended?
   * Then reveal moves are not pruned at that node – the way out may be a low-priority reveal (moving the piece,
   * blocking, or freeing a square for it), which the priority table would otherwise drop.
   */
  function hasThreatenedHidden(J, state, side) {
    const board = state.board, enemy = J.opp(side);
    for (let i = 0; i < board.length; i++) {
      const pc = board[i];
      if (pc && pc.hidden && pc.side === side && J.isSquareAttacked(board, i, enemy) && !J.isSquareAttacked(board, i, side)) return true;
    }
    return false;
  }

  /** Rooks + Cannons + Horses of `side` still hidden (in its pool). */
  const poolBig = (state, side) => { const pl = state.pools[side]; return (pl.R || 0) + (pl.C || 0) + (pl.H || 0); };
  /** Value of the strong pieces still hidden for `side`: Rook 9, Cannon 4.5, Horse 4 per piece in the pool. */
  const poolStrength = (state, side) => { const pl = state.pools[side]; return 9 * (pl.R || 0) + 4.5 * (pl.C || 0) + 4 * (pl.H || 0); };

  function hasRevealedRook(state, side) {
    for (const pc of state.board) if (pc && pc.side === side && !pc.hidden && pc.type === 'R') return true;
    return false;
  }

  /** Step 12: strength of `side`'s revealed fighting pieces – Rook 9, Cannon 4.5, Horse 4, crossed Pawn 1. */
  function revealedStrength(J, state, side) {
    let s = 0;
    for (let i = 0; i < 90; i++) {
      const pc = state.board[i];
      if (!pc || pc.hidden || pc.side !== side) continue;
      if (pc.type === 'R') s += 9;
      else if (pc.type === 'C') s += 4.5;
      else if (pc.type === 'H') s += 4;
      else if (pc.type === 'P' && (side === 'r' ? J.Y(i) <= 4 : J.Y(i) >= 5)) s += 1;
    }
    return s;
  }
  function hasHidden(state, side) {
    for (const pc of state.board) if (pc && pc.hidden && pc.side === side) return true;
    return false;
  }
  /** Board after moving the piece on m.from to m.to, the piece unchanged (a hidden piece keeps acting by its role). */
  function boardAfter(state, m) {
    const b2 = state.board.slice();
    b2[m.to] = b2[m.from]; b2[m.from] = null;
    return b2;
  }

  /** Number of revealed Rooks, Cannons and Horses of `side`. */
  function bigPiecesOut(state, side) {
    let n = 0;
    for (const pc of state.board) if (pc && pc.side === side && !pc.hidden && (pc.type === 'R' || pc.type === 'C' || pc.type === 'H')) n++;
    return n;
  }
  const naturalLimit = (state) => (state.rules && state.rules.naturalLimit) || 120;
  /** Has pieces other than King and Pawns (avoid null move in Pawn-only endgames – zugzwang-prone). */
  function hasPieces(state, side) {
    for (const pc of state.board) if (pc && pc.side === side && (pc.hidden || (pc.type !== 'K' && pc.type !== 'P'))) return true;
    return false;
  }

  /** Transposition tables kept between moves, one per set of bot params (both arena bots share one process). */
  const KEPT_TT = new Map();
  function keptTable(p) {
    const key = JSON.stringify(p);
    let t = KEPT_TT.get(key);
    if (!t) {
      if (KEPT_TT.size >= 4) KEPT_TT.clear();
      t = new Map();
      KEPT_TT.set(key, t);
    }
    return t;
  }

  function createSearcher(J, ctx, w) {
    /** The piece on `sq` is attacked by the opponent and not defended. */
    const isThreatened = (state, sq) => {
      const side = state.board[sq].side;
      return J.isSquareAttacked(state.board, sq, J.opp(side)) && !J.isSquareAttacked(state.board, sq, side);
    };
    const p = ctx.params;
    const WIN = w.win;
    const MATE_ZONE = WIN - 500;
    const BOUND = p.chanceBound;
    const history = new Int32Array(90 * 90);
    const killers = [];                                   // killers[ply] = [m1, m2] (from*90+to)
    let nodes = 0;
    let deadline = Infinity;

    const pieceOrderValue = (pc) => (pc.hidden ? HIDDEN_ORDER_VALUE : ORDER_VALUE[pc.type]);

    const OP = Bots.lib.opening;
    function orderScore(state, m, ply) {
      const mover = state.board[m.from];
      const target = state.board[m.to];
      if (target) return 100000 + pieceOrderValue(target) * 100 - pieceOrderValue(mover); // MVV-LVA
      const k = killers[ply], code = m.from * 90 + m.to;
      if (k && (k[0] === code || k[1] === code)) return 90000 - (k[0] === code ? 0 : 1);
      if (mover.hidden && p.openingOrder && OP) {
        // reveal move: order by the priority table (rank 1 first), then by history
        return 60000 - OP.revealRank(state, J, m, p.pawnOrder) * 5000 + Math.min(4000, history[code]);
      }
      return Math.min(80000, history[code]) + (mover.hidden ? 50 : 0);
    }

    function orderMoves(state, moves, ttMove, ply = 0) {
      for (const m of moves) m._o = ttMove && m.from * 90 + m.to === ttMove ? 1e9 : orderScore(state, m, ply);
      return moves.sort((a, b) => b._o - a._o);
    }

    function checkTime() {
      if ((++nodes & 127) === 0 && ctx.now() > deadline) throw TIMEOUT;
    }

    // ── Transposition table ────────────────────────────────────────────
    // Stores results of positions already searched: reused when reached again (via another move order) and
    // used to try the previous best move first in the next deepening iteration.
    // ttKeep: reuse the table of the previous move (same bot settings) – the next search starts "warm"
    const TT = p.ttKeep ? keptTable(p) : new Map();
    const EXACT = 0, LOWER = 1, UPPER = 2;
    const ttStore = (key, depth, value, flag, move, ply) => {
      if (TT.size > p.ttSize) TT.clear();
      // mate scores are stored relative to the current node
      if (value > MATE_ZONE) value += ply; else if (value < -MATE_ZONE) value -= ply;
      const old = TT.get(key);
      if (!old || old.depth <= depth) TT.set(key, { depth, value, flag, move });
    };
    const ttValue = (e, ply) => (e.value > MATE_ZONE ? e.value - ply : e.value < -MATE_ZONE ? e.value + ply : e.value);

    /**
     * Value of move m from the mover's point of view.
     *   child(next, alpha, beta) – value from the other side's point of view (full search)
     *   probe(next)              – cheap LOWER bound for the other side (e.g. the quiescence stand-pat score)
     * A reveal move is a chance node: take the probability-weighted expectation, with Star2-style pruning:
     * probe first to get an upper bound U_i for each outcome, then search properly with a narrowed window.
     */
    function moveValue(state, m, alpha, beta, child, probe, inQ = false) {
      const outs = outcomes(state, J, m, inQ && p.qRevealUnknown);
      if (outs.length === 1) {
        const next = J.makeMove(state, m, outs[0].opts ? { ...outs[0].opts, fast: true } : { fast: true });
        return -child(next, -beta, -alpha);
      }
      const L = -BOUND;
      const n = outs.length;
      const nexts = new Array(n), U = new Array(n);
      let remU = 0;
      for (let i = 0; i < n; i++) {
        nexts[i] = J.makeMove(state, m, { ...outs[i].opts, fast: true });
        const lb = p.probe ? probe(nexts[i]) : -INF;     // lower bound for the opponent → upper bound for us
        U[i] = lb > -INF ? Math.min(BOUND, Math.max(L, -lb)) : BOUND;
        remU += outs[i].prob * U[i];
      }
      if (remU <= alpha) return remU;                    // probing alone proves this move is bad
      let sum = 0, remP = 1;
      for (let i = 0; i < n; i++) {
        const pr = outs[i].prob;
        remU -= pr * U[i]; remP -= pr;
        // threshold this outcome must beat for the total to be > alpha / >= beta
        const aRaw = (alpha - sum - remU) / pr;
        const bRaw = (beta - sum - remP * L) / pr;
        if (aRaw >= U[i]) return sum + pr * U[i] + remU;  // even its best case cannot save it
        if (bRaw <= L) return sum + pr * L + remP * L;
        // child window clamped to [L, U_i]; hitting the clamp does NOT mean a cutoff
        const a = Math.max(L, aRaw), b = Math.min(U[i], bRaw);
        let v = -child(nexts[i], -b, -a);
        v = v > U[i] ? U[i] : v < L ? L : v;
        sum += pr * v;
        if (v <= aRaw) return sum + remU;                // fail-low: total is certainly <= alpha
        if (v >= bRaw) return sum + remP * L;            // fail-high: total is certainly >= beta
      }
      return sum;
    }

    /** Cheap lower bound for the side to move at a quiescence node: stand-pat score (unless in check). */
    function qProbe(state, qply) {
      if (state.quietPlies >= naturalLimit(state)) return -INF;
      // repeated position: the true score is the ruling, not stand-pat → cannot be used as a bound
      if (p.repetition && qply === 0 && repetitionScore(state, 0) !== null) return -INF;
      if (qply < p.qCheckPly && J.isInCheck(state)) return -INF;
      return E.evaluate(state, J, state.turn, w);
    }

    function qsearch(state, alpha, beta, ply, qply) {
      checkTime();
      if (state.quietPlies >= naturalLimit(state)) return 0;
      if (p.repetition && qply === 0) { const rv = repetitionScore(state, ply); if (rv !== null) return rv; }
      const inCheck = J.isInCheck(state);
      let best, moves;
      // only consider all check evasions in the first few plies (long chains of checks would blow up the tree)
      const evasion = inCheck && qply < p.qCheckPly;
      if (evasion) {
        moves = J.getLegalMoves(state);
        if (!moves.length) return -(WIN - ply);
        best = -INF;
      } else {
        const stand = E.evaluate(state, J, state.turn, w);
        if (stand >= beta || qply >= p.qDepth) return stand;
        if (stand > alpha) alpha = stand;
        best = stand;
        moves = J.getLegalMoves(state, { capturesOnly: true });
      }
      orderMoves(state, moves);
      const child = (next, a, b) => qsearch(next, a, b, ply + 1, qply + 1);
      const probe = (next) => qProbe(next, qply + 1);
      for (const m of moves) {
        if (!evasion) {
          // hidden pieces may only capture at the first qply (each reveal splits into 6 branches – avoid blow-up)
          if (qply >= p.qHiddenPly && state.board[m.from].hidden) continue;
          // delta pruning: even winning this piece cannot raise the score above alpha
          const victim = state.board[m.to];
          const gain = victim.hidden ? HIDDEN_ORDER_VALUE : ORDER_VALUE[victim.type];
          if (best + gain + p.deltaMargin < alpha) continue;
        }
        const v = moveValue(state, m, alpha, beta, child, probe, true);
        if (v > best) best = v;
        if (v > alpha) alpha = v;
        if (alpha >= beta) break;
      }
      return best;
    }

    /**
     * Repetition (Chinese rules): a position that already occurred (in the game or on the current branch)
     * → ruled right away as if fully repeated: the violator (perpetual check, perpetual chase…) loses, otherwise draw.
     * Returns the score from the mover's point of view, or null if not a repetition.
     */
    const repCache = new Map();
    function repetitionScore(state, ply) {
      const head = state.rep;
      if (!head || head.len < 5 || (state.rules && state.rules.repetition === 'none')) return null;
      let node = head.prev, d = 1, seen = false;
      while (node) { if (d % 2 === 0 && node.key === head.key) { seen = true; break; } node = node.prev; d++; }
      if (!seen) return null;
      let res = repCache.get(head.key);
      if (res === undefined) { const st = J.repetitionStatus(state); res = st ? st.result : null; repCache.set(head.key, res); }
      if (!res) return null;
      if (!res.winner) return 0;
      return res.winner === state.turn ? WIN - ply : -(WIN - ply);
    }

    /**
     * Decision node. probeOnly = only evaluate the first move (in order) → returns a LOWER bound of the node,
     * used as the probe for the chance node above.
     */
    function search(state, depth, alpha, beta, ply, probeOnly) {
      if (depth <= 0) return qsearch(state, alpha, beta, ply, 0);
      checkTime();
      if (state.quietPlies >= naturalLimit(state)) return 0;
      if (p.repetition) { const rv = repetitionScore(state, ply); if (rv !== null) return rv; }
      const key = p.tt ? hashState(state) : 0;
      const e = p.tt ? TT.get(key) : null;
      if (e && e.depth >= depth) {
        const v = ttValue(e, ply);
        if (e.flag === EXACT) return v;
        if (e.flag === LOWER && (v >= beta || probeOnly)) return v;
        if (e.flag === UPPER && v <= alpha && !probeOnly) return v;
      }
      const moves = J.getLegalMoves(state);
      if (!moves.length) return -(WIN - ply);       // checkmated / no moves = loss
      const inCheck = J.isInCheck(state);

      // Null move: if we are still >= beta after letting the opponent move twice in a row → cut.
      if (p.nullMove && !probeOnly && !inCheck && depth >= p.nullMinDepth && beta < MATE_ZONE && beta > -MATE_ZONE
          && hasPieces(state, state.turn)) {
        const ns = { ...state, turn: J.opp(state.turn), quietPlies: state.quietPlies + 1, lastMove: null, rep: null };
        const v = -search(ns, depth - 1 - p.nullR, -beta, -beta + NULL_WINDOW, ply + 1, false);
        if (v >= beta) return v;
      }

      orderMoves(state, moves, e && e.move, ply);
      const child = (next, a, b) => search(next, depth - 1, a, b, ply + 1, false);
      const probe = depth - 1 <= 0
        ? (next) => qProbe(next, 0)
        : (next) => search(next, depth - 1, -INF, INF, ply + 1, true);
      if (probeOnly) return moveValue(state, moves[0], -INF, INF, child, probe);
      const childR = (next, a, b) => search(next, depth - 2, a, b, ply + 1, false);
      const probeR = depth - 2 <= 0
        ? (next) => qProbe(next, 0)
        : (next) => search(next, depth - 2, -INF, INF, ply + 1, true);
      const alpha0 = alpha;
      let best = -INF, bestMove = 0;
      let revealsSeen = 0;
      // Once we have enough big pieces out, revealing more rarely helps ("3 quân lớn đã ra thì tấn công")
      let revealK = p.revealTopK;
      // saving a hidden piece in danger only matters while many strong pieces are still hidden ("còn nhiều quân giá trị")
      const keepThreatenedHere = p.keepThreatened && poolBig(state, state.turn) >= p.keepThreatenedMinBig;
      if (revealK > 0 && p.revealTopKDeveloped > 0 && bigPiecesOut(state, state.turn) >= p.developedCount) {
        revealK = Math.min(revealK, p.revealTopKDeveloped);
      }
      for (let i = 0; i < moves.length; i++) {
        const m = moves[i];
        const quiet = !state.board[m.to];
        // Prune reveal moves: below the root only consider the top revealK (non-capturing) reveal moves by
        // priority. Captures, moves of revealed pieces and positions in check: always fully considered.
        if (quiet && !inCheck && state.board[m.from].hidden) {
          // keep hidden Rook / Cannon squares hidden (defence + option value), unless that piece is attacked
          if (p.revealSkipRoles && best > -INF && p.revealSkipRoles.includes(state.board[m.from].role)
              && !J.isSquareAttacked(state.board, m.from, J.opp(state.turn))) continue;
          if (revealK > 0 && ++revealsSeen > revealK && best > -INF
              // below the root, a hidden piece in danger may always try to run away
              && !(keepThreatenedHere && isThreatened(state, m.from))) continue;
        }
        let v;
        // LMR: late quiet move → search 1 ply shallower with a null window; re-search at full depth if it surprises
        if (p.lmr && depth >= p.lmrMinDepth && i >= p.lmrAfter && quiet && !inCheck) {
          v = moveValue(state, m, alpha, alpha + NULL_WINDOW, childR, probeR);
          if (v > alpha) v = moveValue(state, m, alpha, beta, child, probe);
        } else if (p.pvs && i > 0 && beta - alpha > NULL_WINDOW) {
          // PVS: only prove "not better than alpha" with a null window; re-search fully if it exceeds
          v = moveValue(state, m, alpha, alpha + NULL_WINDOW, child, probe);
          if (v > alpha && v < beta) v = moveValue(state, m, alpha, beta, child, probe);
        } else {
          v = moveValue(state, m, alpha, beta, child, probe);
        }
        if (v > best) { best = v; bestMove = m.from * 90 + m.to; }
        if (v > alpha) alpha = v;
        if (alpha >= beta) {
          if (quiet) {
            history[bestMove] += depth * depth;
            const k = killers[ply] || (killers[ply] = [0, 0]);
            if (k[0] !== bestMove) { k[1] = k[0]; k[0] = bestMove; }
          }
          break;
        }
      }
      if (p.tt) ttStore(key, depth, best, best >= beta ? LOWER : best <= alpha0 ? UPPER : EXACT, bestMove, ply);
      return best;
    }

    /**
     * Difficulty levels: pick among the moves scoring at most `randomness` below the best one,
     * weight = 1 - (best - score) / randomness (the best move has weight 1).
     */
    function pickRandomized(best, scores) {
      const cands = scores.filter(([, s]) => s >= best.score - p.randomness)
        .map(([m, s]) => [m, s, 1 - (best.score - s) / p.randomness + 1e-6]);
      let r = ctx.random() * cands.reduce((a, c) => a + c[2], 0);
      for (const [m, s, wt] of cands) {
        if ((r -= wt) <= 0) return { ...best, move: m, score: s, picked: cands.length };
      }
      return best;
    }

    /**
     * Expert habits for our own move at the root (not applied inside the tree, so the opponent's options are
     * still searched in full). The move is only played if it scores this much better than the alternatives:
     *  - cannonRaidMalus: a hidden Cannon capturing a hidden piece ("vật pháo giả lên mã giả") before we have a
     *    revealed Rook – experts do it after the edge Pawn produced a Rook, to break the enemy's hidden Rook there
     *  - hiddenRookCaptureMalus: a hidden Rook ("xe giả", a strong defender) capturing anything but a revealed
     *    Rook / Cannon / Horse
     * No penalty when the moving piece is itself attacked and undefended (capturing is then its way out).
     */
    function styleMalus(state, m) {
      const mover = state.board[m.from], target = state.board[m.to];
      if (!mover.hidden) {
        // "the enemy piece is already dead – leave it": our revealed edge Pawn on its river bank already holds the
        // enemy's hidden edge Pawn opposite (the square between them is ours). Pushing it on walks into that hidden
        // Pawn's mouth for nothing – reveal a piece instead (any phase; not when our Pawn is itself attacked)
        if (!target && p.releaseControlMalus > 0 && edgePawnStandoff(state, m) && !isThreatened(state, m.from)) {
          return p.releaseControlMalus;
        }
        // behind in development (the opponent has a Rook out, we have no Rook/Cannon/Horse out): reveal first
        if (p.developFirstMalus > 0 && bigPiecesOut(state, mover.side) === 0 && hasRevealedRook(state, J.opp(mover.side))
            && !isThreatened(state, m.from) && !(target && !target.hidden && (target.type === 'R' || target.type === 'C' || target.type === 'H'))) {
          return target && target.hidden ? p.developFirstMalus : p.developFirstQuietMalus;
        }
        return 0;
      }
      if (!target) return guardBonus(state, m) + horseBlockBonus(state, m) + cannonLeapMalus(state, m);
      if (!target.hidden && (target.type === 'R' || target.type === 'C' || target.type === 'H')) return 0;
      const threatened = isThreatened(state, m.from);
      // raid only once we have a Rook out AND the opponent's hidden pieces are worth more than ours (the swap of
      // two unknown pieces then favours us)
      if (mover.role === 'C' && target.hidden && p.cannonRaidMalus > 0
          && !(hasRevealedRook(state, mover.side) && poolStrength(state, J.opp(mover.side)) > poolStrength(state, mover.side))) {
        if (!threatened) return p.cannonRaidMalus;
        // chased (e.g. by a Horse): raiding is a way out, but if the Cannon can also step to a safe square
        // ("bình pháo vào giữa") keep part of the penalty – game report 2026-11-12, b7xb0 vs b7e7
        return hasSafeQuietMove(state, m.from) ? p.cannonRaidMalus * p.cannonRaidChasedFactor : 0;
      }
      if (threatened) return 0;
      if (mover.role === 'R' && p.hiddenRookCaptureMalus > 0) return p.hiddenRookCaptureMalus;
      return 0;
    }

    /**
     * Move m pushes our revealed Pawn on an edge file (a / i) forward from our river bank, while the enemy's hidden
     * edge Pawn still stands on its start square opposite (so the square we step onto is in its mouth).
     */
    function edgePawnStandoff(state, m) {
      const pc = state.board[m.from];
      if (!pc || pc.hidden || pc.type !== 'P') return false;
      const x = J.X(m.from), y = J.Y(m.from);
      if (x !== 0 && x !== 8 || J.X(m.to) !== x) return false;
      const red = pc.side === 'r';
      if (y !== (red ? 5 : 4) || J.Y(m.to) !== (red ? 4 : 5)) return false;
      const opp = state.board[J.idx(x, red ? 3 : 6)];
      return !!(opp && opp.hidden && opp.side !== pc.side && opp.role === 'P');
    }

    /**
     * "Phi pháo úp": a hidden Cannon leaping (without capturing) into the opponent's half. Fine if it turns out a
     * Rook/Cannon/Horse, a stranded weak piece otherwise → penalty × probability of a weak piece (A/E/P).
     */
    function cannonLeapMalus(state, m) {
      const mover = state.board[m.from];
      if (!(p.cannonLeapMalus > 0) || mover.role !== 'C' || isThreatened(state, m.from)) return 0;
      if (E.gamePhase(state, w) !== 'opening') return 0;              // opening only
      const y = J.Y(m.to);
      if (!(mover.side === 'r' ? y <= 4 : y >= 5)) return 0;     // stays in our half
      const pr = J.revealProbabilities(state, mover.side);
      return p.cannonLeapMalus * ((pr.A || 0) + (pr.E || 0) + (pr.P || 0));
    }

    /** Can the piece on `from` make a non-capturing legal move to a square the opponent does not attack? */
    function hasSafeQuietMove(state, from) {
      const enemy = J.opp(state.board[from].side);
      for (const mv of J.getLegalMovesFrom(state, from)) {
        if (state.board[mv.to]) continue;
        const b2 = state.board.slice();
        b2[mv.to] = b2[mv.from]; b2[mv.from] = null;
        if (!J.isSquareAttacked(b2, mv.to, enemy)) return true;
      }
      return false;
    }

    /**
     * "Gác Tượng/Mã chăn Pháo": an enemy Cannon attacks one of our hidden Rooks (role R); a quiet reveal move that
     * puts a second piece in the Cannon's line (so the Rook is no longer attacked) gets a bonus (negative penalty).
     * Without it the bot often sees the blocker as "revealing into the Cannon's mouth" and plays elsewhere.
     */
    function guardBonus(state, m) {
      if (!(p.guardRookBonus > 0)) return 0;
      const side = state.board[m.from].side, enemy = J.opp(side);
      const rooks = [];
      for (let i = 0; i < 90; i++) {
        const pc = state.board[i];
        if (pc && pc.hidden && pc.side === side && pc.role === 'R' && i !== m.from && revealedCannonAttacks(state.board, i, enemy)) rooks.push(i);
      }
      if (!rooks.length) return 0;
      const b2 = state.board.slice();
      b2[m.to] = b2[m.from]; b2[m.from] = null;
      return rooks.some((i) => !revealedCannonAttacks(b2, i, enemy)) ? -p.guardRookBonus : 0;
    }

    /**
     * "Cản mã": the opponent has a revealed Horse that can jump into our half; a hidden Pawn reveal that blocks one
     * of its legs (fewer squares it can reach in our half) gets a bonus. Opening habit: block it with a Pawn at once.
     */
    function horseBlockBonus(state, m) {
      if (!(p.horseBlockBonus > 0) || state.board[m.from].role !== 'P') return 0;
      const side = state.board[m.from].side;
      const before = enemyHorseReach(state.board, side);
      if (!before.n) return 0;
      const b2 = state.board.slice();
      b2[m.to] = b2[m.from]; b2[m.from] = null;
      const after = enemyHorseReach(b2, side);
      // only a real block: fewer entry squares AND the Horse can no longer take anything of ours in our half
      // (blocking one jump while it still eats a Pawn elsewhere is not "cản mã" – game report 2026-11-12, a6a5)
      return after.n < before.n && !after.captures ? -p.horseBlockBonus : 0;
    }

    /** Squares in `side`'s half that the opponent's revealed Horses can jump to; captures = how many hold our piece. */
    function enemyHorseReach(board, side) {
      let n = 0, captures = 0;
      for (let i = 0; i < 90; i++) {
        const pc = board[i];
        if (!pc || pc.hidden || pc.side === side || pc.type !== 'H') continue;
        for (const t of J.pseudoTargets(board, i)) {
          const y = (t / 9) | 0;
          if (side === 'r' ? y >= 5 : y <= 4) { n++; if (board[t]) captures++; }
        }
      }
      return { n, captures };
    }

    /** Is square sq attacked by a revealed Cannon of `by`? (exactly one screen on the file/rank) */
    function revealedCannonAttacks(board, sq, by) {
      const x = sq % 9, y = (sq / 9) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        let nx = x + dx, ny = y + dy, screen = false;
        while (nx >= 0 && nx < 9 && ny >= 0 && ny < 10) {
          const q = board[ny * 9 + nx];
          if (q) {
            if (screen) { if (q.side === by && !q.hidden && q.type === 'C') return true; break; }
            screen = true;
          }
          nx += dx; ny += dy;
        }
      }
      return false;
    }

    // ── Step 12: revealed-strength balance (user's experience, 2026-11-13) ──────────────────────────────
    //  1. reveal the Pawn row first whenever it is safe (behind / equal)
    //  2. behind in revealed strength → reveal more pieces (back rank too) instead of playing the revealed ones
    //  3. ahead → play the revealed pieces and keep the enemy's hidden pieces from revealing safely
    //  4. equal → reveal and control, the search decides
    //  6. a revealed enemy Rook hitting our hidden piece on a back-rank Advisor square next to the King → reveal
    //     that piece (or block the line) – game 2026-11-13, the d-file doubled Rooks took d9

    /** 'behind' | 'ahead' | 'equal' for the side to move, or null (rules off / endgame / nothing left to reveal). */
    function balanceMode(state) {
      if (!(p.strengthGap > 0) || E.gamePhase(state, w) === 'endgame') return null;
      const side = state.turn;
      const d = revealedStrength(J, state, side) - revealedStrength(J, state, J.opp(side));
      if (d <= -p.strengthGap) return hasHidden(state, side) ? 'behind' : null;
      return d >= p.strengthGap ? 'ahead' : 'equal';
    }

    /** Squares of `side`'s hidden pieces that have moves but every target is attacked (cannot reveal safely). */
    function trappedHidden(board, side) {
      const map = new Uint8Array(90), out = [];
      J.attackMap(board, J.opp(side), map);
      for (let i = 0; i < 90; i++) {
        const pc = board[i];
        if (!pc || !pc.hidden || pc.side !== side) continue;
        const t = J.pseudoTargets(board, i);
        if (t.length && t.every((sq) => map[sq])) out.push(i);
      }
      return out;
    }

    /** Expected change of the number of enemy hidden pieces that cannot reveal safely (a captured one stays counted). */
    function controlDelta(state, m, before) {
      const enemy = J.opp(state.turn), target = state.board[m.to];
      const base = before.length - (target && target.hidden && before.includes(m.to) ? 1 : 0);
      let ev = 0;
      for (const o of outcomes(state, J, m)) {
        const next = J.makeMove(state, m, { ...(o.opts || {}), fast: true });
        ev += o.prob * trappedHidden(next.board, enemy).length;
      }
      return ev - base;
    }

    /** Does the move attack the enemy King (a hidden piece by its role)? */
    function givesCheck(state, m) {
      const enemy = J.opp(state.turn), b2 = boardAfter(state, m), k = J.kingSquare(b2, enemy);
      return k >= 0 && J.isSquareAttacked(b2, k, state.turn);
    }

    /** Revealing on m.to is safe: not attacked, or defended and no revealed enemy Pawn/Advisor/Elephant attacks it. */
    function safeLanding(state, m) {
      const side = state.turn, enemy = J.opp(side), b2 = boardAfter(state, m);
      if (!J.isSquareAttacked(b2, m.to, enemy)) return true;
      if (!J.isSquareAttacked(b2, m.to, side)) return false;
      for (let i = 0; i < 90; i++) {
        const q = b2[i];
        if (q && q.side === enemy && !q.hidden && (q.type === 'P' || q.type === 'A' || q.type === 'E')
            && J.pseudoTargets(b2, i).includes(m.to)) return false;
      }
      return true;
    }

    /** Our hidden pieces on a back-rank Advisor square next to our King, attacked directly by a revealed enemy Rook. */
    function exposedPalaceHidden(board, side) {
      const enemy = J.opp(side), y = side === 'r' ? 9 : 0, k = J.kingSquare(board, side);
      if (k < 0) return 0;
      let n = 0;
      for (const x of [3, 5]) {
        const sq = J.idx(x, y), pc = board[sq];
        if (!pc || !pc.hidden || pc.side !== side) continue;
        if (Math.abs(J.X(k) - x) > 1 || Math.abs(J.Y(k) - y) > 1) continue;
        if (revealedRookAttacks(board, sq, enemy)) n++;
      }
      return n;
    }

    /** Is sq attacked by a revealed Rook of `by` (first piece on a file/rank line)? */
    function revealedRookAttacks(board, sq, by) {
      const x = sq % 9, y = (sq / 9) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        let nx = x + dx, ny = y + dy;
        while (nx >= 0 && nx < 9 && ny >= 0 && ny < 10) {
          const q = board[ny * 9 + nx];
          if (q) { if (q.side === by && !q.hidden && q.type === 'R') return true; break; }
          nx += dx; ny += dy;
        }
      }
      return false;
    }

    /** Root penalty (> 0) or bonus (< 0) from the step-12 rules for our move m. */
    function balanceAdj(state, m, mode, trapped0) {
      const mover = state.board[m.from], target = state.board[m.to], side = mover.side;
      let adj = 0;
      // rule 6 (any phase): reveal the hidden piece next to the King that a Rook hits, or block the line
      if (p.palaceGuardBonus > 0 && mover.hidden && !target) {
        const before = exposedPalaceHidden(state.board, side);
        if (before && exposedPalaceHidden(boardAfter(state, m), side) < before) adj -= p.palaceGuardBonus;
      }
      if (!mode) return adj;
      // rule 1: the Pawn row first (a hidden piece there always moves as a Pawn)
      if (mode !== 'ahead' && p.pawnRowRevealBonus > 0 && mover.hidden && !target
          && J.Y(m.from) === (side === 'r' ? 6 : 3) && safeLanding(state, m)) adj -= p.pawnRowRevealBonus;
      // common exemptions: taking a big revealed piece, the mover is in danger, the move gives check
      if (target && !target.hidden && (target.type === 'R' || target.type === 'C' || target.type === 'H')) return adj;
      if (isThreatened(state, m.from) || givesCheck(state, m)) return adj;
      // rule 2: behind → reveal instead of playing the revealed pieces
      if (mode === 'behind' && !mover.hidden) {
        if (!target) adj += p.behindQuietMalus;
        else if (target.hidden || target.type === 'P') adj += p.behindCaptureMalus;
      }
      // rule 3: ahead → no back-rank reveals, play the revealed pieces
      if (mode === 'ahead' && mover.hidden && !target && mover.role !== 'P') adj += p.aheadRevealMalus;
      // rules 3 + 4: keep the enemy's hidden pieces from revealing
      const cb = mode === 'ahead' ? p.controlBonus : mode === 'equal' ? p.controlBonus * p.controlEqualFactor : 0;
      if (cb > 0 && trapped0) adj -= cb * controlDelta(state, m, trapped0);
      return adj;
    }

    /** Iterative deepening. Returns { move, score, depth, nodes }. */
    function think(state, timeMs) {
      const t0 = ctx.now();
      deadline = p.depth > 0 ? Infinity : t0 + timeMs;
      const maxDepth = p.depth > 0 ? p.depth : p.maxDepth;
      let rootMoves = orderMoves(state, J.getLegalMoves(state));
      // Root pruning: keep only the top revealTopKRoot (non-capturing) reveal moves by priority
      const mode = balanceMode(state);
      const keepAll = (p.keepThreatened && poolBig(state, state.turn) >= p.keepThreatenedMinBig && hasThreatenedHidden(J, state, state.turn))
        || (mode === 'behind' && p.behindNoRootPrune);
      if (p.revealTopKRoot > 0 && !J.isInCheck(state) && !keepAll) {
        let seen = 0;
        const kept = rootMoves.filter((m) => state.board[m.to] || !state.board[m.from].hidden || ++seen <= p.revealTopKRoot);
        if (kept.length) rootMoves = kept;
      }
      const rootInCheck = J.isInCheck(state);
      const trapped0 = mode ? trappedHidden(state.board, J.opp(state.turn)) : null;
      for (const m of rootMoves) m._pen = rootInCheck ? 0 : +(styleMalus(state, m) + balanceAdj(state, m, mode, trapped0)).toFixed(6);
      let best = { move: rootMoves[0], score: 0, depth: 0 };
      if (rootMoves.length === 1) return { ...best, nodes };
      let lastScores = null;                                 // [move, score] of the last completed iteration

      for (let depth = 1; depth <= maxDepth; depth++) {
        let alpha = -INF, iterBest = null, iterScore = -INF, searched = 0;
        try {
          const child = (next, a, b) => search(next, depth - 1, a, b, 1, false);
          const probe = depth - 1 <= 0
            ? (next) => qProbe(next, 0)
            : (next) => search(next, depth - 1, -INF, INF, 1, true);
          for (const m of rootMoves) {
            let v;
            const pen = m._pen;                            // style penalty: the move must be this much better
            if (p.pvs && searched > 0) {
              v = moveValue(state, m, alpha + pen, alpha + pen + NULL_WINDOW, child, probe) - pen;
              if (v > alpha) v = moveValue(state, m, alpha + pen, INF, child, probe) - pen;
            } else {
              v = moveValue(state, m, alpha + pen, INF, child, probe) - pen;
            }
            m._s = v;
            searched++;
            if (v > iterScore) { iterScore = v; iterBest = m; }
            if (v > alpha && !p.randomness && !p.debug) alpha = v;     // randomness: keep a full window → exact scores
          }
        } catch (e) {
          if (e !== TIMEOUT) throw e;
          // the previous best move is searched first; a move that already beat it at the new depth can be used
          if (iterBest && searched > 1 && iterBest !== best.move) best = { move: iterBest, score: iterScore, depth: depth - 1, partial: true };
          break;
        }
        best = { move: iterBest, score: iterScore, depth };
        if (p.randomness || p.debug) lastScores = rootMoves.map((m) => [m, m._s]);
        // best move first for the next iteration
        rootMoves.sort((a, b) => (b === iterBest) - (a === iterBest) || b._s - a._s);
        if (Math.abs(iterScore) > MATE_ZONE) break;                 // mate found
        if (p.depth <= 0 && ctx.now() - t0 > timeMs * 0.45) break;  // next iteration unlikely to finish
      }
      if (p.debug && lastScores) best.root = lastScores.map(([m, sc]) => ({ from: m.from, to: m.to, score: +sc.toFixed(2), pen: m._pen }));
      if (p.randomness && lastScores && Math.abs(best.score) < MATE_ZONE) best = pickRandomized(best, lastScores);
      return { ...best, nodes };
    }

    return { think, stats: () => ({ nodes }) };
  }

  function thinkTime(state, ctx, w) {
    const p = ctx.params;
    const phase = E.gamePhase(state, w);
    const base = Math.min(ctx.timeBudgetMs || 1000, p.maxTimeMs);
    return Math.max(20, base * p.timeScale * (p.phaseTime[phase] || 1));
  }

  Bots.register({
    id: 'search',
    name: 'Bot tìm kiếm',
    description: 'Nhìn trước nhiều nước (alpha-beta + kỳ vọng khi lật quân + tìm tiếp khi đổi quân), đào sâu dần theo thời gian.',
    params: {
      // about 4 s per move in the opening (to search deeper there), 3 s in the middlegame and endgame
      depth: 0, maxDepth: 30, maxTimeMs: 4000, timeScale: 1,
      phaseTime: { opening: 1, middlegame: 0.75, endgame: 0.75 },
      qDepth: 6, qHiddenPly: 1, qCheckPly: 2, deltaMargin: 2, chanceBound: 30, probe: true, tt: true, ttSize: 500000,
      nullMove: true, nullR: 2, nullMinDepth: 3, lmr: true, lmrMinDepth: 2, lmrAfter: 4, pvs: false, repetition: true,
      openingOrder: true, revealTopK: 4, revealTopKRoot: 8, randomness: 0, drawThreshold: -0.5,
      ttKeep: false, qRevealUnknown: false,
      revealSkipRoles: '', revealTopKDeveloped: 0, developedCount: 3, pawnOrder: 'edge', keepThreatened: true, keepThreatenedMinBig: 3,
      hiddenTrapped: 0.3,   // evaluation weight (bots/lib/eval.js): penalty per own hidden piece that cannot be revealed safely
      horseReach: 0,        // evaluation weight (off: lost in the arena at 0.3); replaced by the root horseBlockBonus
      cannonRaidMalus: 1.5, cannonRaidChasedFactor: 0.5, hiddenRookCaptureMalus: 1.5,   // expert habits at the root (step 7, not arena-tested yet)
      developFirstMalus: 0, developFirstQuietMalus: 0, guardRookBonus: 2, horseBlockBonus: 1.5,
      // step 8 evaluation weights (bots/lib/eval.js): Horse check threats, pháo đầu / pháo trống, own Cannon in the
      // centre in the opening. Pháo giác (bottomCannon) stays off – it lost in the arena (45%)
      horseCheckThreat: 0.4, cannonFacingKing: 0.5, cannonEmptyFile: 0.8, centralCannon: 0.3,
      releaseControlMalus: 1, cannonLeapMalus: 1,   // step 9 (user's experience, not arena-tested yet)
      // step 12: revealed-strength balance (user's experience; replaces developFirst*, which is the narrow case
      // "we have nothing out, the opponent has a Rook")
      strengthGap: 3, pawnRowRevealBonus: 0.4, behindQuietMalus: 1, behindCaptureMalus: 0.5, behindNoRootPrune: false,   // no-prune: 0.5 s arena 0–6 (too slow)
      aheadRevealMalus: 0.3, controlBonus: 0.4, controlEqualFactor: 0.5, palaceGuardBonus: 1,
    },
    chooseMove(state, J, ctx) {
      const w = E.resolveWeights(ctx.params);
      const p = { ...ctx.params };
      for (const k of ['opening', 'middlegame', 'endgame']) {           // allow 'phaseTime.middlegame=2'
        if (p[`phaseTime.${k}`] != null) p.phaseTime = { ...p.phaseTime, [k]: p[`phaseTime.${k}`] };
      }
      const c = { ...ctx, params: p };
      const r = createSearcher(J, c, w).think(state, thinkTime(state, c, w));
      // the root score includes the style penalty of the chosen move: report the position's own score
      const info = { score: +(r.score + (r.move && r.move._pen ? r.move._pen : 0)).toFixed(2), depth: r.depth, nodes: r.nodes };
      if (r.root) info.root = r.root;   // debug=true: exact score of every root move (full window), for analysis
      return { move: r.move, info };
    },
    acceptDraw(state, J, ctx) {
      return E.evaluate(state, J, ctx.side, E.resolveWeights(ctx.params)) <= ctx.params.drawThreshold;
    },
  });

  // ── Styles sharing the same algorithm ──
  // reference variants keep their old behaviour: step-12 rules off, developFirst back on (unless they override it)
  const STEP12_OFF = { strengthGap: 0, palaceGuardBonus: 0, developFirstMalus: 1, developFirstQuietMalus: 0.3 };
  Bots.variant('search', {
    id: 'search-v4', name: 'Bot tìm kiếm (bước 4)', hidden: true,
    description: '[Tham chiếu] Bản trước khi có ưu tiên lật quân – giữ lại để đo tiến bộ.',
    params: { ...STEP12_OFF, openingOrder: false, revealTopK: 0, revealTopKRoot: 0, qHiddenPly: 1, hiddenTrapped: 0, keepThreatened: false, horseReach: 0, cannonRaidMalus: 0, hiddenRookCaptureMalus: 0, developFirstMalus: 0, developFirstQuietMalus: 0, guardRookBonus: 0, horseBlockBonus: 0, horseCheckThreat: 0, cannonFacingKing: 0, cannonEmptyFile: 0, centralCannon: 0, releaseControlMalus: 0, cannonLeapMalus: 0 },
  });
  Bots.variant('search', {
    id: 'search-v5', name: 'Bot tìm kiếm (bước 5)', hidden: true,
    description: '[Tham chiếu] Bản bước 5 (trước khi có điểm khống chế quân úp) – giữ lại để đo tiến bộ.',
    params: { ...STEP12_OFF, qHiddenPly: 1, hiddenTrapped: 0, keepThreatened: false, horseReach: 0, cannonRaidMalus: 0, hiddenRookCaptureMalus: 0, developFirstMalus: 0, developFirstQuietMalus: 0, guardRookBonus: 0, horseBlockBonus: 0, horseCheckThreat: 0, cannonFacingKing: 0, cannonEmptyFile: 0, centralCannon: 0, releaseControlMalus: 0, cannonLeapMalus: 0 },
  });
  Bots.variant('search', {
    id: 'search-v6', name: 'Bot tìm kiếm (bước 6)', hidden: true,
    description: '[Tham chiếu] Bản bước 6 (trước khi sửa lỗi khai cuộc: cản mã, cứu quân úp bị đe doạ) – giữ lại để đo tiến bộ.',
    params: { ...STEP12_OFF, keepThreatened: false, horseReach: 0, cannonRaidMalus: 0, hiddenRookCaptureMalus: 0, developFirstMalus: 0, developFirstQuietMalus: 0, guardRookBonus: 0, horseBlockBonus: 0, horseCheckThreat: 0, cannonFacingKing: 0, cannonEmptyFile: 0, centralCannon: 0, releaseControlMalus: 0, cannonLeapMalus: 0 },
  });
  Bots.variant('search', {
    id: 'search-v7', name: 'Bot tìm kiếm (bước 7)', hidden: true,
    description: '[Tham chiếu] Bản bước 7 (trước khi có an toàn Tướng: Mã chiếu, Pháo đầu, Pháo trống, Pháo vào giữa) – giữ lại để đo tiến bộ.',
    params: { ...STEP12_OFF, horseCheckThreat: 0, cannonFacingKing: 0, cannonEmptyFile: 0, centralCannon: 0, releaseControlMalus: 0, cannonLeapMalus: 0 },
  });
  Bots.variant('search', {
    id: 'search-v8', name: 'Bot tìm kiếm (bước 8)', hidden: true,
    description: '[Tham chiếu] Bản bước 8 (trước khi có: giữ Tốt khống chế quân úp, hạn chế phi Pháo úp) – giữ lại để đo tiến bộ.',
    params: { ...STEP12_OFF, releaseControlMalus: 0, cannonLeapMalus: 0 },
  });
  Bots.variant('search', {
    id: 'search-v9', name: 'Bot tìm kiếm (bước 11)', hidden: true,
    description: '[Tham chiếu] Bản trước khi có luật cân bằng quân ngửa (lật hàng Tốt, yếu thì lật thêm, mạnh thì khống chế, lên Sĩ khi Xe nhắm Cung) – giữ lại để đo tiến bộ.',
    params: { ...STEP12_OFF },
  });
  Bots.variant('search', {
    id: 'search-fast', name: 'Bot tìm kiếm (nhanh)',
    description: 'Như Bot tìm kiếm nhưng chỉ nghĩ tối đa 0,3 giây mỗi nước.',
    params: { maxTimeMs: 300, phaseTime: { opening: 1, middlegame: 1, endgame: 1 } },
  });
  Bots.variant('search', {
    id: 'search-midgame', name: 'Bot tính lâu trung cuộc',
    description: 'Đi nhanh ở khai cuộc, dành gấp 2,5 lần thời gian cho trung cuộc.',
    params: { phaseTime: { opening: 0.5, middlegame: 2.5, endgame: 1.2 } },
  });
  Bots.variant('search', {
    id: 'search-endgame', name: 'Bot ưu tiên tàn cuộc',
    description: 'Đánh giá cao Mã, Xe, Tốt qua sông ở tàn cuộc (thích đổi quân để vào tàn cuộc), nghĩ lâu hơn khi vào tàn cuộc.',
    params: { 'H.endgame': 5.5, 'R.endgame': 11, 'P.crossed': 2.5, phaseTime: { opening: 0.8, middlegame: 1, endgame: 2 } },
  });

  Bots.lib.search = { createSearcher, outcomes, hashState };
});
