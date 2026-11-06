# Cờ Tướng Úp (Jieqi / 揭棋)

Bàn cờ tướng úp chơi trên máy local. HTML/CSS/JS thuần, không cần build, không cần server.

## Chạy

Mở `index.html` bằng trình duyệt (double-click là được).

Test engine (cần Node.js):

```bash
npm test
```

## Luật đã cài

- Hai Tướng ngửa, 15 quân còn lại mỗi bên úp ở vị trí chuẩn.
- Quân úp đi theo luật của quân gốc ở ô đó (úp ở ô Xe thì đi như Xe, Sĩ úp chỉ đi trong cung, Tượng úp không qua sông).
- Đi xong thì quân được lật; danh tính rút ngẫu nhiên từ "túi" quân còn úp của bên đó.
- Sĩ/Tượng đã lật được đi khắp bàn (Sĩ đi chéo 1 ô, Tượng đi chéo 2 ô, vẫn bị chặn mắt).
- Ăn quân úp thì lộ ra quân đó là gì.
- Có luật lộ mặt tướng, không được tự đi vào thế bị chiếu, hết nước đi là thua.
- Hoà khi đi 120 nửa nước liền không ăn quân, không lật quân.

## Đồng hồ

- Chọn thời gian ở mục "Thời gian": không tính giờ, 3+2, 5, 10, 10+5, 15+10, 30 phút, hoặc tuỳ chỉnh (phút + giây cộng mỗi nước).
- Đồng hồ bắt đầu chạy sau nước đầu tiên của Đỏ. Đi xong một nước thì được cộng thêm giây (nếu có) và chuyển giờ sang đối thủ.
- Hết giờ thì thua. Dưới 10 giây đồng hồ chuyển đỏ và hiện phần mười giây.
- "Tạm dừng" (hoặc phím Space) dừng giờ và khoá bàn cờ. "Đi lại" trả thời gian về đúng lúc trước nước đó.
- Đổi thời gian giữa ván thì áp dụng từ ván mới.
- Logic đồng hồ nằm riêng trong `clock.js` (class `ChessClock`), dùng lại được cho bot (ví dụ bot tự chia thời gian suy nghĩ).

## Kết thúc ván

- **Chịu thua**: chơi 2 người thì bên đang tới lượt chịu thua; đấu bot thì người chơi chịu thua. Có bước xác nhận.
- **Cầu hoà**: chơi 2 người thì bên kia bấm Đồng ý / Từ chối; đấu bot thì bot tự quyết qua hàm `acceptDraw` (bot tham ăn đồng ý khi đang kém hoặc ngang quân).
- **Lật hết quân úp**: hiện sau khi hết ván; quân lật thêm có viền cam. Engine có hàm `Jieqi.revealAll(state)`.
- Bấm "Đi lại" ngay sau khi chịu thua / hoà / hết giờ sẽ huỷ kết quả đó và chơi tiếp.

> Nếu luật bạn hay chơi khác (ví dụ Sĩ/Tượng lật rồi vẫn bị giới hạn), sửa hàm `pseudoTargets` trong `engine.js`.

## Cấu trúc

| File | Vai trò |
|---|---|
| `engine.js` | Luật chơi, không đụng DOM. Dùng được cả trong browser (`window.Jieqi`) lẫn Node (`require('./engine')`) |
| `clock.js` | Đồng hồ 2 bên (có cộng giây mỗi nước, tạm dừng, lưu/khôi phục khi đi lại) |
| `ui.js` | Vẽ bàn cờ, xử lý click, đi lại (undo), biên bản; chọn Người/bot cho từng bên |
| `bots/registry.js` | Nơi đăng ký bot + giao diện chung (`JieqiBots`) |
| `bots/manifest.js` | Danh sách file bot – **thêm bot mới chỉ cần sửa file này** |
| `bots/lib/common.js` | Helper dùng chung (giá trị quân đơn giản, chọn ngẫu nhiên…) |
| `bots/lib/eval.js` | Hàm đánh giá thế cờ (giá trị quân theo giai đoạn, cơ động, chiếu) |
| `bots/random.js`, `bots/greedy.js`, `bots/eval1.js`, `bots/search.js` | Các bot: ngẫu nhiên, tham ăn, đánh giá 1 nước, tìm kiếm nhiều nước |
| `bots/index.js` | Nạp toàn bộ bot trong Node |
| `arena/match.js` | Chơi 1 ván bot vs bot, replay ván từ record |
| `arena/arena.js` | Đấu trường: chạy song song nhiều ván, thống kê Elo |
| `test/` | Test luật, bot, đấu trường (`npm test`) |

## API engine (để viết bot)

```js
const s0 = Jieqi.createGame({ seed: 123 });   // seed cố định => ván tái lập được
Jieqi.getLegalMoves(s)                         // [{from, to}], ô = y*9 + x
Jieqi.makeMove(s, move)                        // trả về state MỚI (immutable)
Jieqi.makeMove(s, move, { revealAs: 'R' })     // ép quân lật ra là Xe (cho expectimax)
Jieqi.makeMove(s, move, { captureAs: 'C' })    // ép quân úp bị ăn là Pháo
Jieqi.makeMove(s, move, { fast: true })        // bỏ kiểm tra hợp lệ/kết quả, cho search nhanh
Jieqi.revealProbabilities(s, 'b')              // { R: 0.2, C: 0.13, ... } xác suất lật ra
Jieqi.revealAll(s)                             // lật hết quân úp (chỉ để xem khi hết ván)
Jieqi.isInCheck(s), s.result, s.turn, s.board, s.pools
```

Mỗi quân: `{ side: 'r'|'b', type, hidden, role }`. `role` = loại quân của ô xuất phát (cách quân úp di chuyển); `type` = quân thật, `null` khi còn úp.

## Viết bot

1. Tạo file `bots/<ten-bot>.js`:

```js
(function (root) {
  const { VALUE, materialDiff } = root.JieqiBots.lib.common;
  root.JieqiBots.register({
    id: 'my-bot',
    name: 'Bot của tôi',
    description: 'Mô tả ngắn, hiện trong UI',
    params: { depth: 2 },                       // tham số mặc định, ghi đè được
    chooseMove(state, J, ctx) {                 // có thể async
      const moves = J.getLegalMoves(state);
      return { move: moves[0], info: { score: 0, depth: ctx.params.depth } };   // hoặc chỉ trả về moves[0]
    },
    acceptDraw(state, J, ctx) {                 // tuỳ chọn
      return materialDiff(state, J, ctx.side) < 0;
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
```

2. Thêm `'<ten-bot>.js'` vào `bots/manifest.js`. Bot tự xuất hiện trong UI (ô chọn Đỏ/Đen) và trong đấu trường.

`ctx` bot nhận được: `side`, `ply`, `params`, `random()` (có seed trong đấu trường – đừng dùng `Math.random`), `now()`, `timeBudgetMs`, `deadline`, `clock` (`{ myTimeMs, oppTimeMs, incrementMs }` hoặc `null`), `history`. Chi tiết ở đầu `bots/registry.js`.

**Nhiều phong cách từ 1 thuật toán**: dùng biến thể thay vì copy code.

```js
JieqiBots.variant('my-bot', { id: 'my-bot-endgame', name: 'Bot ưu tiên tàn cuộc', params: { endgameWeight: 2 } });
```

hoặc chọn nhanh khi chạy đấu trường: `--a my-bot:depth=3,endgameWeight=2`.

**Service bot sau này**: bot chỉ cần `chooseMove` trả về Promise, nên một bot gọi service là một file nhỏ:

```js
chooseMove: async (state, J, ctx) => {
  const res = await fetch('http://localhost:8000/move', { method: 'POST', body: JSON.stringify({ state, ctx: { side: ctx.side, timeBudgetMs: ctx.timeBudgetMs } }) });
  return res.json();   // { move: {from, to}, info }
}
```

State là JSON thuần, gửi thẳng được. Đấu trường cũng gọi được bot kiểu này.

## Hàm đánh giá thế cờ (`bots/lib/eval.js`)

Điểm = **giá trị quân** + **cơ động** (0.02 × chênh lệch số nước đi) + **chiếu** (±0.3). Thắng/thua = ±1000.

| Quân | Giá trị |
|---|---|
| Tốt | -1 ở tâm cung của mình (vướng Tướng – đối phương không nên ăn), 1 chưa qua sông, 2 đã qua sông, 0.5 khi lụt (hàng cuối đối phương) |
| Tượng | 1 |
| Sĩ | 2; 3 khi có Sĩ giao nhau (2 Sĩ chéo cạnh nhau, bảo vệ nhau) |
| Mã | 3 khai cuộc · 4 trung cuộc · 5 tàn cuộc |
| Pháo | 5 khai cuộc · 4 trung cuộc · 3 tàn cuộc |
| Xe | 9.5 khai cuộc · 9 trung cuộc · 10 tàn cuộc |
| Quân úp | trung bình theo xác suất lật ra, mỗi khả năng chấm như đã lật tại ô đang đứng |

Giai đoạn theo số quân còn trên bàn / 32 (tính cả Tướng và quân úp): > 90% (≥ 29 quân) khai cuộc, > 50% (17–28) trung cuộc, còn lại tàn cuộc.

Mọi hệ số đều ghi đè được, không cần sửa code:

```bash
npm run arena -- --a eval-1ply:R.endgame=11,mobility=0 --b eval-1ply
```

```js
JieqiBots.variant('eval-1ply', { id: 'tan-cuoc', name: 'Ưu tiên tàn cuộc', params: { 'H.endgame': 6, 'P.crossed': 2.5 } });
```

Trong UI, bật "Hiện đánh giá thế cờ" để xem điểm (góc nhìn Đỏ), giai đoạn và giá trị từng quân ngay trên bàn cờ.

Bot dùng hàm này: `eval-1ply` (đầy đủ) và `material-1ply` (chỉ tính quân). Cả hai đều mới nhìn 1 nước nên chỉ ngang bot tham ăn (~54%) – hàm đánh giá chỉ phát huy khi có tìm kiếm nhiều nước (bước 3).

## Bot tìm kiếm (`bots/search.js`)

Nhìn trước nhiều nước:

- **Alpha-beta (negamax)**: thử nước của mình, nước đáp của đối thủ…, cắt các nhánh chắc chắn kém.
- **Nút may rủi khi lật quân**: nước lật quân được tính bằng trung bình có trọng số theo xác suất từng loại quân lật ra (expectimax, cắt nhánh kiểu Star1). Ăn quân úp thì *không* tách nhánh: bàn cờ sau khi ăn giống nhau với mọi danh tính, và giữ nguyên pool cho đúng xác suất kỳ vọng (`makeMove(..., { captureUnknown: true })`).
- **Quiescence**: hết độ sâu mà còn nước ăn quân thì tìm tiếp các nước ăn (thấy được "ăn rồi bị ăn lại"); đang bị chiếu thì xét đủ nước thoát chiếu (2 nửa nước đầu). Quân úp chỉ được ăn ở nửa nước đầu của quiescence, kèm delta pruning – để cây không bùng nổ.
- **Sắp xếp nước**: ăn quân đắt bằng quân rẻ trước (MVV-LVA), rồi đến nước từng gây cắt nhánh (history).
- **Đào sâu dần** theo thời gian (1, 2, 3… đến khi hết giờ); hết giờ giữa chừng vẫn dùng được kết quả của vòng trước.

| Bot | Phong cách |
|---|---|
| `search` | Bot tìm kiếm – tối đa 2 giây/nước |
| `search-fast` | Tối đa 0,3 giây/nước |
| `search-midgame` | Đi nhanh khai cuộc, dành gấp 2,5 lần thời gian cho trung cuộc |
| `search-endgame` | Đánh giá cao Mã/Xe/Tốt qua sông ở tàn cuộc, nghĩ lâu hơn khi vào tàn cuộc |

Tham số chính: `depth` (cố định độ sâu – tái lập được), `maxTimeMs`, `phaseTime.middlegame`, `qDepth`, cùng mọi trọng số của hàm đánh giá. Ví dụ: `--a search:depth=2`, `--a search:maxTimeMs=500,R.endgame=11`.

**Kết quả** (40 ván, 0,5 giây/nước): `search` thắng `greedy` **92,5%** (+37 =0 -3), ván trung bình 44 nửa nước.

**Giới hạn hiện tại**: ở khai cuộc (nhiều quân úp, nước nào cũng lật quân) bot chỉ kịp tính ~1–2 nước trong 0,5 giây, nên có thể lọt đòn chiếu bí bằng nước đi thường. Trung/tàn cuộc đạt 3–4 nước. Bot chạy trên luồng chính nên UI đứng hình trong lúc bot nghĩ. Bước 4 (tăng tốc engine) và bước 5 (Web Worker) sẽ xử lý.

## Đấu trường (bot vs bot)

```bash
npm run bots                                          # liệt kê bot
npm run arena -- --a greedy --b random --games 200
npm run arena -- --a greedy:revealBonus=0 --b greedy -n 400 -j 8 --out results/test.json
npm run arena -- --a my-bot --b greedy --tc 60+1      # đồng hồ thật 60s + 1s/nước, hết giờ là thua
```

- Mỗi seed chơi 2 ván đổi màu cho công bằng. Cùng seed + cùng bot ⇒ kết quả y hệt (tái lập được để debug).
- In ra: thắng/hoà/thua (tách theo màu), Elo chênh lệch kèm khoảng tin cậy 95%, LOS (xác suất A mạnh hơn B), thời gian mỗi nước, độ sâu trung bình, lý do kết thúc.
- Bot đi nước sai luật hoặc bị lỗi ⇒ xử thua (`illegal-move`, `bot-error`), có ghi chi tiết.
- Quá `--max-plies` (mặc định 300) ⇒ xử hoà.
- `--out` lưu toàn bộ ván (seed + nước đi); dựng lại bằng `replay(J, record)` trong `arena/match.js`.

Mốc tham khảo hiện tại: `greedy` vs `random` ≈ 95% điểm; `search` vs `greedy` ≈ 92,5%.

## Mã nguồn mở tham khảo

- [wenpinglaoyao/jieqiGame](https://github.com/wenpinglaoyao/jieqiGame)
- [Warm-rain/Pikafish](https://github.com/Warm-rain/Pikafish) (fork Pikafish cho Jieqi)
- [arthuryangcs/JieqiAI](https://github.com/arthuryangcs/JieqiAI)
