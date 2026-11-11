/*
 * Plays one game between 2 bots (Node or browser – no DOM dependency).
 *
 *   const rec = await playGame({ J, bots, seed: 1, red: 'greedy', black: 'random' });
 *
 * opts:
 *   seed        game seed (decides what hidden pieces turn out to be) – bots also get a seeded ctx.random derived from it
 *   red, black  bot spec: 'greedy' or 'greedy:revealBonus=1'
 *   maxPlies    adjudicate a draw beyond this many plies (default 300)
 *   moveTimeMs  suggested time per move when there is no clock (default 1000)
 *   tc          null or { initialMs, incrementMs } – real clock, running out of time loses
 *
 * Returns a record: { seed, red, black, result: { winner, reason, detail? }, plies, moves, stats }
 *   moves: [{ from, to }]  – same seed + same moves => the exact same game (including reveals)
 */
(function (root) {
  'use strict';

  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const SIDE_SALT = { r: 0x9e3779b9, b: 0x85ebca6b };

  async function playGame(opts) {
    const { J, bots, seed = 1, red, black, maxPlies = 300, moveTimeMs = 1000, tc = null } = opts;
    const players = { r: bots.resolve(red), b: bots.resolve(black) };
    const randoms = { r: bots.seededRandom(seed ^ SIDE_SALT.r), b: bots.seededRandom(seed ^ SIDE_SALT.b) };
    const clock = tc ? { r: tc.initialMs, b: tc.initialMs } : null;
    const stats = {};
    for (const side of ['r', 'b']) {
      stats[side] = { moves: 0, timeMs: 0, maxMs: 0, depthSum: 0, depthCount: 0, nodes: 0 };
    }

    let state = J.createGame({ seed });
    const moves = [];
    let result = null;

    while (!result) {
      if (state.result) { result = state.result; break; }
      if (state.ply >= maxPlies) { result = { winner: null, reason: 'max-plies' }; break; }

      const side = state.turn;
      const clk = clock ? { myTimeMs: clock[side], oppTimeMs: clock[J.opp(side)], incrementMs: tc.incrementMs } : null;
      const budget = bots.suggestBudget(clk, moveTimeMs);
      const t0 = now();
      const ctx = {
        side, ply: state.ply, random: randoms[side], now,
        timeBudgetMs: budget, deadline: t0 + budget, clock: clk, history: moves.slice(),
      };

      let out;
      try {
        out = await players[side].chooseMove(J.cloneState(state), J, ctx);
      } catch (err) {
        result = { winner: J.opp(side), reason: 'bot-error', detail: `${players[side].id}: ${err && err.message}` };
        break;
      }
      const elapsed = now() - t0;
      const st = stats[side];
      st.moves++; st.timeMs += elapsed; st.maxMs = Math.max(st.maxMs, elapsed);
      if (out.info.depth != null) { st.depthSum += out.info.depth; st.depthCount++; }
      if (out.info.nodes != null) st.nodes += out.info.nodes;

      if (clock) {
        clock[side] -= elapsed;
        if (clock[side] <= 0) { result = { winner: J.opp(side), reason: 'timeout' }; break; }
        clock[side] += tc.incrementMs;
      }

      const m = out.move;
      const legal = m && J.getLegalMoves(state).some((x) => x.from === m.from && x.to === m.to);
      if (!legal) {
        result = { winner: J.opp(side), reason: 'illegal-move', detail: `${players[side].id}: ${JSON.stringify(m)}` };
        break;
      }
      moves.push({ from: m.from, to: m.to });
      state = J.makeMove(state, m, { trusted: true });
    }

    return {
      seed, red, black, result, plies: state.ply, moves, stats,
      finalAscii: J.toAscii(state),
    };
  }

  /** Rebuild the final state (or any state) from a record – for replay/debugging. */
  function replay(J, record, upToPly = Infinity) {
    let s = J.createGame({ seed: record.seed });
    for (let i = 0; i < record.moves.length && i < upToPly; i++) s = J.makeMove(s, record.moves[i]);
    return s;
  }

  const api = { playGame, replay };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.JieqiArena = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
