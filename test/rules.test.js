// Run: node test/rules.test.js – repetition rules (Chinese rules)
const assert = require('assert');
const J = require('../engine');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/** Hand-built board (all pieces revealed). pieces: [x, y, side, type] */
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
/** Play a sequence of moves [[x1,y1,x2,y2], ...]; stop if the game ends. */
function play(s, seq) {
  for (const [a, b, c, d] of seq) {
    if (s.result) break;
    s = J.makeMove(s, { from: J.idx(a, b), to: J.idx(c, d) });
  }
  return s;
}
const repeat = (cycle, n) => Array.from({ length: n }, () => cycle).flat();

// Black King d9 (3,0); Red King e0 (4,9) – different files so no flying general; file e is open, so the Black King cannot step to e9/e8 (flying general)
const KINGS = [[3, 0, 'b', 'K'], [4, 9, 'r', 'K']];
// Red King f0 (5,9): file e is free for the Black King to escape → the Rook cannot threaten mate
const KINGS_FREE = [[3, 0, 'b', 'K'], [5, 9, 'r', 'K']];

const has = (s, a, b, c, d) => J.getLegalMoves(s).some((m) => m.from === J.idx(a, b) && m.to === J.idx(c, d));

test('perpetual check (长将): the check repeating a 3rd time is forbidden – must deviate', () => {
  let s = setup([...KINGS, [8, 2, 'r', 'R'], [0, 6, 'r', 'P']]);
  // Rook checks on rank 9 ↔ rank 8, Black King runs d9 ↔ d8
  s = play(s, [[8, 2, 8, 0], [3, 0, 3, 1], [8, 0, 8, 1], [3, 1, 3, 0]]);
  assert.strictEqual(s.result, null);
  s = play(s, [[8, 1, 8, 0]]);
  const st = J.repetitionStatus(s);
  assert.strictEqual(st.count, 2, '2nd time: no ruling yet, just a warning');
  assert.strictEqual(st.violators.r, 'perpetual-check');
  assert.strictEqual(st.violators.b, null);
  s = play(s, [[3, 0, 3, 1], [8, 0, 8, 1], [3, 1, 3, 0]]);
  // Red checking again with i8→i9 would repeat a 3rd time → not allowed; other moves still are
  assert.ok(!has(s, 8, 1, 8, 0), 'perpetual check move is forbidden');
  assert.ok(has(s, 8, 1, 8, 5), 'other moves are still allowed');
  assert.throws(() => J.makeMove(s, { from: J.idx(8, 1), to: J.idx(8, 0) }), /Illegal move/);
  assert.deepStrictEqual(J.forbiddenMoves(s), [{ from: J.idx(8, 1), to: J.idx(8, 0), violation: 'perpetual-check' }]);
  assert.strictEqual(s.result, null);
  // skip the legality check (trusted) and play it anyway → the violator loses
  const forced = J.makeMove(s, { from: J.idx(8, 1), to: J.idx(8, 0) }, { trusted: true });
  assert.deepStrictEqual(forced.result, { winner: 'b', reason: 'perpetual-check' });
});

test('perpetual chase (长捉): Rook chasing an undefended Horse → further chasing is forbidden', () => {
  // Black Horse jumps c7 (2,2) ↔ a6 (0,3); Red Rook g7 (6,2) ↔ g6 (6,3) follows it
  let s = setup([...KINGS_FREE, [6, 4, 'r', 'R'], [2, 2, 'b', 'H'], [8, 6, 'r', 'P']]);
  s = play(s, [[6, 4, 6, 2], [2, 2, 0, 3], [6, 2, 6, 3], [0, 3, 2, 2], [6, 3, 6, 2], [2, 2, 0, 3], [6, 2, 6, 3], [0, 3, 2, 2]]);
  assert.strictEqual(s.result, null);
  assert.ok(!has(s, 6, 3, 6, 2), 'chasing again is forbidden');
  const st = J.repetitionStatus(J.makeMove(s, { from: J.idx(6, 3), to: J.idx(6, 2) }, { fast: true }));
  assert.strictEqual(st.violators.r, 'perpetual-chase');
  assert.deepStrictEqual(st.cycle.filter((c) => c.side === 'r').map((c) => c.kind), ['chase', 'chase']);
});

test('Rook "attacking" a truly defended Horse (would be recaptured) → idle', () => {
  const s = setup([...KINGS_FREE, [6, 4, 'r', 'R'], [2, 2, 'b', 'H'], [8, 6, 'r', 'P']]);
  const before = s.board.slice();
  const after = s.board.slice(); after[J.idx(6, 2)] = after[J.idx(6, 4)]; after[J.idx(6, 4)] = null;
  // defender of the Horse on c7: Black Rook c9 (2,0) on the same file
  before[J.idx(2, 0)] = after[J.idx(2, 0)] = { side: 'b', type: 'R', hidden: false, role: 'R' };
  assert.strictEqual(J.classifyMove(before, after, 'r', s.pools), 'idle', 'Rook attacking a defended Horse = idle');
  // remove the defender and it becomes a chase
  const b2 = before.slice(), a2 = after.slice(); b2[J.idx(2, 0)] = a2[J.idx(2, 0)] = null;
  assert.strictEqual(J.classifyMove(b2, a2, 'r', s.pools), 'chase');
});

test('Horse attacking a Rook counts as a chase even if the Rook is defended (cheap piece attacks expensive one)', () => {
  const s = setup([...KINGS_FREE, [0, 9, 'r', 'H'], [2, 5, 'b', 'R'], [2, 0, 'b', 'R']]);
  const before = s.board.slice();
  const after = s.board.slice(); after[J.idx(1, 7)] = after[J.idx(0, 9)]; after[J.idx(0, 9)] = null; // Horse a0 → b2, attacks c4 (2,5)
  assert.strictEqual(J.classifyMove(before, after, 'r', s.pools), 'chase');
});

test('King attacking, and attacking an uncrossed Pawn, do not count as a chase', () => {
  const s = setup([[4, 0, 'b', 'K'], [3, 9, 'r', 'K'], [8, 2, 'r', 'R'], [4, 8, 'b', 'H'], [0, 3, 'b', 'P']]);
  // Red King d0 → d1 (3,8) attacks the undefended Black Horse e1 (4,8) – King attacking: idle
  const before = s.board.slice();
  const after = s.board.slice(); after[J.idx(3, 8)] = after[J.idx(3, 9)]; after[J.idx(3, 9)] = null;
  assert.strictEqual(J.classifyMove(before, after, 'r', s.pools), 'idle');
  // control: a Rook moving to rank 1 attacking the same Horse counts as a chase
  const after3 = s.board.slice(); after3[J.idx(8, 8)] = after3[J.idx(8, 2)]; after3[J.idx(8, 2)] = null;
  assert.strictEqual(J.classifyMove(before, after3, 'r', s.pools), 'chase');
  // Rook i7 → a7? (0,2) attacks the uncrossed Black Pawn a6 (0,3): idle
  const after2 = s.board.slice(); after2[J.idx(0, 2)] = after2[J.idx(8, 2)]; after2[J.idx(8, 2)] = null;
  assert.strictEqual(J.classifyMove(before, after2, 'r', s.pools), 'idle');
});

test('perpetual check outranks perpetual mate threat: the checking side loses', () => {
  // Black threatens mate (Rook a1 locks rank 1, Rook h5 waits to drop to rank 0); Red checks perpetually to hold on
  let s = setup([...KINGS, [8, 2, 'r', 'R'], [0, 8, 'b', 'R'], [7, 5, 'b', 'R'], [0, 6, 'r', 'P']]);
  s = play(s, [[8, 2, 8, 0], [3, 0, 3, 1], [8, 0, 8, 1], [3, 1, 3, 0], [8, 1, 8, 0], [3, 0, 3, 1], [8, 0, 8, 1], [3, 1, 3, 0]]);
  assert.ok(!has(s, 8, 1, 8, 0), 'Red must deviate');
  const v = J.repetitionStatus(J.makeMove(s, { from: J.idx(8, 1), to: J.idx(8, 0) }, { fast: true })).violators;
  assert.strictEqual(v.r, 'perpetual-check');
  assert.strictEqual(v.b, 'perpetual-mate-threat');
});

test('both sides repeat idle moves → draw (repetition)', () => {
  let s = setup([...KINGS, [0, 6, 'r', 'P'], [8, 3, 'b', 'P']]);
  s = play(s, repeat([[4, 9, 4, 8], [3, 0, 3, 1], [4, 8, 4, 9], [3, 1, 3, 0]], 2));
  assert.deepStrictEqual(s.result, { winner: null, reason: 'repetition' });
});

test('repetition rules can be turned off (rules.repetition = none)', () => {
  let s = setup([...KINGS, [8, 2, 'r', 'R'], [0, 6, 'r', 'P']], 'r', { repetition: 'none' });
  s = play(s, [[8, 2, 8, 0], ...repeat([[3, 0, 3, 1], [8, 0, 8, 1], [3, 1, 3, 0], [8, 1, 8, 0]], 3)]);
  assert.strictEqual(s.result, null);
});

test('60 moves without capture/reveal → draw; a capture or reveal resets the counter', () => {
  let s = J.createGame({ seed: 3, rules: { naturalLimit: 6 } });
  s = J.makeMove(s, { from: J.idx(0, 6), to: J.idx(0, 5) });   // reveal
  assert.strictEqual(s.quietPlies, 0, 'a reveal resets the counter');
  // from here on only move revealed pieces / Kings (no captures, no reveals)
  let s2 = setup([...KINGS_FREE, [0, 6, 'r', 'P'], [8, 3, 'b', 'P'], [0, 9, 'r', 'R'], [8, 0, 'b', 'R']], 'r', { naturalLimit: 6 });
  s2 = play(s2, [[0, 9, 0, 8], [8, 0, 8, 1], [0, 8, 0, 7], [8, 1, 8, 2], [0, 7, 1, 7], [8, 2, 7, 2]]);
  assert.deepStrictEqual(s2.result, { winner: null, reason: 'quiet-limit' });
});

(async () => {
  for (const [n, fn] of tests) { await fn(); console.log('✓', n); }
  console.log(`\n${tests.length} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
