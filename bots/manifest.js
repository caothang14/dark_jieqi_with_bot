/*
 * Danh sách file bot, nạp theo đúng thứ tự (đường dẫn tính từ thư mục bots/).
 * Thêm bot mới = tạo file trong bots/ rồi thêm tên file vào đây. UI và đấu trường đều đọc danh sách này.
 */
(function (root) {
  const files = [
    'lib/common.js',
    'lib/eval.js',
    'random.js',
    'greedy.js',
    'eval1.js',
  ];
  if (typeof module !== 'undefined' && module.exports) module.exports = files;
  else root.JieqiBotManifest = files;
})(typeof globalThis !== 'undefined' ? globalThis : this);
