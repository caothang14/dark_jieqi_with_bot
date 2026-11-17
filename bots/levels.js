/*
 * Difficulty levels for the "Đấu với máy" (play vs computer) mode. All are variants of the search bot:
 *
 *   1 Dễ       depth 1, often picks a weaker move (randomness 1.5 ≈ up to 1.5 Pawns worse)
 *   2 Vừa      depth 2, occasionally picks a slightly weaker move (randomness 0.4)
 *   3 Khó      full search, at most 0.5 s/move
 *   4 Rất khó  full search with the step-15 CPU budget (= `search` + ECO_PARAMS: maxNodes 1.2M, predictStop,
 *              easyMargin 3) – plays "Đấu với máy"; usually 0.2–1.5 s/move instead of the full 3–4 s
 *
 * Names/descriptions are shown in the UI, so they are in Vietnamese.
 * Ordering of the levels is checked in the arena (see README, "Difficulty levels").
 */
JieqiBots.module(function (root) {
  'use strict';
  const Bots = root.JieqiBots;

  const LEVELS = [
    { level: 1, levelName: 'Dễ', description: 'Chỉ nhìn trước 1 nước và hay đi nước chưa tốt. Hợp với người mới chơi.',
      params: { depth: 1, randomness: 1.5 } },
    { level: 2, levelName: 'Vừa', description: 'Nhìn trước 2 nước, thỉnh thoảng đi nước chưa tốt.',
      params: { depth: 2, randomness: 0.4 } },
    { level: 3, levelName: 'Khó', description: 'Tìm kiếm đầy đủ, nghĩ tối đa 0,5 giây mỗi nước.',
      params: { maxTimeMs: 500, phaseTime: { opening: 1, middlegame: 1, endgame: 1 } } },
    { level: 4, levelName: 'Rất khó', description: 'Bot mạnh nhất hiện tại: tìm kiếm đầy đủ, có giới hạn khối lượng tính mỗi nước để máy đỡ nóng (đi ngay nước hiển nhiên, bỏ các vòng tính không kịp xong).',
      params: { ...Bots.lib.search.ECO_PARAMS } },
  ];

  for (const l of LEVELS) {
    Bots.variant('search', { id: `level-${l.level}`, name: `Máy (${l.levelName})`, ...l });
  }
});
