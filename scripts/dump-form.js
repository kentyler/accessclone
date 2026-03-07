const form = JSON.parse(require('fs').readFileSync(__dirname + '/frmOrderDetails.json','utf8'));

console.log('=== FORM PROPERTIES ===');
const skip = new Set(['header','detail','footer']);
for (const [k,v] of Object.entries(form)) {
  if (!skip.has(k)) {
    console.log('  ' + k + ': ' + JSON.stringify(v));
  }
}

for (const section of ['header','detail','footer']) {
  if (!form[section]) continue;
  const controls = form[section].controls || [];
  console.log('\n=== ' + section.toUpperCase() + ' (' + controls.length + ' controls) ===');
  for (const c of controls) {
    const parts = [];
    if (c.field) parts.push('field=' + c.field);
    if (c['row-source']) parts.push('row-source=' + c['row-source']);
    if (c['source-object']) parts.push('source-object=' + c['source-object']);
    if (c['has-after-update-event']) parts.push('after-update-event');
    if (c['has-click-event']) parts.push('click-event');
    if (c.locked) parts.push('locked');
    if (c['bound-column']) parts.push('bound-col=' + c['bound-column']);
    if (c['column-widths']) parts.push('col-widths=' + c['column-widths']);
    if (c['link-child-fields']) parts.push('link-child=' + c['link-child-fields']);
    if (c['link-master-fields']) parts.push('link-master=' + c['link-master-fields']);
    if (c['default-value']) parts.push('default=' + c['default-value']);
    if (c['control-source']) parts.push('ctrl-source=' + c['control-source']);
    const pad = (c.type||'?').padEnd(15) + ' ' + (c.name||'?').padEnd(35);
    console.log('  ' + pad + ' ' + parts.join(', '));
  }
}
