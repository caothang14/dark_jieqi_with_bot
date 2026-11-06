// Node: nạp registry + toàn bộ bot trong manifest. Dùng: const JieqiBots = require('./bots');
const path = require('path');
require('./registry');
for (const f of require('./manifest')) require(path.join(__dirname, f));
module.exports = globalThis.JieqiBots;
