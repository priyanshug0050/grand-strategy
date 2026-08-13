/**
 * Runs every suite in order. Engine suites first (no database needed), then
 * the DB-backed ones — so a broken formula surfaces before a connection error
 * buries it.
 */
'use strict';
const { execFileSync } = require('child_process');
const path = require('path');

const ENGINE = ['city','population','economy','military','combat','policy','tick'];
const DB = ['persistence','api','admin','frontend'];

let failed = 0;
function run(name) {
  const file = path.join(__dirname, `test-${name}.js`);
  process.stdout.write(`\n${'='.repeat(52)}\n  ${name.toUpperCase()}\n${'='.repeat(52)}\n`);
  try {
    execFileSync('node', [file], { stdio: 'inherit', cwd: path.join(__dirname, '..') });
  } catch {
    failed++;
  }
}

ENGINE.forEach(run);

if (process.argv.includes('--engine-only')) {
  process.exit(failed > 0 ? 1 : 0);
}

DB.forEach(run);

console.log(`\n${failed === 0 ? 'ALL SUITES PASSED' : failed + ' SUITE(S) FAILED'}\n`);
process.exit(failed > 0 ? 1 : 0);
