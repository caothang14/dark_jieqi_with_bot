/*
 * Bot registry – works both in the browser (window.JieqiBots) and in Node (globalThis.JieqiBots).
 *
 * ── Defining a bot ──────────────────────────────────────────────────────────────────
 *   JieqiBots.register({
 *     id: 'greedy',                       // unique, a-z0-9-
 *     name: 'Bot tham ăn',                // display name
 *     description: '...',
 *     params: { captureWeight: 1 },       // default params (can be overridden when picking the bot)
 *     chooseMove(state, J, ctx) { ... },  // REQUIRED. Returns {from,to} or { move:{from,to}, info:{ score, depth, nodes, pv } }
 *                                         // May return a Promise (Web Worker, HTTP call to a bot service...)
 *     acceptDraw(state, J, ctx) { ... },  // optional, returns a boolean (or Promise<boolean>)
 *     hidden: true,                       // optional: hide from the UI (reference bot for the arena)
 *   });
 *
 * ── Variants (same algorithm, different params) ────────────────────────────────────
 *   JieqiBots.variant('greedy', { id: 'greedy-safe', name: 'Tham ăn (cẩn thận)', params: { ... } });
 *   Or pick one quickly with a string: 'greedy:captureWeight=2,revealBonus=0'
 *   Difficulty levels (bots/levels.js) are variants with `level: 1..4` and `levelName`; JieqiBots.levels() lists them.
 *
 * ── ctx passed to the bot (created by the host = UI or arena) ──────────────────────
 *   side          'r' | 'b'   the side the bot plays
 *   ply           number of plies played so far
 *   params        merged params (defaults + overrides)
 *   random()      random number in [0,1) – seeded in the arena so games are reproducible. Bots should NOT use Math.random
 *   now()         current time (ms)
 *   timeBudgetMs  time the bot should spend on this move
 *   deadline      now() + timeBudgetMs – a search bot should stop before this
 *   clock         null or { myTimeMs, oppTimeMs, incrementMs }
 *   history       array of moves played so far [{from,to}] (for repetition avoidance, opening book…)
 *
 * Every bot file is wrapped in JieqiBots.module(function (root) { ... }); so that it can also run in the
 * bot Web Worker (bots/worker.js) and not freeze the UI.
 *
 * A bot must not modify `state` (the host always passes a copy), and it can never see what a hidden piece is,
 * because the engine only decides the identity at reveal time.
 */
(function (factory) {
  // The factory is also kept as source text for the bot Web Worker (bots/worker.js).
  (globalThis.JieqiSources = globalThis.JieqiSources || []).push({ name: 'bots/registry.js', factory });
  factory(globalThis);
})(function (root) {
  'use strict';
  if (root.JieqiBots && root.JieqiBots.register) return; // already loaded

  const defs = new Map(); // id -> definition

  function register(def) {
    if (!def || !/^[a-z0-9-]+$/.test(def.id || '')) throw new Error(`Invalid bot id: ${def && def.id}`);
    if (typeof def.chooseMove !== 'function') throw new Error(`Bot ${def.id} is missing chooseMove()`);
    defs.set(def.id, { params: {}, description: '', ...def, name: def.name || def.id });
    return def;
  }

  /** extra fields (e.g. `level`, `levelName`) are kept on the variant; `hidden` and `level` are not inherited. */
  function variant(baseId, { id, name, description, params, hidden, ...extra }) {
    const base = defs.get(baseId);
    if (!base) throw new Error(`No such base bot: ${baseId}`);
    return register({
      ...base, level: undefined, levelName: undefined, ...extra, id, name: name || id,
      description: description || base.description,
      params: { ...base.params, ...params }, baseId, hidden: !!hidden,
    });
  }

  function parseParams(str) {
    const out = {};
    if (!str) return out;
    for (const pair of str.split(',')) {
      const [k, v = 'true'] = pair.split('=').map((x) => x.trim());
      if (!k) continue;
      out[k] = v === 'true' ? true : v === 'false' ? false : isNaN(Number(v)) ? v : Number(v);
    }
    return out;
  }

  /**
   * 'greedy' or 'greedy:captureWeight=2' -> a ready-to-use "player":
   * { id, name, params, chooseMove(state, J, ctx), acceptDraw(state, J, ctx) }
   * chooseMove always returns Promise<{ move, info }>.
   */
  function resolve(spec) {
    const [id, query] = String(spec).split(/:(.*)/s);
    const def = defs.get(id);
    if (!def) throw new Error(`No bot "${id}". Available: ${[...defs.keys()].join(', ')}`);
    const params = { ...def.params, ...parseParams(query) };
    return {
      id: spec,
      name: def.name + (query ? ` (${query})` : ''),
      def,
      params,
      async chooseMove(state, J, ctx) {
        const out = await def.chooseMove(state, J, { ...ctx, params });
        if (!out) return { move: null, info: {} };
        return out.move ? { move: out.move, info: out.info || {} } : { move: out, info: {} };
      },
      async acceptDraw(state, J, ctx) {
        return def.acceptDraw ? !!(await def.acceptDraw(state, J, { ...ctx, params })) : false;
      },
    };
  }

  /** Suggested time for one move when a clock is used: ~1/30 of the remaining time + increment. */
  function suggestBudget(clock, fallbackMs = 1000) {
    if (!clock) return fallbackMs;
    const ms = clock.myTimeMs / 30 + clock.incrementMs * 0.8;
    return Math.max(50, Math.min(ms, clock.myTimeMs * 0.5));
  }

  /** Seeded RNG (mulberry32) for ctx.random. */
  function seededRandom(seed) {
    let a = seed >>> 0;
    return function () {
      let t = (a = (a + 0x6d2b79f5) >>> 0);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * Wrapper for every file in bots/ (see the template in README): runs `factory(root)` and keeps the
   * factory so its source can be shipped to the bot Web Worker. A bot file that does not use it still
   * works, it just runs on the main thread.
   */
  function defineModule(factory) {
    const doc = root.document;
    const name = (doc && doc.currentScript && doc.currentScript.getAttribute('src')) || 'bot module';
    (root.JieqiSources = root.JieqiSources || []).push({ name, factory });
    factory(root);
  }

  root.JieqiBots = {
    module: defineModule,
    register, variant, resolve, parseParams, suggestBudget, seededRandom,
    list: () => [...defs.values()],
    levels: () => [...defs.values()].filter((d) => d.level).sort((x, y) => x.level - y.level),
    get: (id) => defs.get(id),
    lib: (root.JieqiBots && root.JieqiBots.lib) || {}, // helpers shared between bots (bots/lib/*)
  };
});
