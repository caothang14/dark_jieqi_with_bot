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

test('Star2 (thăm dò ở nút may rủi) cho đúng cùng điểm với khi không thăm dò', async () => {
  for (let g = 0; g < 4; g++) {
    let s = J.createGame({ seed: 40 + g });
    for (let i = 0; i < g * 10 && !s.result; i++) { const ms = J.getLegalMoves(s); s = J.makeMove(s, ms[(i * 7 + g) % ms.length]); }
    const base = 'search:depth=2,tt=false,lmr=false,nullMove=false';
    const a = await think(base + ',probe=true', s);
    const b = await think(base + ',probe=false', s);
    assert.strictEqual(a.info.score, b.info.score, `seed ${40 + g}`);
    assert.ok(a.info.nodes <= b.info.nodes, 'thăm dò phải giảm số nút');
  }
});

test('hồi quy: không bỏ qua nước ăn Xe khi quân lật chạm đúng cận thăm dò', async () => {
  // Đỏ dùng Pháo (úp) ăn quân úp ở ô Mã đen và lật ra Xe ở b9; Đen phải ăn lại Xe bằng quân ở a9
  let s = J.createGame({ seed: 15 });
  s = J.makeMove(s, { from: J.idx(1, 7), to: J.idx(1, 0) }, { revealAs: 'R', captureAs: 'H' });
  for (const spec of ['search:depth=1', 'search:depth=2']) {
    const r = await think(spec, s);
    assert.strictEqual(name(r.move), 'a9→b9', spec);
  }
});

test('luật lặp: bot không chiếu dai khi mình là bên phạm luật', async () => {
  // Đen doạ bí (Xe a1 khoá hàng 1, Xe h5 chờ xuống hàng 0). Đỏ cầm cự bằng Xe chiếu Tướng d9 ↔ d8.
  let s = board([[3, 0, 'b', 'K'], [4, 9, 'r', 'K'], [8, 2, 'r', 'R'], [0, 8, 'b', 'R'], [7, 5, 'b', 'R'], [0, 6, 'r', 'P']]);
  s.k1 = null; s.key = J.positionKey(s); s.rep = { key: s.key, from: -1, to: -1, prev: null, len: 1 };
  const cycle = [[8, 2, 8, 0], [3, 0, 3, 1], [8, 0, 8, 1], [3, 1, 3, 0]];
  for (const [a, b, c, d] of cycle) s = J.makeMove(s, { from: J.idx(a, b), to: J.idx(c, d) });
  // Sau 1 vòng: chiếu tiếp i8→i9 vẫn hợp lệ (lặp lần 2). Bot không hiểu luật thì chiếu tiếp,
  // bot hiểu luật biết vòng sau sẽ bị buộc đổi nước nên đổi ngay.
  assert.strictEqual(name((await think('search:depth=2,repetition=false', s)).move), 'i8→i9');
  for (const spec of ['search:depth=2', 'search:depth=3']) {
    assert.notStrictEqual(name((await think(spec, s)).move), 'i8→i9', spec);
  }
  // Sau 2 vòng: nước chiếu lặp lần 3 bị cấm hẳn
  for (const [a, b, c, d] of [[8, 1, 8, 0], [3, 0, 3, 1], [8, 0, 8, 1], [3, 1, 3, 0]]) s = J.makeMove(s, { from: J.idx(a, b), to: J.idx(c, d) });
  assert.deepStrictEqual(J.forbiddenMoves(s).map((m) => `${J.squareName(m.from)}→${J.squareName(m.to)}:${m.violation}`), ['i8→i9:perpetual-check']);
  const r = await think('search:depth=2,repetition=false', s);
  assert.notStrictEqual(name(r.move), 'i8→i9', 'kể cả bot không hiểu luật cũng không được chọn nước bị cấm');
});

test('các phong cách bot đã đăng ký', () => {
  for (const id of ['search', 'search-fast', 'search-midgame', 'search-endgame']) assert.ok(bots.get(id), id);
  assert.strictEqual(bots.resolve('search-endgame').params['R.endgame'], 11);
});

(async () => {
  for (const [n, fn] of tests) { await fn(); console.log('✓', n); }
  console.log(`\n${tests.length} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
