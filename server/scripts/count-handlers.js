const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', '..', 'ui-react', 'src', 'generated', 'handlers', 'northwind_18');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.ts'));

let totalEntries = 0, cleanEntries = 0, commentEntries = 0;
let byFile = [];

for (const f of files) {
  const content = fs.readFileSync(path.join(dir, f), 'utf8');
  // Parse the TS file by extracting js: "..." values
  // The file uses escapeJsonString, so js values are double-quoted JSON strings
  const jsMatches = [];
  let idx = 0;
  while (true) {
    const jsKey = content.indexOf('js: "', idx);
    if (jsKey === -1) break;
    const start = jsKey + 5;
    // Find the closing quote, accounting for escaped quotes
    let end = start;
    while (end < content.length) {
      if (content[end] === '\\') { end += 2; continue; }
      if (content[end] === '"') break;
      end++;
    }
    const raw = content.slice(start, end);
    // Unescape
    const js = raw.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    jsMatches.push(js);
    idx = end + 1;
  }

  let fileClean = 0, fileComment = 0, fileMixed = 0;
  for (const js of jsMatches) {
    totalEntries++;
    const lines = js.split('\n').map(l => l.trim()).filter(l => l);
    const hasComment = lines.some(l => l.startsWith('// [VBA') || l.startsWith('// '));
    const hasReal = lines.some(l => !l.startsWith('//') && !l.startsWith('/*'));
    if (!hasComment) { cleanEntries++; fileClean++; }
    else if (!hasReal) { commentEntries++; fileComment++; }
    else { fileMixed++; }
  }
  byFile.push({ file: f, total: jsMatches.length, clean: fileClean, comment: fileComment, mixed: fileMixed });
}

console.log('Total entries:', totalEntries);
console.log('Clean (fully translated):', cleanEntries);
console.log('All-comment (not translated):', commentEntries);
console.log('Mixed (partial):', totalEntries - cleanEntries - commentEntries);
console.log('Rate:', ((cleanEntries / totalEntries) * 100).toFixed(1) + '%');
console.log('');

// Show files with issues
const withIssues = byFile.filter(f => f.comment > 0 || f.mixed > 0);
withIssues.sort((a, b) => (b.comment + b.mixed) - (a.comment + a.mixed));
console.log('Files with untranslated handlers:');
for (const f of withIssues) {
  console.log(`  ${f.file}: ${f.clean}/${f.total} clean, ${f.comment} all-comment, ${f.mixed} mixed`);
}
