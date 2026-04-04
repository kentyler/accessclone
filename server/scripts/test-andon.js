#!/usr/bin/env node
/**
 * Test script: freeze + evaluate the andon cord for a database.
 * Usage: node scripts/test-andon.js [database_id]
 */
const http = require('http');

const databaseId = process.argv[2] || 'northwind_18';

function post(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: 'localhost', port: 3001, path, method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  // Re-freeze
  const freeze = await post(`/api/andon/${databaseId}/freeze`);
  console.log('=== FREEZE ===');
  console.log('Objects:', freeze.objects, '| Assertions:', freeze.total_assertions);
  console.log('By type:', JSON.stringify(freeze.snapshot.by_type));

  // Evaluate
  const evalResult = await post(`/api/andon/${databaseId}/evaluate`);
  const byType = {};
  for (const obj of evalResult.per_object) {
    const key = obj.object_type + ':' + obj.intent_type;
    if (!(key in byType)) byType[key] = { passed: 0, failed: 0, total: 0 };
    byType[key].passed += obj.passed;
    byType[key].failed += obj.failed;
    byType[key].total += obj.total;
  }
  console.log('');
  console.log('=== EVALUATE ===');
  for (const [key, v] of Object.entries(byType).sort()) {
    const pct = ((v.passed / v.total) * 100).toFixed(1);
    console.log(key + ': ' + v.passed + '/' + v.total + ' (' + pct + '%)');
  }
  console.log('');
  console.log('Cord status:', evalResult.cord_status);
  console.log('Coverage:', (evalResult.coverage * 100).toFixed(1) + '%');
  console.log('Heterogeneity:', evalResult.heterogeneity.toFixed(4));
  console.log('Failure categories:', JSON.stringify(evalResult.failure_categories));
})();
