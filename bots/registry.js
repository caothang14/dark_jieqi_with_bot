/*
 * Bot registry – chạy được cả trong trình duyệt (window.JieqiBots) lẫn Node (globalThis.JieqiBots).
 *
 * ── Định nghĩa một bot ──────────────────────────────────────────────────────────────
 *   JieqiBots.register({
 *     id: 'greedy',                       // duy nhất, a-z0-9-
 *     name: 'Bot tham ăn',                // tên hiển thị
 *     description: '...',
 *     params: { captureWeight: 1 },       // tham số mặc định (có thể ghi đè khi chọn bot)
 *     chooseMove(state, J, ctx) { ... },  // BẮT BUỘC. Trả về {from,to} hoặc { move:{from,to}, info:{ score, depth, nodes, pv } }
 *                                         // Có thể trả về Promise (Web Worker, gọi HTTP tới service bot...)
 *     acceptDraw(state, J, ctx) { ... },  // tuỳ chọn, trả về boolean (hoặc Promise<boolean>)
 *     hidden: true,                       // tuỳ chọn: không hiện trong UI (bot tham chiếu cho đấu trường)
 *   });
 *
 * ── Biến thể (cùng thuật toán, khác tham số) ───────────────────────────────────────
 *   JieqiBots.variant('greedy', { id: 'greedy-safe', name: 'Tham ăn (cẩn thận)', params: { ... } });
 *   Hoặc chọn nhanh bằng chuỗi: 'greedy:captureWeight=2,revealBonus=0'
 *
 * ── ctx mà bot nhận được (host = UI hoặc đấu trường tạo ra) ─────────────────────────
 *   side          'r' | 'b'   bên bot đang cầm
 *   ply           số nửa nước đã đi
 *   params        tham số đã gộp (mặc định + ghi đè)
 *   random()      số ngẫu nhiên [0,1) – trong đấu trường có seed nên tái lập được. Bot KHÔNG nên dùng Math.random
 *   now()         thời gian hiện tại (ms)
 *   timeBudgetMs  thời gian nên dùng cho nước này
 *   deadline      now() + timeBudgetMs – bot tìm kiếm nên dừng trước mốc này
 *   clock         null hoặc { myTimeMs, oppTimeMs, incrementMs }
 *   history       mảng các nước đã đi [{from,to}] (để bot tránh lặp, mở cuộc…)
 *
 * Bot không được sửa `state` (host luôn truyền bản sao), và không bao giờ nhìn thấy quân úp là gì
 * vì engine chỉ quyết định danh tính lúc lật.
 */
(function (root) {
  'use strict';
  if (root.JieqiBots && root.JieqiBots.register) return; // đã nạp

  const defs = new Map(); // id -> definition

  function register(def) {
    if (!def || !/^[a-z0-9-]+$/.test(def.id || '')) throw new Error(`Bot id không hợp lệ: ${def && def.id}`);
    if (typeof def.chooseMove !== 'function') throw new Error(`Bot ${def.id} thiếu chooseMove()`);
    defs.set(def.id, { params: {}, description: '', ...def, name: def.name || def.id });
    return def;
  }

  function variant(baseId, { id, name, description, params, hidden }) {
    const base = defs.get(baseId);
    if (!base) throw new Error(`Không có bot gốc: ${baseId}`);
    return register({
      ...base, id, name: name || id, description: description || base.description,
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
   * 'greedy' hoặc 'greedy:captureWeight=2' -> một "player" sẵn sàng dùng:
   * { id, name, params, chooseMove(state, J, ctx), acceptDraw(state, J, ctx) }
   * chooseMove luôn trả về Promise<{ move, info }>.
   */
  function resolve(spec) {
    const [id, query] = String(spec).split(/:(.*)/s);
    const def = defs.get(id);
    if (!def) throw new Error(`Không có bot "${id}". Có: ${[...defs.keys()].join(', ')}`);
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

  /** Gợi ý thời gian cho 1 nước khi có đồng hồ: ~1/30 thời gian còn lại + increment. */
  function suggestBudget(clock, fallbackMs = 1000) {
    if (!clock) return fallbackMs;
    const ms = clock.myTimeMs / 30 + clock.incrementMs * 0.8;
    return Math.max(50, Math.min(ms, clock.myTimeMs * 0.5));
  }

  /** RNG có seed (mulberry32) cho ctx.random. */
  function seededRandom(seed) {
    let a = seed >>> 0;
    return function () {
      let t = (a = (a + 0x6d2b79f5) >>> 0);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  root.JieqiBots = {
    register, variant, resolve, parseParams, suggestBudget, seededRandom,
    list: () => [...defs.values()],
    get: (id) => defs.get(id),
    lib: (root.JieqiBots && root.JieqiBots.lib) || {}, // helper dùng chung giữa các bot (bots/lib/*)
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
