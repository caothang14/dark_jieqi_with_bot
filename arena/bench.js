#!/usr/bin/env node
/*
 * Benchmarks the engine and the search bot.   npm run bench   (or: node arena/bench.js search:lmr=false)
 *
 * - Timing of basic operations (move generation, check detection, evaluation).
 * - perft(3): number of legal 3-ply move sequences (with fixed reveal outcomes) – used to catch
 *   accidental rule changes while optimising the engine: a correct optimisation keeps the numbers unchanged.
 * - The search bot at fixed depths on 6 positions (opening → middlegame): time, nodes, nodes/ms.
 */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');
const J = require(path.join(ROOT, 'engine'));
const B = require(path.join(ROOT, 'bots'));
const E = B.lib.eval;

const spec = process.argv[2] || 'search';
const depths = (process.argv[3] || '1,2,3').split(',').map(Number);

const time = (f, n) => { const a = performance.now(); for (let i = 0; i < n; i++) f(); return ((performance.now() - a) / n) * 1000; };

// 6 fixed positions: after 0, 12, 24, ... plies
const positions = [];
for (let g = 0; g < 6; g++) {
  let s = J.createGame({ seed: g });
  for (let i = 0; i < g * 12 && !s.result; i++) { const ms = J.getLegalMoves(s); s = J.makeMove(s, ms[(i * 7 + g) % ms.length]); }
  positions.push(s);
}
const avg = (f, n) => positions.reduce((a, s) => a + time(() => f(s), n), 0) / positions.length;

console.log('Basic operations (average over 6 positions)');
console.log(`  getLegalMoves      ${avg((s) => J.getLegalMoves(s), 500).toFixed(1)} µs`);
console.log(`  captures only      ${avg((s) => J.getLegalMoves(s, { capturesOnly: true }), 500).toFixed(1)} µs`);
console.log(`  isInCheck          ${avg((s) => J.isInCheck(s), 3000).toFixed(2)} µs`);
console.log(`  evaluate           ${avg((s) => E.evaluate(s, J, s.turn), 2000).toFixed(1)} µs`);
console.log(`  makeMove (fast)    ${avg((s) => J.makeMove(s, J.getLegalMoves(s)[0], { fast: true }), 500).toFixed(1)} µs  (includes 1 move generation)`);

function perft(s, d) {
  if (d === 0) return 1;
  let n = 0;
  for (const m of J.getLegalMoves(s)) {
    const opts = { fast: true };
    const p = s.board[m.from], t = s.board[m.to];
    const first = (side) => Object.keys(s.pools[side]).find((k) => s.pools[side][k] > 0);
    if (p.hidden) opts.revealAs = first(p.side);
    if (t && t.hidden) opts.captureAs = first(t.side);
    n += perft(J.makeMove(s, m, opts), d - 1);
  }
  return n;
}
// perft on positions built from fixed move sequences (independent of move generation order)
const perftPositions = [J.createGame({ seed: 1 })];
{
  let s = J.createGame({ seed: 1 });
  for (const [a, b, c, d] of [[1, 7, 1, 0], [0, 0, 1, 0], [7, 7, 7, 0], [8, 0, 7, 0]]) {
    s = J.makeMove(s, { from: J.idx(a, b), to: J.idx(c, d) }, { revealAs: Object.keys(s.pools[s.turn]).find((k) => s.pools[s.turn][k] > 0), fast: true });
    perftPositions.push(s);
  }
}
let t0 = performance.now();
const pf = perftPositions.map((s) => perft(s, 3));
console.log(`\nperft(3): ${pf.join(', ')}   (${(performance.now() - t0).toFixed(0)} ms)`);

(async () => {
  console.log(`\nBot "${spec}" – fixed depth on 6 positions`);
  for (const d of depths) {
    const a = performance.now();
    let nodes = 0;
    const moves = [];
    for (const s of positions) {
      const r = await B.resolve(`${spec}${spec.includes(':') ? ',' : ':'}depth=${d}`)
        .chooseMove(J.cloneState(s), J, { side: s.turn, random: () => 0.5, now: () => performance.now() });
      nodes += r.info.nodes;
      moves.push(`${J.squareName(r.move.from)}${J.squareName(r.move.to)}`);
    }
    const ms = performance.now() - a;
    console.log(`  depth=${d}  ${ms.toFixed(0).padStart(7)} ms  ${String(nodes).padStart(9)} nodes  ${(nodes / ms).toFixed(0).padStart(4)} nodes/ms   ${moves.join(' ')}`);
  }
})();
