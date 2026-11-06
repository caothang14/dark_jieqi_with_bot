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

test('thấy chiếu bí 1 nước', async () => {
  const s = board([[4, 0, 'b', 'K'], [3, 9, 'r', 'K'], [0, 1, 'r', 'R'], [8, 2, 'r', 'R']]);
  const r = await think('search:depth=2', s);
  assert.strictEqual(name(r.move), 'i7→i9');
  assert.ok(r.info.score > 900, `score ${r.info.score}`);
});

test('không ăn Tốt đang được Xe bảo vệ (thấy bị ăn lại)', async () => {
  // Xe đỏ a4 ăn được Tốt đen a6, nhưng Xe đen a9 ăn lại
  const s = board([[4, 0, 'b', 'K'], [3, 9, 'r', 'K'], [0, 5, 'r', 'R'], [0, 3, 'b', 'P'], [0, 0, 'b', 'R'], [8, 9, 'r', 'P']]);
  const greedy = await think('greedy', s);
  assert.strictEqual(name(greedy.move), 'a4→a6', 'bot tham ăn thì ăn');
  const r = await think('search:depth=2', s);
  assert.notStrictEqual(name(r.move), 'a4→a6');
});

test('ăn quân không được bảo vệ', async () => {
  const s = board([[4, 0, 'b', 'K'], [3, 9, 'r', 'K'], [0, 5, 'r', 'R'], [0, 2, 'b', 'H'], [8, 0, 'b', 'P']]);
  const r = await think('search:depth=2', s);
  assert.strictEqual(name(r.move), 'a4→a7');
});

test('tìm theo độ sâu cố định cho kết quả tái lập được', async () => {
  const s = J.createGame({ seed: 11 });
  const a = await think('search:depth=1', s);
  const b = await think('search:depth=1', s);
  assert.deepStrictEqual(a.move, b.move);
  assert.strictEqual(a.info.depth, 1);
});

test('tôn trọng giới hạn thời gian', async () => {
  const s = J.createGame({ seed: 12 });
  const t = performance.now();
  const r = await think('search:maxTimeMs=200', s);
  const ms = performance.now() - t;
  assert.ok(ms < 600, `mất ${ms.toFixed(0)}ms`);
  assert.ok(J.getLegalMoves(s).some((m) => m.from === r.move.from && m.to === r.move.to));
});

test('các phong cách bot đã đăng ký', () => {
  for (const id of ['search', 'search-fast', 'search-midgame', 'search-endgame']) assert.ok(bots.get(id), id);
  assert.strictEqual(bots.resolve('search-endgame').params['R.endgame'], 11);
});

(async () => {
  for (const [n, fn] of tests) { await fn(); console.log('✓', n); }
  console.log(`\n${tests.length} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
