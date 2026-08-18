#!/usr/bin/env node
/**
 * ============================================================================
 *  doctor.js — is the checkout actually complete?
 * ============================================================================
 *
 *  Every file in this project is moved around by hand: zipped, emailed,
 *  unzipped over an existing folder, occasionally copied one file at a time.
 *  That works until one file quietly does not land.
 *
 *  When the missing file is a leaf, Node says so clearly. When it is
 *  src/engine/constants.js — which every other module requires — you get
 *  eleven suites failing with eleven different stack traces, none of which
 *  says "a file is missing", and the real cause is buried three requires deep.
 *
 *  This turns that into one line. Run it FIRST whenever something is broken in
 *  a way that makes no sense.
 *
 *      npm run doctor
 * ============================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REQUIRED = [
  // The engine. constants.js first — everything else requires it, so its
  // absence is what produces the confusing cascade.
  'src/engine/constants.js',
  'src/engine/city.js',
  'src/engine/population.js',
  'src/engine/economy.js',
  'src/engine/military.js',
  'src/engine/combat.js',
  'src/engine/modifiers.js',
  'src/engine/policy.js',
  'src/engine/tick.js',

  // Data and API
  'src/data/db.js',
  'src/data/repository.js',
  'src/api/auth.js',
  'src/api/service.js',
  'src/scheduler.js',
  'server.js',

  // Separable modules
  'src/market/engine.js', 'src/market/service.js', 'src/market/routes.js',
  'src/admin/guard.js', 'src/admin/service.js', 'src/admin/routes.js',

  // Schema and generators
  'db/schema.sql',
  'make-wiki.js',

  // Frontend pages
  'public/index.html', 'public/login.html', 'public/dashboard.html',
  'public/cities.html', 'public/economy.html', 'public/policy.html',
  'public/market.html', 'public/military.html', 'public/espionage.html',
  'public/projects.html', 'public/history.html', 'public/rankings.html',
  'public/admin.html', 'public/privacy.html', 'public/terms.html',
  'public/robots.txt', 'public/sitemap.xml',

  // Frontend scripts and styles
  'public/js/api.js', 'public/js/dashboard.js', 'public/js/cities.js',
  'public/js/economy.js', 'public/js/policy.js', 'public/js/market.js',
  'public/js/military.js', 'public/js/espionage.js', 'public/js/projects.js',
  'public/js/history.js', 'public/js/rankings.js', 'public/js/admin.js',
  'public/css/app.css', 'public/css/mobile.css',

  // Generated wiki
  'public/wiki/index.html', 'public/wiki/cities.html', 'public/wiki/economy.html',
  'public/wiki/population.html', 'public/wiki/war.html',
  'public/wiki/policies.html', 'public/wiki/projects.html',

  // Tests
  'tests/run-all.js', 'tests/test-city.js', 'tests/test-population.js',
  'tests/test-economy.js', 'tests/test-military.js', 'tests/test-combat.js',
  'tests/test-policy.js', 'tests/test-tick.js', 'tests/test-persistence.js',
  'tests/test-api.js', 'tests/test-admin.js', 'tests/test-frontend.js',
];

const missing = REQUIRED.filter(f => !fs.existsSync(path.join(__dirname, f)));

// An empty file is a failed copy that looks like a successful one, and it
// produces even stranger errors than a missing file.
const empty = REQUIRED
  .filter(f => !missing.includes(f))
  .filter(f => fs.statSync(path.join(__dirname, f)).size === 0);

if (missing.length === 0 && empty.length === 0) {
  console.log(`\n  All ${REQUIRED.length} required files are present.\n`);
  console.log('  If something is still broken, it is not a missing file.');
  console.log('  Next things to check:');
  console.log('    npm test          engine, database and API');
  console.log('    npm start         the schema check runs at boot\n');
  process.exit(0);
}

console.error('\n=========================================================');
console.error('  THE CHECKOUT IS INCOMPLETE');
console.error('=========================================================\n');

if (missing.length) {
  console.error('  MISSING:');
  for (const f of missing) console.error('    ' + f);
  console.error('');
}
if (empty.length) {
  console.error('  EMPTY (a copy that failed halfway):');
  for (const f of empty) console.error('    ' + f);
  console.error('');
}

if (missing.includes('src/engine/constants.js')) {
  console.error('  NOTE: constants.js is required by every other engine module.');
  console.error('  Its absence is why unrelated suites all fail at once.\n');
}

console.error('  Restore those files and run this again.\n');
process.exit(1);
