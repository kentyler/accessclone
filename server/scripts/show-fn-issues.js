const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', '..', 'ui-react', 'src', 'generated', 'handlers', 'northwind_18');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.ts'));

for (const f of files) {
  const content = fs.readFileSync(path.join(dir, f), 'utf8');
  let idx = 0;
  while (true) {
    const keyPos = content.indexOf('key: "fn.', idx);
    if (keyPos === -1) break;

    const procPos = content.indexOf('procedure: "', keyPos);
    const procStart = procPos + 12;
    const procEnd = content.indexOf('"', procStart);
    const proc = content.slice(procStart, procEnd);

    const jsPos = content.indexOf('js: "', procEnd);
    const jsStart = jsPos + 5;
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
      // Extract just the comment lines
      const commentLines = lines.filter(l => l.trim().startsWith('//') || l.trim().startsWith('/*'));
      console.log(`--- ${f.replace('.ts','')} :: ${proc} ---`);
      for (const cl of commentLines) console.log('  ' + cl.trim());
      console.log('');
    }
    idx = jsEnd + 1;
  }
}
