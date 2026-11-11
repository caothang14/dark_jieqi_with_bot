// Run: node test/bots.test.js
const assert = require('assert');
const J = require('../engine');
const bots = require('../bots');
const { playGame, replay } = require('../arena/match');

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('✓', name); };

(async () => {
  await test('registry loads bots from manifest', () => {
    const ids = bots.list().map((b) => b.id);
    assert.ok(ids.includes('random') && ids.includes('greedy'));
  });

  await test('resolve merges params from spec string', () => {
    const p = bots.resolve('greedy:revealBonus=2,foo=bar,flag');
    assert.deepStrictEqual(p.params, { revealBonus: 2, drawThreshold: 0, foo: 'bar', flag: true });
    assert.throws(() => bots.resolve('nope'), /No bot/);
  });

  await test('variant inherits base and overrides params', () => {
    bots.variant('greedy', { id: 'test-greedy-v', params: { revealBonus: 5 } });
    const p = bots.resolve('test-greedy-v');
    assert.strictEqual(p.params.revealBonus, 5);
    assert.strictEqual(p.def.baseId, 'greedy');
  });

  await test('chooseMove normalizes plain move and {move, info}', async () => {
    const s = J.createGame({ seed: 1 });
    const ctx = { side: 'r', random: bots.seededRandom(1), now: Date.now };
    const a = await bots.resolve('random').chooseMove(s, J, ctx);
    const b = await bots.resolve('greedy').chooseMove(s, J, ctx);
    assert.ok(a.move && typeof a.move.from === 'number');
    assert.strictEqual(b.info.depth, 1);
  });

  await test('playGame is reproducible and replayable', async () => {
    const r1 = await playGame({ J, bots, seed: 5, red: 'greedy', black: 'random' });
    const r2 = await playGame({ J, bots, seed: 5, red: 'greedy', black: 'random' });
    assert.deepStrictEqual(r1.moves, r2.moves);
    assert.strictEqual(J.toAscii(replay(J, r1)), r1.finalAscii);
  });

  await test('illegal move and exceptions lose the game', async () => {
    bots.register({ id: 'test-illegal', chooseMove: () => ({ from: 0, to: 80 }) });
    bots.register({ id: 'test-crash', chooseMove: () => { throw new Error('boom'); } });
    const a = await playGame({ J, bots, seed: 1, red: 'test-illegal', black: 'random' });
    assert.deepStrictEqual([a.result.winner, a.result.reason], ['b', 'illegal-move']);
    const b = await playGame({ J, bots, seed: 1, red: 'random', black: 'test-crash' });
    assert.deepStrictEqual([b.result.winner, b.result.reason], ['r', 'bot-error']);
  });

  await test('async bots work and timeout is enforced with a clock', async () => {
    bots.register({
      id: 'test-slow',
      chooseMove: (s, J2) => new Promise((r) => setTimeout(() => r(J2.getLegalMoves(s)[0]), 30)),
    });
    const g = await playGame({ J, bots, seed: 2, red: 'test-slow', black: 'random', tc: { initialMs: 100, incrementMs: 0 } });
    assert.deepStrictEqual([g.result.winner, g.result.reason], ['b', 'timeout']);
  });

  await test('greedy beats random clearly', async () => {
    let score = 0;
    for (let seed = 1; seed <= 10; seed++) {
      for (const aRed of [true, false]) {
        const g = await playGame({ J, bots, seed, red: aRed ? 'greedy' : 'random', black: aRed ? 'random' : 'greedy' });
        const aSide = aRed ? 'r' : 'b';
        score += !g.result.winner ? 0.5 : g.result.winner === aSide ? 1 : 0;
      }
    }
    assert.ok(score >= 16, `greedy score ${score}/20`);
  });

  console.log(`\n${passed} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
