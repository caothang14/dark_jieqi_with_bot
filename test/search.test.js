// Run: node test/search.test.js
const assert = require('assert');
const J = require('../engine');
const bots = require('../bots');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const board = (pieces, turn = 'r') => {
  const s = J.createGame({ seed: 1 });
  s.board = s.board.map(() => null);
  for (const [x, y, side, type] of pieces) s.board[J.idx(x, y)] = { side, type, hidden: false, role: type };
  s.pools = { r: {}, b: {} };
  s.turn = turn;
  return s;
};
const ctx = (side) => ({ side, random: () => 0.5, now: () => performance.now(), timeBudgetMs: 1000 });
const think = async (spec, s) => (await bots.resolve(spec).chooseMove(J.cloneState(s), J, ctx(s.turn)));
const name = (m) => `${J.squareName(m.from)}→${J.squareName(m.to)}`;

test('finds mate in 1', async () => {
  const s = board([[4, 0, 'b', 'K'], [3, 9, 'r', 'K'], [0, 1, 'r', 'R'], [8, 2, 'r', 'R']]);
  const r = await think('search:depth=2', s);
  assert.strictEqual(name(r.move), 'i7→i9');
  assert.ok(r.info.score > 900, `score ${r.info.score}`);
});

test('does not take a Pawn defended by a Rook (sees the recapture)', async () => {
  // Red Rook a4 can take Black Pawn a6, but Black Rook a9 recaptures
  const s = board([[4, 0, 'b', 'K'], [3, 9, 'r', 'K'], [0, 5, 'r', 'R'], [0, 3, 'b', 'P'], [0, 0, 'b', 'R'], [8, 9, 'r', 'P']]);
  const greedy = await think('greedy', s);
  assert.strictEqual(name(greedy.move), 'a4→a6', 'the greedy bot takes it');
  const r = await think('search:depth=2', s);
  assert.notStrictEqual(name(r.move), 'a4→a6');
});

test('takes an undefended piece', async () => {
  const s = board([[4, 0, 'b', 'K'], [3, 9, 'r', 'K'], [0, 5, 'r', 'R'], [0, 2, 'b', 'H'], [8, 0, 'b', 'P']]);
  const r = await think('search:depth=2', s);
  assert.strictEqual(name(r.move), 'a4→a7');
});

test('fixed-depth search is reproducible', async () => {
  const s = J.createGame({ seed: 11 });
  const a = await think('search:depth=1', s);
  const b = await think('search:depth=1', s);
  assert.deepStrictEqual(a.move, b.move);
  assert.strictEqual(a.info.depth, 1);
});

test('respects the time limit', async () => {
  const s = J.createGame({ seed: 12 });
  const t = performance.now();
  const r = await think('search:maxTimeMs=200', s);
  const ms = performance.now() - t;
  assert.ok(ms < 600, `took ${ms.toFixed(0)}ms`);
  assert.ok(J.getLegalMoves(s).some((m) => m.from === r.move.from && m.to === r.move.to));
});

test('Star2 (probing at chance nodes) gives exactly the same score as without probing', async () => {
  for (let g = 0; g < 4; g++) {
    let s = J.createGame({ seed: 40 + g });
    for (let i = 0; i < g * 10 && !s.result; i++) { const ms = J.getLegalMoves(s); s = J.makeMove(s, ms[(i * 7 + g) % ms.length]); }
    const base = 'search:depth=2,tt=false,lmr=false,nullMove=false';
    const a = await think(base + ',probe=true', s);
    const b = await think(base + ',probe=false', s);
    assert.strictEqual(a.info.score, b.info.score, `seed ${40 + g}`);
    assert.ok(a.info.nodes <= b.info.nodes, 'probing must reduce the node count');
  }
});

test('regression: does not miss capturing a Rook when the revealed piece hits the probe bound exactly', async () => {
  // Red's (hidden) Cannon takes the hidden piece on black's Horse square and is revealed as a Rook on b9; Black must recapture with the piece on a9
  let s = J.createGame({ seed: 15 });
  s = J.makeMove(s, { from: J.idx(1, 7), to: J.idx(1, 0) }, { revealAs: 'R', captureAs: 'H' });
  for (const spec of ['search:depth=1', 'search:depth=2']) {
    const r = await think(spec, s);
    assert.strictEqual(name(r.move), 'a9→b9', spec);
  }
});

test('repetition: the bot avoids perpetual check when it is the violator', async () => {
  // Black threatens mate (Rook a1 locks rank 1, Rook h5 waits to drop to rank 0). Red holds on with Rook checks, King d9 ↔ d8.
  let s = board([[3, 0, 'b', 'K'], [4, 9, 'r', 'K'], [8, 2, 'r', 'R'], [0, 8, 'b', 'R'], [7, 5, 'b', 'R'], [0, 6, 'r', 'P']]);
  s.k1 = null; s.key = J.positionKey(s); s.rep = { key: s.key, from: -1, to: -1, prev: null, len: 1 };
  const cycle = [[8, 2, 8, 0], [3, 0, 3, 1], [8, 0, 8, 1], [3, 1, 3, 0]];
  for (const [a, b, c, d] of cycle) s = J.makeMove(s, { from: J.idx(a, b), to: J.idx(c, d) });
  // After 1 cycle: checking again with i8→i9 is still legal (2nd repetition). A bot unaware of the rules keeps checking;
  // a bot aware of them knows it will be forced to deviate next cycle, so it deviates now.
  assert.strictEqual(name((await think('search:depth=2,repetition=false', s)).move), 'i8→i9');
  for (const spec of ['search:depth=2', 'search:depth=3']) {
    assert.notStrictEqual(name((await think(spec, s)).move), 'i8→i9', spec);
  }
  // After 2 cycles: the check repeating a 3rd time is outright forbidden
  for (const [a, b, c, d] of [[8, 1, 8, 0], [3, 0, 3, 1], [8, 0, 8, 1], [3, 1, 3, 0]]) s = J.makeMove(s, { from: J.idx(a, b), to: J.idx(c, d) });
  assert.deepStrictEqual(J.forbiddenMoves(s).map((m) => `${J.squareName(m.from)}→${J.squareName(m.to)}:${m.violation}`), ['i8→i9:perpetual-check']);
  const r = await think('search:depth=2,repetition=false', s);
  assert.notStrictEqual(name(r.move), 'i8→i9', 'even a bot unaware of the rules cannot pick a forbidden move');
});

test('bot styles are registered', () => {
  for (const id of ['search', 'search-fast', 'search-midgame', 'search-endgame', 'search-v4', 'search-v5']) assert.ok(bots.get(id), id);
  assert.strictEqual(bots.resolve('search').params.hiddenTrapped, 0.3);
  assert.strictEqual(bots.resolve('search-v5').params.hiddenTrapped, 0, 'reference keeps the old evaluation');
  assert.strictEqual(bots.resolve('search-endgame').params['R.endgame'], 11);
});

test('difficulty levels are registered in order', () => {
  assert.deepStrictEqual(bots.levels().map((l) => l.id), ['level-1', 'level-2', 'level-3', 'level-4']);
  assert.ok(bots.levels().every((l) => l.levelName && !l.hidden && l.baseId === 'search'));
  assert.strictEqual(bots.get('search').level, undefined, 'the base bot is not a level');
});

test('randomness: varies the move, but only among near-best moves', async () => {
  const s0 = J.createGame({ seed: 5 });
  const seen = new Set();
  for (let i = 0; i < 12; i++) {
    const c = { ...ctx('r'), random: bots.seededRandom(i) };
    const r = await bots.resolve('search:depth=1,randomness=1.5').chooseMove(J.cloneState(s0), J, c);
    seen.add(name(r.move));
  }
  assert.ok(seen.size > 1, 'should not always play the same move');
  // a free Rook (+9) is far above every alternative: even the easiest level always takes it
  const s = board([[4, 0, 'b', 'K'], [3, 9, 'r', 'K'], [0, 5, 'r', 'R'], [0, 2, 'b', 'R'], [8, 0, 'b', 'P'], [8, 9, 'r', 'P']]);
  for (let i = 0; i < 8; i++) {
    const r = await bots.resolve('level-1').chooseMove(J.cloneState(s), J, { ...ctx('r'), random: bots.seededRandom(i) });
    assert.strictEqual(name(r.move), 'a4→a7', `seed ${i}`);
  }
  // a mate is never thrown away
  const m = board([[4, 0, 'b', 'K'], [3, 9, 'r', 'K'], [0, 1, 'r', 'R'], [8, 2, 'r', 'R']]);
  for (let i = 0; i < 8; i++) {
    const r = await bots.resolve('level-2').chooseMove(J.cloneState(m), J, { ...ctx('r'), random: bots.seededRandom(i) });
    assert.strictEqual(name(r.move), 'i7→i9', `seed ${i}`);
  }
});

(async () => {
  for (const [n, fn] of tests) { await fn(); console.log('✓', n); }
  console.log(`\n${tests.length} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
