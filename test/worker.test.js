// Run: node test/worker.test.js – the bot Web Worker source (bots/worker.js) runs standalone
const assert = require('assert');
const vm = require('vm');
const J = require('../engine');
const bots = require('../bots');
require('../bots/worker');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/** Runs the worker source in a fresh VM context (no require, no access to this process' globals). */
function fakeWorker() {
  const out = [];
  const ctx = vm.createContext({ performance, console, postMessage: (m) => out.push(JSON.parse(JSON.stringify(m))) });
  vm.runInContext('globalThis.self = globalThis;', ctx);
  vm.runInContext(globalThis.JieqiBotWorker.buildSource(globalThis.JieqiSources), ctx);
  const send = async (msg) => {
    const n = out.length;
    await ctx.onmessage({ data: JSON.parse(JSON.stringify(msg)) });
    return out.slice(n);
  };
  return { out, send };
}

test('every bot file is captured as a module (so it can run in the worker)', () => {
  const w = fakeWorker();
  assert.ok(w.out[0].ready);
  const inWorker = new Set(w.out[0].bots);
  for (const b of bots.list()) assert.ok(inWorker.has(b.id), `${b.id} missing from the worker`);
});

test('the worker plays the same move as the main thread (fixed depth)', async () => {
  const w = fakeWorker();
  const s = J.createGame({ seed: 3 });
  const ctx = { side: 'r', ply: 0, timeBudgetMs: 1000, clock: null, history: [] };
  const [res] = await w.send({ id: 1, type: 'move', spec: 'search:depth=2', state: J.cloneState(s), ctx });
  assert.ok(res.ok, res.error);
  const local = await bots.resolve('search:depth=2').chooseMove(J.cloneState(s), J, { ...ctx, random: () => 0.5, now: () => performance.now() });
  assert.deepStrictEqual(res.result.move, local.move);
  assert.strictEqual(res.result.info.nodes, local.info.nodes);
});

test('the worker answers draw offers and reports errors', async () => {
  const w = fakeWorker();
  const s = J.createGame({ seed: 3 });
  const ctx = { side: 'b', ply: 0, timeBudgetMs: 100, clock: null, history: [] };
  const [d] = await w.send({ id: 2, type: 'draw', spec: 'level-2', state: s, ctx });
  assert.ok(d.ok && typeof d.result === 'boolean');
  const [e] = await w.send({ id: 3, type: 'move', spec: 'no-such-bot', state: s, ctx });
  assert.ok(!e.ok && /No bot/.test(e.error));
});

(async () => {
  for (const [n, fn] of tests) { await fn(); console.log('✓', n); }
  console.log(`\n${tests.length} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
