#!/usr/bin/env node
// Sets a new version tag (?v=YYYYMMDD-HHMM) on every script in index.html. Run before committing an update that
// will be deployed (GitHub Pages), so that browsers load all new files instead of mixing them with cached old ones.
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'index.html');
const d = new Date();
const pad = (n) => String(n).padStart(2, '0');
const v = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
const html = fs.readFileSync(file, 'utf8');
const out = html.replace(/\.js\?v=[^"]*"/g, `.js?v=${v}"`);
fs.writeFileSync(file, out);
console.log(`index.html: version ${v} (${(out.match(/\.js\?v=/g) || []).length} scripts)`);
