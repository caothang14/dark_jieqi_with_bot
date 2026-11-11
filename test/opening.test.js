// Run: node test/opening.test.js – reveal priority order
const assert = require('assert');
const J = require('../engine');
const bots = require('../bots');
const OP = bots.lib.opening;
const E = bots.lib.eval;

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const sq = (name) => J.idx('abcdefghi'.indexOf(name[0]), 9 - Number(name[1]));
const mv = (a, b) => ({ from: sq(a), to: sq(b) });

test('priority table in the starting position (Red)', () => {
  const s = J.createGame({ seed: 1 });
  const rank = (a, b) => OP.revealRank(s, J, mv(a, b));
  assert.strictEqual(rank('a3', 'a4'), 1, 'edge Pawn');
  assert.strictEqual(rank('i3', 'i4'), 1);
  assert.strictEqual(rank('c3', 'c4'), 2, 'Pawn on file 3/7');
  assert.strictEqual(rank('e3', 'e4'), 3, 'centre Pawn');
  assert.strictEqual(rank('d0', 'e1'), 4, 'Advisor to palace centre');
  assert.strictEqual(rank('c0', 'e2'), 4, 'Elephant to the centre');
  assert.strictEqual(rank('b0', 'c2'), 5, 'Horse');
  assert.strictEqual(rank('c0', 'a2'), 6, 'Elephant to the edge');
  assert.strictEqual(rank('b2', 'b6'), 7, 'Cannon straight forward');
  assert.strictEqual(rank('b2', 'e2'), 8, 'Cannon sideways');
  assert.strictEqual(rank('a0', 'a1'), 9, 'Xe');
  assert.strictEqual(rank('b2', 'b9'), 0, 'a capture is not a "plain reveal" move');
});

test('priority table for Black (opposite forward direction)', () => {
  let s = J.createGame({ seed: 1 });
  s = J.makeMove(s, mv('a3', 'a4'));
  assert.strictEqual(OP.revealRank(s, J, mv('b7', 'b3')), 7, 'black Cannon straight forward');
  assert.strictEqual(OP.revealRank(s, J, mv('b7', 'b8')), 8, 'black Cannon backwards');
  assert.strictEqual(OP.revealRank(s, J, mv('i6', 'i5')), 1, 'black edge Pawn');
});

test('ordering: at the root, the first plain reveal move is an edge Pawn', async () => {
  const s = J.createGame({ seed: 1 });
  const r = await bots.resolve('search:depth=1,openingOrder=true,revealTopKRoot=1').chooseMove(J.cloneState(s), J,
    { side: 'r', random: () => 0.5, now: () => performance.now() });
  // only 1 reveal move (edge Pawn) + the captures remain at the root
  const name = J.squareName(r.move.from) + J.squareName(r.move.to);
  assert.ok(['a3a4', 'i3i4', 'b2b9', 'h2h9'].includes(name), name);
});

test('pruning reveal moves still considers every capture', async () => {
  // red (hidden) Cannon can capture the hidden piece on black's Horse square – the capture is kept even with a tiny revealTopKRoot
  const s = J.createGame({ seed: 1 });
  const p = bots.resolve('search:depth=2,openingOrder=true,revealTopK=1,revealTopKRoot=1');
  const r = await p.chooseMove(J.cloneState(s), J, { side: 'r', random: () => 0.5, now: () => performance.now() });
  // the bot's move must be the capture (Cannon takes hidden Horse) – i.e. the capture was considered
  assert.ok(s.board[r.move.to], `bot chose ${J.squareName(r.move.from)}${J.squareName(r.move.to)}, not a capture`);
});

test('development score: balanced at the start, revealing an edge Pawn earns more than revealing a Rook', () => {
  const w = E.resolveWeights({ development: 0.3 });
  const s = J.createGame({ seed: 2 });
  assert.ok(Math.abs(E.evaluate(s, J, 'r', w)) < 1e-9);
  assert.ok(Math.abs(E.evaluate(s, J, 'r', w) - E.explain(s, J, 'r', w).score) < 1e-9, 'evaluate = explain');
  const pawn = J.makeMove(s, mv('a3', 'a4'), { revealAs: 'P' });
  const rook = J.makeMove(s, mv('a0', 'a1'), { revealAs: 'P' });
  // both revealed as a Pawn: revealing on the edge-Pawn square gains more development than on the Rook square
  const gain = (st) => E.evaluate(st, J, 'r', w) - E.evaluate(st, J, 'r', E.resolveWeights({}));
  assert.ok(gain(pawn) > gain(rook));
});

(async () => {
  for (const [n, fn] of tests) { await fn(); console.log('✓', n); }
  console.log(`\n${tests.length} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
