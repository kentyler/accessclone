/**
 * Break down the "Other" category from the VBA pattern analysis.
 * Shows the actual commented-out lines that didn't match any known pattern.
 */
const { extractProcedures, stripBoilerplate, translateBlock, collectEnumValues } = require('../lib/vba-to-js');
const { Pool } = require('pg');
const pool = new Pool({ host: 'localhost', user: 'postgres', password: '7297', database: 'polyaccess' });

async function main() {
  const res = await pool.query(
    "SELECT name, definition->>'vba_source' as vba FROM shared.objects " +
    "WHERE database_id='northwind_18' AND type='module' AND is_current=true " +
    "AND definition->>'vba_source' IS NOT NULL"
  );

  // Collect all commented lines and group by general pattern
  const patterns = {};

  for (const row of res.rows) {
    const { name, vba } = row;
    if (!vba) continue;
    const procs = extractProcedures(vba);
    const enumMap = collectEnumValues(vba);

    for (const proc of procs) {
      const cleaned = stripBoilerplate(proc.body);
      const { jsLines } = translateBlock(cleaned, 0, null, null, null, enumMap);

      for (const line of jsLines) {
        if (!line.trim().startsWith('//')) continue;
        const l = line.replace(/^\/\/\s*/, '').trim();
        if (!l) continue;

        // Generalize the line to find patterns
        let pat = l;

        // Generalize specific identifiers
        pat = pat.replace(/"[^"]*"/g, '"..."');
        pat = pat.replace(/\b\d+\b/g, 'N');

        if (!patterns[pat]) patterns[pat] = { count: 0, modules: new Set(), examples: [] };
        patterns[pat].count++;
        patterns[pat].modules.add(name);
        if (patterns[pat].examples.length < 2) {
          patterns[pat].examples.push({ module: name, proc: proc.name, line: l });
        }
      }
    }
  }

  const sorted = Object.entries(patterns).sort((a, b) => b[1].count - a[1].count);

  console.log('=== ALL COMMENTED-OUT PATTERNS (generalized) ===');
  console.log('');
  for (const [pat, data] of sorted.slice(0, 50)) {
    console.log(`${data.count}x (${data.modules.size} modules) | ${pat}`);
    for (const ex of data.examples) {
      console.log(`   e.g. ${ex.module}::${ex.proc}: ${ex.line}`);
    }
    console.log('');
  }

  // Summary by broad category
  console.log('=== BROAD CATEGORY SUMMARY ===');
  console.log('');
  const cats = {};
  for (const [pat, data] of sorted) {
    let cat = 'Other';
    if (/Me\.\w+\s*=/.test(pat) || /Me\.\w+\.\w+\s*=/.test(pat)) cat = 'Me.property assignment';
    else if (/Me\.\w+/.test(pat)) cat = 'Me.property/method access';
    else if (/DoCmd/.test(pat)) cat = 'DoCmd calls';
    else if (/MsgBox/.test(pat)) cat = 'MsgBox';
    else if (/DLookup|DCount|DSum|DMin|DMax/.test(pat)) cat = 'Domain aggregates';
    else if (/\bIf\b|\bElse\b|\bEnd If\b/.test(pat)) cat = 'If/Else block content';
    else if (/\bWith\b|^\.\w+/.test(pat)) cat = 'With block content';
    else if (/RunCommand/.test(pat)) cat = 'RunCommand';
    else if (/Cancel\s*=/.test(pat)) cat = 'Cancel = (event param)';
    else if (/GoTo/.test(pat)) cat = 'GoTo';
    else if (/^\w+\s*=/.test(pat)) cat = 'Variable assignment';
    else if (/\w+\.\w+\.\w+/.test(pat)) cat = 'Property chain access';
    else if (/\bFor\b|\bNext\b|\bWhile\b|\bWend\b/.test(pat)) cat = 'Loop content';
    else if (/Forms[!(]|Form_/.test(pat)) cat = 'Cross-form reference';
    else if (/Select Case|Case /.test(pat)) cat = 'Select Case content';

    if (!cats[cat]) cats[cat] = 0;
    cats[cat] += data.count;
  }

  for (const [cat, count] of Object.entries(cats).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${count} lines: ${cat}`);
  }

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
