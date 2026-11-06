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

> Nếu luật bạn hay chơi khác (ví dụ Sĩ/Tượng lật rồi vẫn bị giới hạn), sửa hàm `pseudoTargets` trong `engine.js`.

## Cấu trúc

| File | Vai trò |
|---|---|
| `engine.js` | Luật chơi, không đụng DOM. Dùng được cả trong browser (`window.Jieqi`) lẫn Node (`require('./engine')`) |
| `clock.js` | Đồng hồ 2 bên (có cộng giây mỗi nước, tạm dừng, lưu/khôi phục khi đi lại) |
| `ui.js` | Vẽ bàn cờ, xử lý click, đi lại (undo), biên bản |
| `bots/basic-bots.js` | 2 bot mẫu: ngẫu nhiên, tham ăn 1 nước |
| `test/engine.test.js` | Test luật |

## API engine (để viết bot)

```js
const s0 = Jieqi.createGame({ seed: 123 });   // seed cố định => ván tái lập được
Jieqi.getLegalMoves(s)                         // [{from, to}], ô = y*9 + x
Jieqi.makeMove(s, move)                        // trả về state MỚI (immutable)
Jieqi.makeMove(s, move, { revealAs: 'R' })     // ép quân lật ra là Xe (cho expectimax)
Jieqi.makeMove(s, move, { captureAs: 'C' })    // ép quân úp bị ăn là Pháo
Jieqi.makeMove(s, move, { fast: true })        // bỏ kiểm tra hợp lệ/kết quả, cho search nhanh
Jieqi.revealProbabilities(s, 'b')              // { R: 0.2, C: 0.13, ... } xác suất lật ra
Jieqi.isInCheck(s), s.result, s.turn, s.board, s.pools
```

Mỗi quân: `{ side: 'r'|'b', type, hidden, role }`. `role` = loại quân của ô xuất phát (cách quân úp di chuyển); `type` = quân thật, `null` khi còn úp.

## Thêm bot

Tạo file trong `bots/`, đăng ký vào `window.JieqiBots`, rồi thêm `<script>` vào `index.html`. Bot sẽ tự hiện trong menu "Chế độ".

```js
window.JieqiBots.myBot = {
  name: 'Bot của tôi',
  chooseMove(state, J) {       // có thể trả về Promise (ví dụ gọi Web Worker hoặc server)
    return J.getLegalMoves(state)[0];
  },
};
```

Gợi ý hướng làm bot:

1. **Expectimax**: ở nước lật quân, duyệt từng loại quân có thể lật ra (`revealProbabilities` + `revealAs`), lấy trung bình có trọng số.
2. Hàm đánh giá: giá trị quân ngửa + giá trị kỳ vọng của quân úp + độ an toàn của Tướng.
3. Muốn mạnh hơn: tham khảo Pikafish bản Jieqi hoặc JieqiAI (xem phần dưới), có thể chạy engine qua Web Worker / WASM hoặc một server Python nhỏ.

## Mã nguồn mở tham khảo

- [wenpinglaoyao/jieqiGame](https://github.com/wenpinglaoyao/jieqiGame)
- [Warm-rain/Pikafish](https://github.com/Warm-rain/Pikafish) (fork Pikafish cho Jieqi)
- [arthuryangcs/JieqiAI](https://github.com/arthuryangcs/JieqiAI)
