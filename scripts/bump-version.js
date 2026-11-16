#!/usr/bin/env node
// Sets a new version tag (?v=YYYYMMDD-HHMM) on every script in index.html. Run before committing an update that
// will be deployed (GitHub Pages), so that browsers load all new files instead of mixing them with cached old ones.
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'index.html');
// Vietnam time whatever the machine's time zone – the UI shows it as "Cập nhật: dd/mm/yyyy hh:mm"
const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).formatToParts(new Date()).map((p) => [p.type, p.value]));
const v = `${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}`;
const html = fs.readFileSync(file, 'utf8');
const out = html.replace(/\.js\?v=[^"]*"/g, `.js?v=${v}"`);
fs.writeFileSync(file, out);
console.log(`index.html: version ${v} (${(out.match(/\.js\?v=/g) || []).length} scripts)`);
