// Node: loads the registry + every bot in the manifest. Usage: const JieqiBots = require('./bots');
const path = require('path');
require('./registry');
for (const f of require('./manifest')) require(path.join(__dirname, f));
module.exports = globalThis.JieqiBots;
