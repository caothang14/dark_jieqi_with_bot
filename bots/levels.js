/*
 * Difficulty levels for the "Đấu với máy" (play vs computer) mode. All are variants of the search bot:
 *
 *   1 Dễ       depth 1, often picks a weaker move (randomness 1.5 ≈ up to 1.5 Pawns worse)
 *   2 Vừa      depth 2, occasionally picks a slightly weaker move (randomness 0.4)
 *   3 Khó      full search, at most 0.5 s/move
 *   4 Rất khó  full search, ~4 s/move in the opening, ~3 s later (= the `search` bot, the strongest one)
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
    { level: 4, levelName: 'Rất khó', description: 'Bot mạnh nhất hiện tại: tìm kiếm đầy đủ, nghĩ khoảng 4 giây mỗi nước ở khai cuộc, 3 giây ở trung cuộc và tàn cuộc.',
      params: {} },
  ];

  for (const l of LEVELS) {
    Bots.variant('search', { id: `level-${l.level}`, name: `Máy (${l.levelName})`, ...l });
  }
});
