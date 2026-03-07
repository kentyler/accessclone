const form = JSON.parse(require('fs').readFileSync(__dirname + '/sfrmOrderLineItems.json','utf8'));
console.log('record-source:', form['record-source']);
console.log('default-view:', form['default-view']);
for (const section of ['header','detail','footer']) {
  if (!form[section]) continue;
  const controls = form[section].controls || [];
  console.log('\n=== ' + section.toUpperCase() + ' (' + controls.length + ' controls) ===');
  for (const c of controls) {
    const parts = [];
    if (c.field) parts.push('field=' + c.field);
    if (c['row-source']) parts.push('row-source=' + c['row-source']);
    if (c['control-source']) parts.push('ctrl-source=' + c['control-source']);
    if (c['bound-column']) parts.push('bound-col=' + c['bound-column']);
    if (c['column-widths']) parts.push('col-widths=' + c['column-widths']);
    if (c['has-after-update-event']) parts.push('after-update-event');
    if (c.locked) parts.push('locked');
    if (c['default-value']) parts.push('default=' + c['default-value']);
    const pad = (c.type||'?').padEnd(15) + ' ' + (c.name||'?').padEnd(30);
    console.log('  ' + pad + ' ' + parts.join(', '));
  }
}
