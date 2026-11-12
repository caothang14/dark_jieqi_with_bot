/*
 * Runs bots in a Web Worker so the UI does not freeze while a bot is thinking. Browser only (not in the manifest).
 *
 *   const host = JieqiBotWorker.create();               // after every bot file has been loaded
 *   const out = await host.run('move', spec, state, ctx, fallback);   // → what player.chooseMove returns
 *   host.cancel();                                      // stop the current computation (undo, new game…)
 *
 * Works even when index.html is opened via file://: browsers refuse `new Worker('file.js')` and importScripts
 * there, so the worker is built from a Blob that contains the SOURCE of engine.js, bots/registry.js and every
 * bot file. Those files register their factory function in `JieqiSources` (see JieqiBots.module), and
 * Function.prototype.toString gives back its source. No build step needed.
 *
 * Fallback: if the worker cannot be created, crashes, or does not know the bot (a bot file not wrapped in
 * JieqiBots.module), `run` calls `fallback()` – the bot then runs on the main thread like before.
 */
(function (root) {
  'use strict';

  /** Code executed inside the worker (serialised with toString – must not use outer variables). */
  function workerMain(self) {
    const players = new Map();
    const get = (spec) => {
      if (!players.has(spec)) players.set(spec, self.JieqiBots.resolve(spec));
      return players.get(spec);
    };
    self.onmessage = async (e) => {
      const { id, type, spec, state, ctx } = e.data;
      try {
        const player = get(spec);
        const now = () => performance.now();
        // functions cannot be sent to a worker: random/now/deadline are recreated here
        const c = { ...ctx, random: Math.random, now, deadline: now() + (ctx.timeBudgetMs || 1000) };
        const result = type === 'draw'
          ? await player.acceptDraw(state, self.Jieqi, c)
          : await player.chooseMove(state, self.Jieqi, c);
        self.postMessage({ id, ok: true, result });
      } catch (err) {
        self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
      }
    };
    self.postMessage({ ready: true, bots: self.JieqiBots.list().map((b) => b.id) });
  }

  function buildSource(sources) {
    const parts = sources.map(({ name, factory }) => `// ── ${name}\n(${factory.toString()})(self);\n`);
    parts.push(`(${workerMain.toString()})(self);\n`);
    return parts.join('\n');
  }

  /** Only the plain-data parts of ctx can be cloned into the worker. */
  const plainCtx = (ctx) => ({
    side: ctx.side, ply: ctx.ply, timeBudgetMs: ctx.timeBudgetMs, clock: ctx.clock, history: ctx.history,
  });

  function create() {
    let worker = null;
    let ready = null;      // Promise<Set<botId>> – null set = worker unusable
    let failed = false;
    let seq = 0;
    const pending = new Map(); // id -> { resolve, reject }

    function rejectAll(err) {
      for (const p of pending.values()) p.reject(err);
      pending.clear();
    }

    function start() {
      if (failed) return Promise.resolve(null);
      if (ready) return ready;
      ready = new Promise((resolveReady) => {
        let url = null;
        try {
          const sources = root.JieqiSources || [];
          if (!sources.length || typeof Worker === 'undefined') throw new Error('no worker support');
          url = URL.createObjectURL(new Blob([buildSource(sources)], { type: 'text/javascript' }));
          worker = new Worker(url);
        } catch (err) {
          console.warn('Bot worker unavailable, bots run on the main thread:', err);
          failed = true;
          resolveReady(null);
          return;
        }
        worker.onmessage = (e) => {
          const msg = e.data;
          if (msg.ready) { if (url) URL.revokeObjectURL(url); resolveReady(new Set(msg.bots)); return; }
          const p = pending.get(msg.id);
          if (!p) return;
          pending.delete(msg.id);
          if (msg.ok) p.resolve(msg.result); else p.reject(new Error(msg.error));
        };
        worker.onerror = (e) => {
          console.warn('Bot worker crashed, bots run on the main thread:', e.message || e);
          e.preventDefault && e.preventDefault();
          failed = true;
          worker.terminate();
          worker = null;
          resolveReady(null);
          rejectAll(Object.assign(new Error('worker crashed'), { workerCrashed: true }));
        };
      });
      return ready;
    }

    /**
     * type: 'move' (chooseMove) | 'draw' (acceptDraw). Runs in the worker when possible, otherwise `fallback()`.
     * Rejects with err.cancelled = true when cancel() is called meanwhile.
     */
    async function run(type, spec, state, ctx, fallback) {
      const ids = await start();
      const baseId = String(spec).split(':')[0];
      if (!ids || !ids.has(baseId)) return fallback();
      const id = ++seq;
      try {
        return await new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          worker.postMessage({ id, type, spec, state, ctx: plainCtx(ctx) });
        });
      } catch (err) {
        if (err && err.workerCrashed) return fallback();
        throw err;
      }
    }

    /** Stops whatever the worker is computing (terminates it; a fresh one is started on the next run). */
    function cancel() {
      if (!pending.size) return;
      if (worker) worker.terminate();
      worker = null;
      ready = null;
      rejectAll(Object.assign(new Error('cancelled'), { cancelled: true }));
    }

    return { run, cancel, start, get busy() { return pending.size > 0; }, get usable() { return !failed; } };
  }

  root.JieqiBotWorker = { create, buildSource };
})(typeof globalThis !== 'undefined' ? globalThis : this);
