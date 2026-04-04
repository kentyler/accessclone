const fs = require('fs');
const path = require('path');
const file = process.argv[2];
if (!file) { console.error('Usage: node show-comments.js <handler-file>'); process.exit(1); }
const f = path.join(__dirname, '..', '..', 'ui-react', 'src', 'generated', 'handlers', 'northwind_18', file);
const content = fs.readFileSync(f, 'utf8');
let idx = 0;
while (true) {
  const procKey = content.indexOf('procedure: "', idx);
  if (procKey === -1) break;
  const procStart = procKey + 12;
  const procEnd = content.indexOf('"', procStart);
  const proc = content.slice(procStart, procEnd);

  const jsKey = content.indexOf('js: "', procEnd);
  const jsStart = jsKey + 5;
  let jsEnd = jsStart;
  while (jsEnd < content.length) {
    if (content[jsEnd] === '\\') { jsEnd += 2; continue; }
    if (content[jsEnd] === '"') break;
    jsEnd++;
  }
  const raw = content.slice(jsStart, jsEnd);
  const js = raw.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');

  const lines = js.split('\n').filter(l => l.trim());
  const hasComment = lines.some(l => l.trim().startsWith('//') || l.trim().startsWith('/*'));
  if (hasComment) {
    console.log('=== ' + proc + ' ===');
    console.log(js);
    console.log('');
  }
  idx = jsEnd + 1;
}
