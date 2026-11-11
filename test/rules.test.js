// Run: node test/rules.test.js – luật lặp nước (luật Trung Quốc)
const assert = require('assert');
const J = require('../engine');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/** Bàn cờ tự dựng (toàn quân đã lật). pieces: [x, y, side, type] */
function setup(pieces, turn = 'r', rules) {
  const s = J.createGame({ seed: 1, rules });
  s.board = s.board.map(() => null);
  for (const [x, y, side, type] of pieces) s.board[J.idx(x, y)] = { side, type, hidden: false, role: type };
  s.pools = { r: {}, b: {} };
  s.turn = turn;
  s.key = J.positionKey(s);
  s.rep = { key: s.key, from: -1, to: -1, prev: null, len: 1 };
  return s;
}
/** Đi một chuỗi nước dạng [[x1,y1,x2,y2], ...]; dừng nếu ván kết thúc. */
function play(s, seq) {
  for (const [a, b, c, d] of seq) {
    if (s.result) break;
    s = J.makeMove(s, { from: J.idx(a, b), to: J.idx(c, d) });
  }
  return s;
}
const repeat = (cycle, n) => Array.from({ length: n }, () => cycle).flat();

// Tướng đen d9 (3,0); Tướng đỏ e0 (4,9) – khác cột nên không lộ mặt; cột e trống nên Tướng đen không vào e9/e8
const KINGS = [[3, 0, 'b', 'K'], [4, 9, 'r', 'K']];
// Tướng đỏ f0 (5,9): cột e trống cho Tướng đen thoát → Xe không doạ bí được
const KINGS_FREE = [[3, 0, 'b', 'K'], [5, 9, 'r', 'K']];

const has = (s, a, b, c, d) => J.getLegalMoves(s).some((m) => m.from === J.idx(a, b) && m.to === J.idx(c, d));

test('chiếu dai (长将): nước chiếu lặp lần 3 bị cấm – bắt đổi nước', () => {
  let s = setup([...KINGS, [8, 2, 'r', 'R'], [0, 6, 'r', 'P']]);
  // Xe chiếu hàng 9 ↔ hàng 8, Tướng đen chạy d9 ↔ d8
  s = play(s, [[8, 2, 8, 0], [3, 0, 3, 1], [8, 0, 8, 1], [3, 1, 3, 0]]);
  assert.strictEqual(s.result, null);
  s = play(s, [[8, 1, 8, 0]]);
  const st = J.repetitionStatus(s);
  assert.strictEqual(st.count, 2, 'lần 2: chưa xử, có cảnh báo');
  assert.strictEqual(st.violators.r, 'perpetual-check');
  assert.strictEqual(st.violators.b, null);
  s = play(s, [[3, 0, 3, 1], [8, 0, 8, 1], [3, 1, 3, 0]]);
  // Đỏ chiếu tiếp i8→i9 sẽ lặp lần 3 → không được đi; các nước khác vẫn đi được
  assert.ok(!has(s, 8, 1, 8, 0), 'nước chiếu dai bị cấm');
  assert.ok(has(s, 8, 1, 8, 5), 'nước khác vẫn đi được');
  assert.throws(() => J.makeMove(s, { from: J.idx(8, 1), to: J.idx(8, 0) }), /Illegal move/);
  assert.deepStrictEqual(J.forbiddenMoves(s), [{ from: J.idx(8, 1), to: J.idx(8, 0), violation: 'perpetual-check' }]);
  assert.strictEqual(s.result, null);
  // tắt kiểm tra hợp lệ (trusted) mà vẫn đi → bên phạm luật thua
  const forced = J.makeMove(s, { from: J.idx(8, 1), to: J.idx(8, 0) }, { trusted: true });
  assert.deepStrictEqual(forced.result, { winner: 'b', reason: 'perpetual-check' });
});

test('đuổi bắt dai (长捉): Xe đuổi Mã không có căn → bị cấm đuổi tiếp', () => {
  // Mã đen nhảy c7 (2,2) ↔ a6 (0,3); Xe đỏ g7 (6,2) ↔ g6 (6,3) bắt theo
  let s = setup([...KINGS_FREE, [6, 4, 'r', 'R'], [2, 2, 'b', 'H'], [8, 6, 'r', 'P']]);
  s = play(s, [[6, 4, 6, 2], [2, 2, 0, 3], [6, 2, 6, 3], [0, 3, 2, 2], [6, 3, 6, 2], [2, 2, 0, 3], [6, 2, 6, 3], [0, 3, 2, 2]]);
  assert.strictEqual(s.result, null);
  assert.ok(!has(s, 6, 3, 6, 2), 'đuổi tiếp bị cấm');
  const st = J.repetitionStatus(J.makeMove(s, { from: J.idx(6, 3), to: J.idx(6, 2) }, { fast: true }));
  assert.strictEqual(st.violators.r, 'perpetual-chase');
  assert.deepStrictEqual(st.cycle.filter((c) => c.side === 'r').map((c) => c.kind), ['chase', 'chase']);
});

test('Xe "bắt" Mã có căn thật (ăn sẽ bị ăn lại) → nhàn', () => {
  const s = setup([...KINGS_FREE, [6, 4, 'r', 'R'], [2, 2, 'b', 'H'], [8, 6, 'r', 'P']]);
  const before = s.board.slice();
  const after = s.board.slice(); after[J.idx(6, 2)] = after[J.idx(6, 4)]; after[J.idx(6, 4)] = null;
  // quân bảo vệ Mã ở c7: Xe đen c9 (2,0) cùng cột
  before[J.idx(2, 0)] = after[J.idx(2, 0)] = { side: 'b', type: 'R', hidden: false, role: 'R' };
  assert.strictEqual(J.classifyMove(before, after, 'r', s.pools), 'idle', 'Xe bắt Mã có căn = nhàn');
  // bỏ quân bảo vệ thì thành bắt
  const b2 = before.slice(), a2 = after.slice(); b2[J.idx(2, 0)] = a2[J.idx(2, 0)] = null;
  assert.strictEqual(J.classifyMove(b2, a2, 'r', s.pools), 'chase');
});

test('Mã bắt Xe dù Xe có căn vẫn tính là bắt (quân rẻ bắt quân đắt)', () => {
  const s = setup([...KINGS_FREE, [0, 9, 'r', 'H'], [2, 5, 'b', 'R'], [2, 0, 'b', 'R']]);
  const before = s.board.slice();
  const after = s.board.slice(); after[J.idx(1, 7)] = after[J.idx(0, 9)]; after[J.idx(0, 9)] = null; // Mã a0 → b2, đe doạ c4 (2,5)
  assert.strictEqual(J.classifyMove(before, after, 'r', s.pools), 'chase');
});

test('Tướng đi bắt quân và bắt Tốt chưa qua sông không tính là bắt', () => {
  const s = setup([[4, 0, 'b', 'K'], [3, 9, 'r', 'K'], [8, 2, 'r', 'R'], [4, 8, 'b', 'H'], [0, 3, 'b', 'P']]);
  // Tướng đỏ d0 → d1 (3,8) đe doạ Mã đen e1 (4,8) không có căn – Tướng đi bắt: nhàn
  const before = s.board.slice();
  const after = s.board.slice(); after[J.idx(3, 8)] = after[J.idx(3, 9)]; after[J.idx(3, 9)] = null;
  assert.strictEqual(J.classifyMove(before, after, 'r', s.pools), 'idle');
  // đối chứng: Xe đi tới hàng 1 bắt cùng con Mã đó thì tính là bắt
  const after3 = s.board.slice(); after3[J.idx(8, 8)] = after3[J.idx(8, 2)]; after3[J.idx(8, 2)] = null;
  assert.strictEqual(J.classifyMove(before, after3, 'r', s.pools), 'chase');
  // Xe i7 → a7? (0,2) đe doạ Tốt đen a6 (0,3) chưa qua sông: nhàn
  const after2 = s.board.slice(); after2[J.idx(0, 2)] = after2[J.idx(8, 2)]; after2[J.idx(8, 2)] = null;
  assert.strictEqual(J.classifyMove(before, after2, 'r', s.pools), 'idle');
});

test('chiếu dai nặng hơn doạ bí dai: bên chiếu dai thua', () => {
  // Đen doạ bí Tướng đỏ (Xe a1 khoá hàng 1, Xe h5 chờ xuống hàng 0); Đỏ chiếu dai để cầm cự
  let s = setup([...KINGS, [8, 2, 'r', 'R'], [0, 8, 'b', 'R'], [7, 5, 'b', 'R'], [0, 6, 'r', 'P']]);
  s = play(s, [[8, 2, 8, 0], [3, 0, 3, 1], [8, 0, 8, 1], [3, 1, 3, 0], [8, 1, 8, 0], [3, 0, 3, 1], [8, 0, 8, 1], [3, 1, 3, 0]]);
  assert.ok(!has(s, 8, 1, 8, 0), 'Đỏ phải đổi nước');
  const v = J.repetitionStatus(J.makeMove(s, { from: J.idx(8, 1), to: J.idx(8, 0) }, { fast: true })).violators;
  assert.strictEqual(v.r, 'perpetual-check');
  assert.strictEqual(v.b, 'perpetual-mate-threat');
});

test('hai bên cùng đi nước nhàn lặp lại → hoà (lặp nước)', () => {
  let s = setup([...KINGS, [0, 6, 'r', 'P'], [8, 3, 'b', 'P']]);
  s = play(s, repeat([[4, 9, 4, 8], [3, 0, 3, 1], [4, 8, 4, 9], [3, 1, 3, 0]], 2));
  assert.deepStrictEqual(s.result, { winner: null, reason: 'repetition' });
});

test('luật lặp có thể tắt (rules.repetition = none)', () => {
  let s = setup([...KINGS, [8, 2, 'r', 'R'], [0, 6, 'r', 'P']], 'r', { repetition: 'none' });
  s = play(s, [[8, 2, 8, 0], ...repeat([[3, 0, 3, 1], [8, 0, 8, 1], [3, 1, 3, 0], [8, 1, 8, 0]], 3)]);
  assert.strictEqual(s.result, null);
});

test('60 hiệp không ăn/lật quân → hoà; ăn hoặc lật quân làm mới bộ đếm', () => {
  let s = J.createGame({ seed: 3, rules: { naturalLimit: 6 } });
  s = J.makeMove(s, { from: J.idx(0, 6), to: J.idx(0, 5) });   // lật quân
  assert.strictEqual(s.quietPlies, 0, 'lật quân làm mới bộ đếm');
  // từ đây chỉ đi quân đã lật / Tướng (không ăn, không lật)
  let s2 = setup([...KINGS_FREE, [0, 6, 'r', 'P'], [8, 3, 'b', 'P'], [0, 9, 'r', 'R'], [8, 0, 'b', 'R']], 'r', { naturalLimit: 6 });
  s2 = play(s2, [[0, 9, 0, 8], [8, 0, 8, 1], [0, 8, 0, 7], [8, 1, 8, 2], [0, 7, 1, 7], [8, 2, 7, 2]]);
  assert.deepStrictEqual(s2.result, { winner: null, reason: 'quiet-limit' });
});

(async () => {
  for (const [n, fn] of tests) { await fn(); console.log('✓', n); }
  console.log(`\n${tests.length} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
