#!/usr/bin/env node
/**
 * ============================================================================
 *  make-wiki.js — generate public/wiki/ from the engine itself
 * ============================================================================
 *
 *  WHY THIS IS A SCRIPT AND NOT HAND-WRITTEN HTML
 *
 *  A wiki that repeats numbers by hand starts drifting the first time anyone
 *  touches constants.js, and nobody notices until a player builds their nation
 *  around a figure that stopped being true three months ago. Politics & War's
 *  community wiki has exactly that problem — it was reverse-engineered, and a
 *  good part of it is wrong.
 *
 *  So every number on these pages is read out of the engine at build time, and
 *  every worked example is COMPUTED by calling the same functions the game
 *  calls. Change a constant, run `npm run wiki`, and the documentation is
 *  correct again by construction.
 *
 *  The prose lives here. The numbers never do.
 *
 *  Usage:  node make-wiki.js
 * ============================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');

const C      = require('./src/engine/constants');
const Pop    = require('./src/engine/population');
const Eco    = require('./src/engine/economy');
const City   = require('./src/engine/city');
const Mil    = require('./src/engine/military');
const Combat = require('./src/engine/combat');
const Policy = require('./src/engine/policy');

const OUT_DIR = path.join(__dirname, 'public', 'wiki');
const SITE    = 'https://playsovra.com';

// ============================================================================
// FORMATTING
// ============================================================================

const esc = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const num = (n, d = 0) => Number(n).toLocaleString('en-US', {
  minimumFractionDigits: d, maximumFractionDigits: d,
});
const money = n => '$' + num(Math.round(n));
const pct   = (n, d = 2) => num(n, d) + '%';
/** 0.92 -> "-8%",  1.15 -> "+15%",  1.125 -> "+12.5%" */
const mult = m => {
  // Round to one decimal first, then drop a trailing .0 — float noise like
  // 1.06 * 100 = 106.00000000000001 otherwise leaks into the page.
  const v = Math.round((m - 1) * 1000) / 10;
  const shown = Number.isInteger(v) ? String(v) : v.toFixed(1);
  return (v >= 0 ? '+' : '') + shown + '%';
};
const label = k => String(k).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

function table(headers, rows, opts = {}) {
  const cls = opts.class ? ` class="${opts.class}"` : '';
  return `<table${cls}>
<thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>
<tbody>
${rows.map(r => `<tr>${r.map((c, i) => `<td data-label="${esc(headers[i] || '')}">${c}</td>`).join('')}</tr>`).join('\n')}
</tbody></table>`;
}

const formula = (expr, note) =>
  `<div class="formula"><code>${esc(expr)}</code>${note ? `<span class="fnote">${note}</span>` : ''}</div>`;

const note = (title, body, kind = '') =>
  `<div class="note ${kind}"><div class="t">${title}</div><p>${body}</p></div>`;

/** A worked example, computed live. */
const worked = (title, lines) =>
  `<div class="worked"><div class="t">${title}</div>
<table class="calc">${lines.map(([l, r]) =>
  `<tr><td>${l}</td><td>${r}</td></tr>`).join('')}</table></div>`;

// ============================================================================
// PAGE TEMPLATE
// ============================================================================

const CSS = `
:root{
  --bg:#08090C; --bg2:#0C0E13; --panel:#12151C; --panel2:#171B24;
  --line:#232935; --line2:#2E3646;
  --ink:#EEF1F6; --ink2:#A9B2C3; --ink3:#6E7994;
  --gold:#F5B027; --gold-dim:#8A6413; --cyan:#4DA3FF; --red:#E2483D; --green:#3FBF7F;
}
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{background:var(--bg);color:var(--ink);font-family:'Inter',system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:16px;line-height:1.7;-webkit-font-smoothing:antialiased}
a{color:var(--gold);text-decoration:none}
a:hover{text-decoration:underline}
.wrap{max-width:1180px;margin:0 auto;padding:0 24px}
.mono{font-family:'JetBrains Mono',ui-monospace,Menlo,Consolas,monospace}

header{position:sticky;top:0;z-index:50;background:rgba(8,9,12,.86);backdrop-filter:blur(14px);border-bottom:1px solid var(--line)}
.nav{display:flex;align-items:center;justify-content:space-between;height:66px}
.brand{display:flex;align-items:baseline;gap:10px}
.brand .mark{font-family:'Orbitron',sans-serif;font-weight:900;font-size:22px;letter-spacing:.14em;color:var(--ink)}
.brand .mark span{color:var(--gold)}
.brand .sub{font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:var(--ink3);font-weight:600}
.navlinks{display:flex;align-items:center;gap:24px}
.navlinks a{font-size:14px;font-weight:500;color:var(--ink2);text-decoration:none}
.navlinks a:hover,.navlinks a.on{color:var(--gold);text-decoration:none}
.btn{display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;padding:9px 18px;border-radius:10px;background:var(--gold);color:#1A1204;text-decoration:none}
.btn:hover{text-decoration:none}

.doc-hero{padding:52px 0 32px;border-bottom:1px solid var(--line);background:linear-gradient(180deg,rgba(245,176,39,.05),transparent)}
.crumb{font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--ink3);margin-bottom:12px}
.crumb a{color:var(--gold)}
h1{font-family:'Orbitron',sans-serif;font-weight:800;font-size:clamp(28px,5vw,42px);line-height:1.15;margin-bottom:14px}
.standfirst{color:var(--ink2);font-size:17px;max-width:720px}

.layout{display:grid;grid-template-columns:240px 1fr;gap:52px;padding:44px 0 90px;align-items:start}
nav.toc{position:sticky;top:90px;border-left:1px solid var(--line);padding-left:18px}
nav.toc h4{font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:var(--ink3);margin-bottom:14px;font-weight:700}
nav.toc a{display:block;font-size:13.5px;color:var(--ink2);padding:5px 0;text-decoration:none;line-height:1.45}
nav.toc a:hover{color:var(--gold);text-decoration:none}

article{max-width:800px;min-width:0}
article section{margin-bottom:52px;scroll-margin-top:92px}
article h2{font-family:'Orbitron',sans-serif;font-weight:600;font-size:21px;margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid var(--line)}
article h3{font-size:16px;font-weight:700;margin:26px 0 8px;color:var(--ink)}
article p{color:var(--ink2);margin-bottom:14px}
article ul,article ol{color:var(--ink2);margin:0 0 14px 20px}
article li{margin-bottom:8px}
article strong{color:var(--ink);font-weight:600}
article em{color:var(--ink);font-style:italic}

.formula{background:#0A0C11;border:1px solid var(--line2);border-left:3px solid var(--cyan);border-radius:10px;padding:15px 18px;margin:16px 0;overflow-x:auto}
.formula code{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:13.5px;color:var(--ink);white-space:pre;display:block}
.formula .fnote{display:block;margin-top:9px;font-size:13px;color:var(--ink3)}

.worked{background:var(--panel);border:1px solid var(--line2);border-radius:10px;padding:16px 18px;margin:16px 0}
.worked .t{font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:var(--green);font-weight:700;margin-bottom:10px}
table.calc{width:100%;border-collapse:collapse;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:13px}
table.calc td{padding:5px 0;border:0;color:var(--ink2);white-space:normal}
table.calc td:last-child{text-align:right;color:var(--ink);font-weight:600;padding-left:14px}
table.calc tr:last-child td{border-top:1px solid var(--line);padding-top:9px;color:var(--gold)}

.note{background:var(--panel);border:1px solid var(--line2);border-left:3px solid var(--gold);border-radius:10px;padding:16px 18px;margin:18px 0}
.note p{margin-bottom:0;font-size:14.5px}
.note .t{font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:var(--gold);font-weight:700;margin-bottom:8px}
.note.warn{border-left-color:var(--red)} .note.warn .t{color:var(--red)}
.note.trap{border-left-color:var(--cyan)} .note.trap .t{color:var(--cyan)}

table{width:100%;border-collapse:collapse;font-size:14px;margin:16px 0;border:1px solid var(--line);border-radius:10px;overflow:hidden}
th{background:var(--panel2);text-align:left;font-size:10.5px;letter-spacing:.13em;text-transform:uppercase;color:var(--ink3);padding:11px 12px;font-weight:700;white-space:nowrap}
td{padding:10px 12px;border-top:1px solid var(--line);color:var(--ink2);vertical-align:top}
td:first-child{color:var(--ink);font-weight:500}
td.n{font-family:'JetBrains Mono',ui-monospace,monospace;text-align:right;white-space:nowrap}
.good{color:var(--green)} .bad{color:var(--red)} .dim{color:var(--ink3)}

.cards{display:grid;grid-template-columns:repeat(2,1fr);gap:16px;margin:26px 0}
.wcard{display:block;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:22px;text-decoration:none;transition:border-color .2s,transform .2s}
.wcard:hover{border-color:var(--gold-dim);transform:translateY(-2px);text-decoration:none}
.wcard h3{font-family:'Orbitron',sans-serif;font-size:16px;color:var(--ink);margin:0 0 8px}
.wcard p{color:var(--ink2);font-size:14px;margin:0}

footer{border-top:1px solid var(--line);padding:40px 0;background:var(--bg2)}
.legal{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;color:var(--ink3);font-size:13px}
.legal a{color:var(--ink2)}

@media (max-width:900px){
  .layout{grid-template-columns:1fr;gap:0;padding-top:28px}
  nav.toc{position:static;border-left:0;border-bottom:1px solid var(--line);padding:0 0 22px;margin-bottom:30px}
  nav.toc a{display:inline-block;margin-right:16px}
  .navlinks{display:none}
  .cards{grid-template-columns:1fr}
}
@media (max-width:640px){
  .wrap{padding:0 18px}
  .brand .sub{display:none}
  table{display:block;overflow-x:auto;white-space:nowrap}
  table.calc{white-space:normal}
}
`;

const NAV = [
  ['/wiki/', 'Wiki'],
  ['/wiki/cities.html', 'Cities'],
  ['/wiki/economy.html', 'Economy'],
  ['/wiki/population.html', 'Population'],
  ['/wiki/war.html', 'War'],
  ['/wiki/policies.html', 'Policies'],
  ['/wiki/projects.html', 'Projects'],
];

function page({ slug, title, description, h1, standfirst, sections }) {
  const url = SITE + '/wiki/' + (slug === 'index' ? '' : slug + '.html');
  const toc = sections.map(s => `<a href="#${s.id}">${esc(s.nav || s.h2)}</a>`).join('\n    ');
  const body = sections.map(s =>
    `<section id="${s.id}">\n<h2>${esc(s.h2)}</h2>\n${s.html}\n</section>`).join('\n\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${url}">
<meta name="robots" content="index, follow">
<meta name="theme-color" content="#08090C">
<meta property="og:type" content="article">
<meta property="og:site_name" content="SOVRA">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${url}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@600;800;900&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head>
<body>

<header>
  <div class="wrap nav">
    <a class="brand" href="/"><span class="mark">SOV<span>RA</span></span><span class="sub">The World Order</span></a>
    <nav class="navlinks">
      ${NAV.map(([href, text]) =>
        `<a href="${href}"${href.endsWith(slug === 'index' ? '/wiki/' : slug + '.html') ? ' class="on"' : ''}>${text}</a>`).join('\n      ')}
    </nav>
    <a class="btn" href="/login.html">Play Free</a>
  </div>
</header>

<div class="doc-hero">
  <div class="wrap">
    <p class="crumb"><a href="/">SOVRA</a> · <a href="/wiki/">Wiki</a>${slug === 'index' ? '' : ' · ' + esc(h1)}</p>
    <h1>${esc(h1)}</h1>
    <p class="standfirst">${standfirst}</p>
  </div>
</div>

<div class="wrap layout">
  <nav class="toc">
    <h4>On this page</h4>
    ${toc}
  </nav>
  <article>
${body}
  </article>
</div>

<footer>
  <div class="wrap legal">
    <span>© <span id="yr">2026</span> SOVRA — The World Order · <a href="/wiki/">Wiki</a> · <a href="/privacy.html">Privacy</a> · <a href="/terms.html">Terms</a></span>
    <span class="mono">Generated from the game engine · playsovra.com</span>
  </div>
</footer>
<script>document.getElementById('yr').textContent=new Date().getFullYear();</script>
</body>
</html>
`;
}

// ============================================================================
// PAGE: CITIES
// ============================================================================

function citiesPage() {
  const K = C.CITY;

  // Live infra cost ladder
  const infraRows = [0, 500, 1000, 1500, 2000, 3000].map(from => {
    const to = from + K.INFRA_PURCHASE_BRACKET;
    return [
      `${num(from)} &rarr; ${num(to)}`,
      money(City.infraUnitCost(from)),
      money(City.infraPurchaseCost(from, to)),
    ];
  });

  // Live city cost ladder
  const cityRows = [2, 5, 10, 15, 20, 25, 30].map(n => [
    `City ${n}`,
    money(City.nextCityCost(n - 1)),
    n <= K.FREE_CITY_COUNT ? '<span class="dim">none</span>'
                           : `${K.CITY_COOLDOWN_TURNS} turns (${K.CITY_COOLDOWN_TURNS / C.TICK.TURNS_PER_DAY} days)`,
  ]);

  const impRows = Object.entries(C.IMPROVEMENTS).map(([key, d]) => {
    const mats = d.materials && Object.keys(d.materials).length
      ? Object.entries(d.materials).map(([r, n]) => `${n} ${r}`).join(', ')
      : '<span class="dim">—</span>';
    return [
      label(key),
      d.category,
      money(d.cost),
      mats,
      d.upkeep ? money(d.upkeep) + '/day' : '<span class="dim">—</span>',
      String(d.limit),
      d.power ? '<span class="bad">yes</span>' : '<span class="dim">no</span>',
    ];
  });

  const slotsAt = i => City.improvementSlots(i);

  return page({
    slug: 'cities',
    title: 'Cities, Infrastructure and Land — SOVRA Wiki',
    description: 'How city costs work in SOVRA: the infrastructure cost curve, land brackets, the cubic new-city price, improvement slots, build limits and material costs. Every figure generated from the game engine.',
    h1: 'Cities, Infrastructure and Land',
    standfirst: 'Cities are where everything in SOVRA physically happens. Three separate cost curves govern them, and each one bends in a different place — which is why the cheapest thing to buy changes as your nation grows.',
    sections: [
      {
        id: 'slots', h2: 'Improvement slots', nav: 'Improvement slots',
        html: `
<p>Every building you own occupies a slot, and slots come from infrastructure alone. One slot per <strong>${K.INFRA_PER_IMPROVEMENT_SLOT} infrastructure</strong>, rounded down.</p>
${formula('slots = floor(infrastructure / ' + K.INFRA_PER_IMPROVEMENT_SLOT + ')')}
${table(['Infrastructure', 'Slots'], [
  [num(K.STARTING_INFRA) + ' (starting)', String(slotsAt(K.STARTING_INFRA))],
  ['50', String(slotsAt(50))],
  ['500', String(slotsAt(500))],
  ['1,000', String(slotsAt(1000))],
  ['2,000', String(slotsAt(2000))],
])}
<p>A new city starts with <strong>${num(K.STARTING_INFRA)} infrastructure</strong> and <strong>${num(K.STARTING_LAND)} land</strong>, which means <strong>${slotsAt(K.STARTING_INFRA)} slots</strong>. Your first purchase in any new city is always infrastructure, because until you have it there is nowhere to put anything.</p>
${note('Slots are the real constraint', 'Money is renewable; slots are not. Past about 1,000 infrastructure the interesting question stops being "can I afford this building" and becomes "what am I giving up to fit it". Hospitals, police stations and power plants all compete for the same space as the buildings that actually earn.')}
`,
      },
      {
        id: 'infra', h2: 'Infrastructure cost',
        html: `
<p>Infrastructure is bought in blocks of ${K.INFRA_PURCHASE_BRACKET}, and the unit price climbs with how much you already have.</p>
${formula(
`unitCost = ${K.INFRA_BASE_COST} + ((currentInfra - ${K.INFRA_OFFSET}) ^ ${K.INFRA_EXPONENT}) / ${K.INFRA_DIVISOR}`,
'The exponent is what makes tall cities expensive and wide nations viable.')}
${note('The offset quirk', `Because of the <code class="mono">- ${K.INFRA_OFFSET}</code> term, infrastructure is <em>not</em> cheapest at zero — the minimum unit price sits at exactly ${K.INFRA_OFFSET} infrastructure, which is where cities start. This is inherited from Politics &amp; War and it is not a bug.`, 'trap')}
${table(['Purchase', 'Unit cost at start', 'Total'], infraRows)}
${worked('Live from the engine — buying 100 infrastructure at 1,000', [
  ['Unit cost at 1,000 infra', money(City.infraUnitCost(1000))],
  ['Unit cost at 1,100 infra', money(City.infraUnitCost(1100))],
  ['Total for the 100 block', money(City.infraPurchaseCost(1000, 1100))],
])}
<p>Buying in exact multiples of ${K.INFRA_PURCHASE_BRACKET} is always cheapest. Buying 397 units instead of 400 costs you more per unit for no benefit, and the game will warn you before it charges.</p>
`,
      },
      {
        id: 'land', h2: 'Land cost',
        html: `
<p>Land does two things: it raises the ceiling on farm output, and it lowers population density, which is the single biggest lever on disease.</p>
${formula(
`unitCost = ${K.LAND_BASE_COST} + ${K.LAND_QUADRATIC_COEFF} * (currentLand - ${K.LAND_OFFSET})^2`,
`Charged in brackets of ${num(K.LAND_PURCHASE_BRACKET)}; the first bracket is ${num(K.LAND_FIRST_BRACKET)} because cities spawn with that much.`)}
${table(['Land held', 'Unit cost'], [250, 500, 1000, 2000, 3000].map(l =>
  [num(l), money(City.landUnitCost(l))]))}
${worked('Live from the engine — 250 to 1,000 land', [
  ['Bracket 250 &rarr; 500', money(City.landPurchaseCost(250, 500))],
  ['Bracket 500 &rarr; 1,000', money(City.landPurchaseCost(500, 1000))],
  ['Total', money(City.landPurchaseCost(250, 1000))],
])}
<p>Land is quadratic rather than exponential, so it stays affordable far longer than infrastructure does. For most cities the correct reflex when disease appears is <strong>buy land, not hospitals</strong> — hospitals cost a slot, land does not.</p>
`,
      },
      {
        id: 'newcity', h2: 'Founding a new city', nav: 'New city cost',
        html: `
<p>New cities are the game's main long-term money sink, and the price is cubic in how many you already have.</p>
${formula(
`cost = ${num(K.CITY_COST_CUBIC)} * (X - 1)^3 + ${num(K.CITY_COST_LINEAR)} * X + ${num(K.CITY_COST_CONSTANT)}
      where X = your current city count`)}
${table(['Buying', 'Cost', 'Cooldown after'], cityRows)}
<p>Your first <strong>${K.FREE_CITY_COUNT} cities</strong> have no timer. From city ${K.FREE_CITY_COUNT + 1} onwards each purchase locks the next one for <strong>${K.CITY_COOLDOWN_TURNS} turns</strong> — ${K.CITY_COOLDOWN_TURNS / C.TICK.TURNS_PER_DAY} days.</p>
${note('Discount order matters', `Project discounts (Urban Planning and friends) are <strong>flat subtractions</strong> and they stack. The Manifest Destiny policy is a <strong>multiplier</strong>. The engine applies the flat discounts first, then the multiplier — applying them the other way round produces a materially different price, and it is a classic source of bugs in this genre. Cost never falls below ${money(K.CITY_COST_FLOOR)}.`, 'trap')}
`,
      },
      {
        id: 'improvements', h2: 'Every improvement', nav: 'Improvement table',
        html: `
<p>Costs, limits and power requirements for all ${Object.keys(C.IMPROVEMENTS).length} buildings. "Power" means the building produces nothing at all in an unpowered city — it still costs upkeep.</p>
${table(['Improvement', 'Category', 'Money', 'Materials', 'Upkeep', 'Limit/city', 'Needs power'], impRows)}
`,
      },
      {
        id: 'materials', h2: 'Why buildings cost steel', nav: 'Material costs',
        html: `
<p>Commerce, civil and military buildings cost <strong>refined materials</strong> as well as money. Raw extraction and manufacturing buildings cost money only.</p>
<p>That asymmetry is deliberate. If a steel mill required steel, a new player with no industry could never start one — a chicken-and-egg trap with no exit. And if nothing consumed refined goods domestically, manufacturing would exist purely to sell on the market, which makes a rich nation able to skip industry entirely and simply buy its way to maximum commerce.</p>
<p>As it stands, growth costs production time rather than only cash, and steel and aluminium have a use even when the market price is bad.</p>
${note('Barracks are deliberately free of materials', `Soldiers are the one military unit a nation with no industry can still raise. A player who has been bombed flat needs a route back to defending themselves, and ${money(C.IMPROVEMENTS.barracks.cost)} with no material cost is that route.`)}
<p>Demolishing returns <strong>${C.CITY.DEMOLITION_SALVAGE_RATE * 100}% of the materials</strong> and <strong>no money</strong>. A full refund would let you launder value by cycling build and demolish; a zero refund would make one misclick on a ${num(C.IMPROVEMENTS.drydock.materials.steel)}-steel drydock unrecoverable.</p>
`,
      },
    ],
  });
}

// ============================================================================
// PAGE: POPULATION
// ============================================================================

function populationPage() {
  const P = C.POPULATION;

  const healthy = { infrastructure: 1000, land: 2000, improvements: {} };
  const cramped = { infrastructure: 1000, land: 300,  improvements: {} };
  const bHealthy = Pop.populationBreakdown(healthy, { cityAgeDays: 365 });
  const bCramped = Pop.populationBreakdown(cramped, { cityAgeDays: 365 });

  const densityRows = [50, 100, 200, 333, 500, 1000].map(d => {
    const raw = (P.DISEASE_DENSITY_COEFF * d * d - P.DISEASE_DENSITY_OFFSET) / 100;
    return [num(d), pct(raw, 2)];
  });

  const ageRows = [1, 30, 100, 200, 365, 1000].map(d =>
    [num(d), '&times;' + num(Pop.ageMultiplier(d), 3),
     '<span class="' + (Pop.ageMultiplier(d) > 1 ? 'good' : 'dim') + '">' +
       mult(Pop.ageMultiplier(d)) + '</span>']);

  const landFor = Pop.landNeededForZeroDisease({ infrastructure: 200, land: 250, improvements: {} });
  const floorBig = Pop.minimumAchievableDiseasePercent({ infrastructure: 2000, land: 250, improvements: {} });
  const hospNeeded = Pop.hospitalsNeededForZeroDisease({ infrastructure: 1000, land: 400, improvements: {} });

  return page({
    slug: 'population',
    title: 'Population, Disease and Crime — SOVRA Wiki',
    description: 'How population works in SOVRA: base population from infrastructure, the squared density term that drives disease, crime, the city age multiplier, and exactly how much land you need to reach zero disease.',
    h1: 'Population, Disease and Crime',
    standfirst: 'Population is not a resource you store — it is recomputed from your city every turn. Nothing is remembered, so nothing can silently drift. Understand the density term and you understand most of SOVRA\'s city planning.',
    sections: [
      {
        id: 'base', h2: 'Base population',
        html: `
<p>Infrastructure creates people. Age adds a slow drift on top.</p>
${formula(
`base = (infra * ${P.PER_INFRA}) + (infra / ${num(P.AGE_DIVISOR)}) * (100 * ageDays / ${P.AGE_FACTOR})`)}
${worked('Live from the engine', [
  ['1,000 infra, day 0', num(Pop.basePopulation(1000, 0))],
  ['1,000 infra, day 365', num(Pop.basePopulation(1000, 365))],
  ['2,000 infra, day 365', num(Pop.basePopulation(2000, 365))],
])}
<p>This is the number every other term in this page reduces. Disease and crime kill a fraction of the <em>base</em>, and the age multiplier scales what survives.</p>
`,
      },
      {
        id: 'density', h2: 'Density and disease', nav: 'Density &amp; disease',
        html: `
<p>Density is infrastructure per unit of land, scaled by 100.</p>
${formula(`density = (infra * ${P.PER_INFRA}) / land`)}
${formula(
`diseaseRate% = (${P.DISEASE_DENSITY_COEFF} * density^2 - ${P.DISEASE_DENSITY_OFFSET}) / 100 * 100
             + infra / ${num(P.DISEASE_INFRA_TERM_DIVISOR)}
             - hospitals * ${P.DISEASE_HOSPITAL_REDUCTION}
             + pollution * ${P.DISEASE_POLLUTION_COEFF}`,
'Clamped to 0–100%. Deaths = rate &times; infra &times; ' + P.DISEASE_DEATH_MULTIPLIER + '.')}
<p>The <strong>squared</strong> density term is the most load-bearing line in the game. It is what makes land worth buying, what forces hospitals into the slot competition, and what turns pollution into a real cost rather than a cosmetic number.</p>
${table(['Density', 'Disease from density alone'], densityRows)}
${note('Density ignores live population — deliberately', 'Disease is computed from infrastructure and land, never from the current population. If it fed back on live population you would get an oscillation: people die, density falls, disease falls, people return, density rises. The city would never settle. Because the inputs are static, evaluating the same city twice always gives the same answer.', 'trap')}
${worked('Live from the engine — same infrastructure, different land', [
  ['Healthy: 1,000 infra / 2,000 land — density', num(bHealthy.density, 1)],
  ['&nbsp;&nbsp;disease', pct(bHealthy.diseaseRatePercent, 2)],
  ['&nbsp;&nbsp;final population', num(bHealthy.population)],
  ['Cramped: 1,000 infra / 300 land — density', num(bCramped.density, 1)],
  ['&nbsp;&nbsp;disease', pct(bCramped.diseaseRatePercent, 2)],
  ['&nbsp;&nbsp;final population', num(bCramped.population)],
  ['Cost of getting it wrong', num(bHealthy.population - bCramped.population) + ' people'],
])}
`,
      },
      {
        id: 'floor', h2: 'The disease floor', nav: 'The disease floor',
        html: `
<p>As density approaches zero the squared term vanishes, leaving a floor that land can never get below:</p>
${formula(
`floor% = -${P.DISEASE_DENSITY_OFFSET / 100 * 100} + infra / ${num(P.DISEASE_INFRA_TERM_DIVISOR)} - hospitals * ${P.DISEASE_HOSPITAL_REDUCTION} + pollution * ${P.DISEASE_POLLUTION_COEFF}`)}
<p>The infrastructure term is the reason. Past roughly ${num(P.DISEASE_DENSITY_OFFSET / 100 * P.DISEASE_INFRA_TERM_DIVISOR)} infrastructure, <strong>no amount of land reaches 0% disease</strong>. That is not a bug — it is the mechanism that forces hospitals into a large city's improvement slots.</p>
${worked('Live from the engine', [
  ['200 infra: land needed for 0% disease', landFor === null ? 'unreachable' : num(Math.ceil(landFor)) + ' land'],
  ['2,000 infra: best possible with land alone', pct(floorBig, 2)],
  ['1,000 infra / 400 land: hospitals for 0%', hospNeeded === null ? 'unreachable' : String(hospNeeded)],
])}
<p>Each hospital removes a flat <strong>${P.DISEASE_HOSPITAL_REDUCTION}%</strong>, and the Clinical Research Center project removes another ${P.DISEASE_HOSPITAL_REDUCTION}% on top.</p>
`,
      },
      {
        id: 'crime', h2: 'Crime',
        html: `
<p>Crime is the mirror of disease: it rises with population and falls with commerce and police stations.</p>
${formula(
`crime% = ((${P.CRIME_COMMERCE_CEILING} - commerce)^2 + basePop * ${P.CRIME_POP_COEFF}) / ${num(P.CRIME_DIVISOR)}
        - police * ${P.CRIME_POLICE_REDUCTION}`,
'Crime deaths are weighted &times;' + P.CRIME_DEATH_WEIGHT + ' — a percent of crime hurts far more than a percent of disease.')}
<p>The squared commerce term makes commerce buildings do double duty: they raise income <em>and</em> suppress crime, so a developed city is safer as well as richer. That is a better incentive than a flat penalty, and it means the answer to a crime problem is often "build a bank", not "build a police station".</p>
${table(['Commerce', 'Crime at 110k population'],
  [0, 50, 100].map(c => [String(c),
    pct(Pop.crimeRatePercent({ infrastructure: 1100, land: 2000, improvements: {} },
      { commerce: c, cityAgeDays: 0 }), 3)]))}
${note('Unverified', 'The crime equation is our own — Politics &amp; War has never published theirs. The shape is a large improvement on a linear version, which made large cities lose an absurd fraction of their people every turn, but the coefficients are still being tuned.', 'warn')}
`,
      },
      {
        id: 'age', h2: 'City age',
        html: `
<p>Old cities are worth more. The multiplier is logarithmic, so it is negligible early and becomes a real retention reward later.</p>
${formula(`multiplier = 1 + ln(ageDays) / ${P.AGE_LOG_DIVISOR}`)}
${table(['City age (days)', 'Multiplier', 'Effect'], ageRows)}
<p>Because it is logarithmic rather than linear, an old city can never run away with the game — but abandoning a mature city to found a fresh one always costs you something real.</p>
${note('A dead city floors, it does not vanish', `Population can never fall below <strong>${P.MIN_POPULATION}</strong>. Even at 100% disease the city survives as a shell you can rebuild from, rather than disappearing and taking its improvements with it.`)}
`,
      },
      {
        id: 'order', h2: 'How it all assembles', nav: 'Order of operations',
        html: `
${formula(
`base       = basePopulation(infra, ageDays)
survivors  = base - diseaseDeaths - (crimeDeaths * ${P.CRIME_DEATH_WEIGHT})
population = max(survivors * ageMultiplier, ${P.MIN_POPULATION})`)}
<p>Order matters: the age multiplier applies to <em>survivors</em>, not to the base. A city that is losing people to density loses the age bonus on those people too, which is why a badly shaped old city underperforms a well-shaped young one far more than the raw numbers suggest.</p>
<p>Every one of these figures is shown, expanded, on your population page in game. You never have to trust this wiki over what the game tells you — they are generated from the same code.</p>
`,
      },
    ],
  });
}

// ============================================================================
// PAGE: ECONOMY
// ============================================================================

function economyPage() {
  const E = C.ECONOMY;

  const incomeRows = [0, 25, 50, 75, 100].map(c =>
    [String(c), '$' + num(Eco.averageIncomePerDay(c), 3),
     money(Eco.averageIncomePerDay(c) * 100000)]);

  const recipeRows = Object.entries(C.RECIPES).map(([res, r]) => [
    label(res),
    label(r.improvement),
    Object.entries(r.inputs).map(([k, v]) => `${v} ${k}`).join(' + '),
    String(r.output),
    num(r.output / Object.values(r.inputs).reduce((a, b) => a + b, 0), 2) + '&times;',
  ]);

  const powerRows = Object.entries(C.IMPROVEMENTS)
    .filter(([, d]) => d.category === 'power')
    .map(([k, d]) => [
      label(k),
      d.fuel ? label(d.fuel) : '<span class="good">none</span>',
      num(d.infraCapacity),
      money(d.cost),
      money(d.upkeep) + '/day',
      String(d.pollution),
    ]);

  const stackRows = [1, 2, 3, 4, 5].map(n => [
    String(n),
    mult(1 + Eco.stackingBonus(n, 'steel_mill')),
    mult(1 + Eco.stackingBonus(n, 'coal_mine')),
  ]);

  const upkeepRows = Object.entries(C.UNITS)
    .filter(([, d]) => d.upkeepPeace)
    .map(([k, d]) => [
      label(k),
      money(d.upkeepPeace) + '/day',
      money(d.upkeepWar) + '/day',
      mult(d.upkeepWar / d.upkeepPeace),
    ]);

  return page({
    slug: 'economy',
    title: 'Economy, Income and Production — SOVRA Wiki',
    description: 'How money and resources work in SOVRA: the commerce-to-income formula, power requirements, raw extraction and refining chains, stacking bonuses, upkeep and the food penalty. Generated from the game engine.',
    h1: 'Economy, Income and Production',
    standfirst: 'Money comes from people, and people come from cities. Everything else in the economy is a chain: raw resources feed refining, refining feeds construction, and power sits underneath all of it as a hard on/off switch.',
    sections: [
      {
        id: 'income', h2: 'Income',
        html: `
<p>Income is paid on the daily rollover, not every turn. It is per-capita and scales with your commerce rate.</p>
${formula(
`incomePerCapitaPerDay = ((commerce / ${E.COMMERCE_DIVISOR}) * ${E.INCOME_PER_CAPITA_BASE}) + ${E.INCOME_PER_CAPITA_BASE}
income = incomePerCapitaPerDay * population`)}
${table(['Commerce', 'Per capita / day', 'Income at 100k people'], incomeRows)}
<p>Note the shape: at commerce ${E.COMMERCE_DIVISOR} you earn exactly <strong>double</strong> the base rate. Commerce caps at <strong>${E.COMMERCE_MAX}%</strong>, or ${E.COMMERCE_MAX_WITH_ITC}% with the International Trade Center project.</p>
${note('The 1000&times; trap', `Politics &amp; War documents a "Minimum Wage" of ${num(E.MINIMUM_WAGE)}. That figure is for display only — the real per-capita constant in the income formula is <strong>${E.INCOME_PER_CAPITA_BASE}</strong>. The thousandfold difference comes from the tax rate cancelling out. Anyone reimplementing these formulas from the wiki hits this, and the resulting nation earns a thousand times too much.`, 'trap')}
`,
      },
      {
        id: 'power', h2: 'Power',
        html: `
<p>Power is not a modifier. It is a threshold, and it is the most common reason a new player's city earns nothing.</p>
${formula(
`powered = totalInfraCapacity >= cityInfrastructure
fuelBurnedPerTurn = ${C.POWER.FUEL_PER_TURN_PER_100_INFRA} per ${C.POWER.INFRA_UNIT} infrastructure covered`)}
${table(['Plant', 'Fuel', 'Infra covered', 'Cost', 'Upkeep', 'Pollution'], powerRows)}
${note('501 infrastructure, one coal plant, nothing works', `A coal plant covers exactly ${num(C.IMPROVEMENTS.coal_power.infraCapacity)} infrastructure. At ${num(C.IMPROVEMENTS.coal_power.infraCapacity)} you are fine. At ${num(C.IMPROVEMENTS.coal_power.infraCapacity + 1)} the city is unpowered and <strong>every</strong> manufacturing, civil and commerce building in it produces nothing — while still charging full upkeep. This is the single most expensive mistake available to a new player.`, 'warn')}
<p>A plant with no fuel does not partially work. It produces no power and burns no fuel, and everything downstream of it goes idle. Mixed plant types are worst: if one type runs dry the whole city blacks out. Wind power needs no fuel at all, which is why it is worth its price in a nation that cannot reliably supply coal.</p>
<p>Your ledger names which of the two problems you have — not enough capacity, or no fuel for the capacity you built.</p>
`,
      },
      {
        id: 'production', h2: 'Raw extraction and refining', nav: 'Production chains',
        html: `
<p>Raw extraction works without power. Refining does not.</p>
${table(['Resource', 'Building', 'Inputs / day', 'Output / day', 'Ratio'], recipeRows)}
<p>Manufacturing is far more profitable than extraction, and that gap is what creates the economy's tier structure: raw exporters at the bottom, refiners in the middle, consumers at the top. A nation that only mines is choosing to be someone else's supplier.</p>
<h3>Farms are different</h3>
<p>Farm output scales with <strong>land</strong>, not a flat rate.</p>
${formula(`foodPerTurn = land / ${C.FARM.LAND_DIVISOR_PER_TURN}` +
  `\n            = land / ${C.FARM.LAND_DIVISOR_IRRIGATED}   (with Mass Irrigation)`)}
<p>Antarctica produces <strong>${(1 - C.CONTINENTS.antarctica.foodPenalty) * 100}% less food</strong> than everywhere else. Choose it only if you intend to import.</p>
${note('Nothing is produced from nothing', 'A refinery with no inputs produces zero and consumes zero — it never drives a stockpile negative. Mines can feed refineries in the same turn, so a self-sufficient chain works, but only if the mines actually produce enough that turn.')}
`,
      },
      {
        id: 'stacking', h2: 'Stacking bonuses', nav: 'Stacking bonuses',
        html: `
<p>Building several of the same improvement in one city pays a specialisation bonus.</p>
${table(['Count', 'Manufacturing', 'Raw extraction'], stackRows)}
<p>Manufacturing gains <strong>${C.STACKING.MANUFACTURING_STEP_BONUS * 100}%</strong> per building past the first, capping at <strong>${C.STACKING.MANUFACTURING_MAX_BONUS * 100}%</strong>. Raw extraction reaches <strong>${C.STACKING.RAW_MAX_BONUS * 100}%</strong> at its build limit.</p>
<p>This is how SOVRA gets distinct nation archetypes without any explicit class system. Spreading one of everything across a city is always worse than committing to something.</p>
`,
      },
      {
        id: 'costs', h2: 'What drains the treasury', nav: 'Upkeep &amp; food',
        html: `
<h3>Military upkeep</h3>
<p>Paid daily, and it rises when you are at war.</p>
${table(['Unit', 'Peace', 'War', 'Increase'], upkeepRows)}
${note('Upkeep is a real constraint', 'If you cannot pay, units desert. The engine does not let you run a negative balance and quietly carry on — an army you cannot afford is an army you do not keep. Money floors at zero and the desertion is proportional.', 'warn')}
<h3>Food</h3>
${formula(
`civilians:  ${num(1 / E.FOOD_PER_POPULATION_PER_TURN)} people eat 1 food per turn
soldiers:   1 / ${num(1 / C.UNITS.soldiers.foodPerUnitPeace)} per soldier at peace, 1 / ${num(1 / C.UNITS.soldiers.foodPerUnitWar)} at war`)}
<p>Running out of food costs you <strong>${num((1 - E.OUT_OF_FOOD_PENALTY) * 100, 0)}% of gross income</strong>. That single penalty is what makes food strategic rather than an afterthought, and it is why a war fought without a food supply collapses on its own.</p>
<h3>Improvement upkeep</h3>
<p>Every building charges upkeep every day whether it produces anything or not. An unpowered city is not merely idle — it is actively losing money.</p>
`,
      },
      {
        id: 'ledger', h2: 'The derivation ledger', nav: 'The ledger',
        html: `
<p>Everything above is visible in game, expanded. The economy page does not show you one income figure — it shows you which building earned what, which resource runs out in how many turns at your current burn rate, and, for anything producing nothing, <em>why</em>.</p>
<ul>
  <li><strong>Per-building attribution</strong> — every line traces to the improvement that caused it</li>
  <li><strong>Resource runway</strong> — turns remaining per resource, not just a rate</li>
  <li><strong>Idle diagnosis</strong> — missing input, no power, or policy penalty, named explicitly</li>
  <li><strong>Material costs</strong> — what a building will consume, before you commit</li>
</ul>
<p>This is the main thing SOVRA does differently. Politics &amp; War hides the arithmetic and lets the community reverse-engineer it into spreadsheets that are half wrong. We would rather just show you.</p>
`,
      },
    ],
  });
}

// ============================================================================
// PAGE: WAR
// ============================================================================

function warPage() {
  const M = C.COMBAT;

  const scoreRows = Object.entries(C.SCORE.MILITARY).map(([k, v]) => [
    label(k), num(v, 4),
    (k === 'missiles' || k === 'nukes')
      ? `capped at ${C.SCORE.MISSILE_SCORE_CAP}` : '<span class="dim">—</span>',
  ]);

  const range = Mil.warRange(1000);
  const vuln  = Mil.vulnerableToRange(1000);

  const oddsRows = [0.5, 0.8, 1.0, 1.5, 2.0, 2.5].map(r => {
    const o = Combat.battleOdds(1000 * r, 1000, 4000, 424242);
    return [num(r, 1) + '&times;',
      pct(o.utterFailure * 100, 1), pct(o.pyrrhicVictory * 100, 1),
      pct(o.moderateSuccess * 100, 1), pct(o.immenseTriumph * 100, 1),
      '<strong>' + pct(o.anyVictory * 100, 1) + '</strong>'];
  });

  const mapRows = Object.entries(M.MAP_COST).map(([k, v]) =>
    [label(k), String(v), `${v} turns of regen`]);

  const warTypeRows = Object.entries(C.WAR_TYPES).map(([k, v]) =>
    [label(k), '&times;' + num(v.infraDamage, 2), '&times;' + num(v.loot, 2)]);

  const resRows = Object.entries(M.RESISTANCE_LOSS).map(([k, v]) =>
    [label(k), String(v), num(Math.ceil(M.RESISTANCE_START / v))]);

  const espRows = Object.entries(C.ESPIONAGE.OPERATION_MODIFIER).map(([k, v]) =>
    [label(k), '&divide;' + num(v, 1)]);

  return page({
    slug: 'war',
    title: 'War, Combat and Espionage — SOVRA Wiki',
    description: 'How war works in SOVRA: score and war range, military action points, the three-roll battle system, infrastructure damage and its cap, loot, control states, resistance, beige and espionage odds. Generated from the game engine.',
    h1: 'War, Combat and Espionage',
    standfirst: 'Wars in SOVRA run over days, not minutes. You cannot be knocked out in one hit, you cannot be attacked by someone overwhelmingly larger, and every battle roll is stored so any fight can be replayed and audited afterwards.',
    sections: [
      {
        id: 'score', h2: 'Score', nav: 'Score',
        html: `
<p>Score is both a power rating and a matchmaking weight. That dual role is the most important thing to understand about it.</p>
${formula(
`score = ${C.SCORE.BASE}
      + (cityCount - 1) * ${C.SCORE.PER_CITY}
      + totalInfrastructure / ${C.SCORE.INFRA_DIVISOR}
      + projects * ${C.SCORE.PER_PROJECT}
      + militaryScore`)}
${table(['Unit', 'Score each', 'Cap'], scoreRows)}
${note('Ships are a trap', `A ship is worth <strong>${C.SCORE.MILITARY.ships}</strong> score — ${num(C.SCORE.MILITARY.ships / C.SCORE.MILITARY.tanks, 0)}&times; a tank. Building a navy pushes you up into the war range of much larger nations without giving you a proportionate ability to fight them. Soldiers are the most score-efficient unit in the game by a wide margin.`, 'trap')}
`,
      },
      {
        id: 'range', h2: 'War range',
        html: `
<p>You can declare on anyone from <strong>${(C.WAR_RANGE.MIN_MULTIPLIER * 100 - 100).toFixed(0)}% below</strong> to <strong>${(C.WAR_RANGE.MAX_MULTIPLIER * 100 - 100).toFixed(0)}% above</strong> your score.</p>
${worked('A nation at score 1,000', [
  ['Can attack', num(range.min) + ' — ' + num(range.max)],
  ['Can be attacked by', num(vuln.min, 1) + ' — ' + num(vuln.max, 1)],
])}
<p>The range is asymmetric on purpose: you can always be hit by someone meaningfully bigger, never by someone overwhelmingly bigger. It is the anti-griefing backbone of the whole game, and it is the reason score management is a real strategic decision rather than a number that only goes up.</p>
<p>You hold <strong>${M.OFFENSIVE_WAR_SLOTS} offensive war slots</strong> (${M.OFFENSIVE_WAR_SLOTS_PIRATE} with the Pirate Economy project) and can be attacked in at most <strong>${M.DEFENSIVE_WAR_SLOTS}</strong> at once.</p>
`,
      },
      {
        id: 'map', h2: 'Military Action Points', nav: 'Action points (MAP)',
        html: `
<p>Attacks cost MAP. You regain <strong>${M.MAP_PER_TURN} per turn</strong> up to a maximum of <strong>${M.MAP_MAX}</strong>, so a full bar takes ${M.MAP_MAX} turns — ${num(M.MAP_MAX / C.TICK.TURNS_PER_DAY, 1)} days.</p>
${table(['Action', 'MAP cost', 'Equivalent'], mapRows)}
<p>This is the mechanism that makes wars take days. You cannot save up an infinite reserve and delete someone in an afternoon, and you cannot be deleted while you sleep.</p>
`,
      },
      {
        id: 'rolls', h2: 'The three-roll system', nav: 'Three rolls',
        html: `
<p>Every battle is decided by <strong>${M.ROLL_COUNT} independent rolls</strong>. Each side rolls a random fraction of its army value, between <strong>${M.ROLL_MIN_FRACTION * 100}% and ${M.ROLL_MAX_FRACTION * 100}%</strong>, and the higher roll wins that exchange.</p>
${table(['Rolls won', 'Result'], [
  ['0', 'Utter Failure — no damage at all'],
  ['1', 'Pyrrhic Victory'],
  ['2', 'Moderate Success'],
  ['3', 'Immense Triumph — full damage, control state granted'],
])}
<p>Damage scales with the tier: an Immense Triumph deals full damage, a Pyrrhic Victory deals a third of it, an Utter Failure deals none.</p>
<h3>What the odds actually look like</h3>
<p>Simulated live, ${num(4000)} battles per row, attacker army value relative to defender:</p>
${table(['Ratio', 'Utter Failure', 'Pyrrhic', 'Moderate', 'Immense', 'Any win'], oddsRows)}
${note('Why the band is 40–100%', 'This is the master tuning knob of the entire game. Widen it and combat becomes coin-flippy; narrow it and combat is pure arithmetic with no reason to ever fight an even match. At 40–100%, a 2.5&times; advantage is a near-certain sweep, but anything below that stays genuinely uncertain — and an underdog can still win.', 'trap')}
${note('Every battle is reproducible', 'The random seed for each battle is stored. Any fight can be replayed and will produce the identical result, down to the casualty counts. If you think a result was wrong, it can be checked rather than argued about.')}
`,
      },
      {
        id: 'damage', h2: 'Damage and its cap', nav: 'Damage',
        html: `
${formula(
`damage = (attackerValue - defenderValue * ${M.DEFENDER_DAMAGE_OFFSET}) * coefficient
       * jitter(${M.DAMAGE_JITTER_MIN}–${M.DAMAGE_JITTER_MAX}) * (rollsWon / ${M.VICTORY_TYPE_DIVISOR})`)}
${formula(`cap = cityInfrastructure * ${M.INFRA_DAMAGE_CAP_FRACTION} + ${M.INFRA_DAMAGE_CAP_CONSTANT}`,
'Per battle, per city. No city can be destroyed in a single hit — this is what makes wars multi-day affairs.')}
<p>The attack always targets your <strong>highest-infrastructure city</strong>. Airstrikes aimed at anything other than infrastructure deal ${num(M.AIRSTRIKE_NON_INFRA_MULTIPLIER * 100, 0)}% collateral damage to it. On an Immense Triumph there is a <strong>${M.IMPROVEMENT_DESTROY_CHANCE * 100}% chance</strong> per battle of destroying an improvement outright.</p>
<h3>Missiles and nuclear weapons</h3>
<p><strong>Neither of these rolls.</strong> The three-roll system exists because two armies MEET — each commits a random fraction of its strength and the better commitment wins. Nothing meets a missile. Rolling for it would borrow a mechanic from a situation that is not happening, and would make the most expensive weapon in the game the least reliable one.</p>
<p>A launch either arrives or is intercepted, and interception is a property of the defender's projects rather than a contest.</p>
${table(['Weapon', 'Action points', 'Infrastructure destroyed', 'Buildings', 'Resistance', 'Intercepted by'], [
  ['Missile', String(C.COMBAT.MAP_COST.missile_launch),
   `${num(C.COMBAT.MISSILE.INFRA_FRACTION * 100)}% of the city + ${num(C.COMBAT.MISSILE.INFRA_FLAT)}`,
   C.COMBAT.MISSILE.IMPROVEMENTS_DESTROYED ? String(C.COMBAT.MISSILE.IMPROVEMENTS_DESTROYED) : '<span class="dim">none</span>',
   String(C.COMBAT.RESISTANCE_LOSS.missile_launch),
   `Iron Dome (${C.PROJECTS.iron_dome.effect.missileInterceptChance * 100}%)`],
  ['Nuclear strike', String(C.COMBAT.MAP_COST.nuclear_attack),
   `${num(C.COMBAT.NUKE.INFRA_FRACTION * 100)}% of the city + ${num(C.COMBAT.NUKE.INFRA_FLAT)}`,
   String(C.COMBAT.NUKE.IMPROVEMENTS_DESTROYED),
   String(C.COMBAT.RESISTANCE_LOSS.nuclear_attack),
   `Vital Defense System (${C.PROJECTS.vital_defense_system.effect.nukeInterceptChance * 100}%)`],
])}
${note('The weapon is spent even when it is shot down', 'If interception refunded the missile, the defence project would buy delay rather than safety and the attacker would simply fire again next turn at no cost. Iron Dome and the Vital Defense System stop the damage, not the expense.', 'trap')}
<h3>Building them</h3>
<p>A missile needs the <strong>Missile Launch Pad</strong> project; a nuclear weapon needs the <strong>Nuclear Research Facility</strong>. Neither uses a recruitment building — the project itself is the gate.</p>
${table(['Weapon', 'Cost each', 'Built per day', 'Score each'], [
  ['Missile',
   Object.entries(C.UNITS.missiles.cost).map(([r, v]) => r === 'money' ? money(v) : `${num(v)} ${r}`).join(' + '),
   String(C.UNITS.missiles.perDay), String(C.SCORE.MILITARY.missiles)],
  ['Nuclear weapon',
   Object.entries(C.UNITS.nukes.cost).map(([r, v]) => r === 'money' ? money(v) : `${num(v)} ${r}`).join(' + '),
   String(C.UNITS.nukes.perDay), String(C.SCORE.MILITARY.nukes)],
])}
<p>The daily rate is the real constraint, not the price. A stockpile has to be something you planned days ago, not something you bought the morning you needed it — that is what makes it a strategic weapon rather than an expensive one. Score from missiles and nukes each cap at ${C.SCORE.MISSILE_SCORE_CAP}, so hoarding past a point buys war range and nothing else.</p>

<p>Both still respect the per-city damage cap, and on top of it no single strike may remove more than <strong>${C.COMBAT.STRIKE_MAX_FRACTION_OF_CITY * 100}%</strong> of a city's current infrastructure. The cap alone is not enough: its flat term is larger than half of a small city, so without the second limit a nuclear strike erased a small city outright. <em>No city dies in one hit</em> has to hold at every city size.</p>

<h3>Radiation — the reason nuclear weapons are a political problem</h3>
<p>A nuclear strike adds <strong>${C.RADIATION.PER_NUKE_CONTINENT} Roentgen to the continent it lands on</strong> and <strong>${C.RADIATION.PER_NUKE_GLOBAL} to the entire world</strong>, dissipating over ${C.RADIATION.DISSIPATION_TURNS} turns. Radiation raises disease and cuts food output everywhere it reaches.</p>
<p>That means every nation pays part of the price for a war it had no part in. This is the only consequence in SOVRA that lands on people who were not consulted, and it is deliberate: it is what turns "should we use nukes" from an arithmetic question into a diplomatic one.</p>
<p>The Fallout Shelter project reduces the blast by ${num((1 - C.PROJECTS.fallout_shelter.effect.nukeDamageMultiplier) * 100)}% and shortens the fallout by ${num((1 - C.PROJECTS.fallout_shelter.effect.falloutDurationMultiplier) * 100)}%.</p>

<h3>War type — declared up front</h3>
${table(['War type', 'Infrastructure damage', 'Loot'], warTypeRows)}
<p>One enum field, chosen at declaration, that creates genuinely distinct playstyles. Attrition maximises destruction and minimises what you take home; a raid is the exact inverse.</p>
`,
      },
      {
        id: 'supply', h2: 'The supply rule', nav: 'Supply',
        html: `
${note('The most important rule in SOVRA combat', 'An unsupplied unit contributes <strong>zero</strong> army value but <strong>still takes casualties</strong>. One clause makes logistics mandatory without needing a separate logistics system.', 'warn')}
<p>Tanks need munitions and gasoline. Aircraft and ships need more of both. Soldiers fight unarmed at reduced value, so an army with no munitions is not helpless — but it is a fraction of its paper strength.</p>
${table(['Unit', 'Munitions / battle', 'Gasoline / battle'],
  Object.entries(C.UNITS).filter(([, d]) => d.battleConsumption).map(([k, d]) => [
    label(k),
    d.battleConsumption.munitions ? num(d.battleConsumption.munitions, 4) : '<span class="dim">—</span>',
    d.battleConsumption.gasoline ? num(d.battleConsumption.gasoline, 4) : '<span class="dim">—</span>',
  ]))}
<p>Supply is allocated to <strong>vehicles before soldiers</strong>, and that priority is derived rather than assumed: a tank converts each munition into more army value than a soldier does, so a limited stockpile is worth more in the tanks. The engine checks this rather than hard-coding it.</p>
${formula(
`armyValue = unarmedSoldiers * ${M.ARMY_VALUE.UNARMED_SOLDIER}
          + armedSoldiers * ${M.ARMY_VALUE.ARMED_SOLDIER}
          + tanks * ${M.ARMY_VALUE.TANK}
          + defenderPopulation / ${M.DEFENDER_MILITIA_DIVISOR}   (defender only)`)}
`,
      },
      {
        id: 'control', h2: 'Control states', nav: 'Control states',
        html: `
<p>Winning a battle outright grants a persistent debuff on your opponent rather than a damage multiplier.</p>
${table(['State', 'Won by', 'If you hold it', 'If they hold it'], Object.entries(C.CONTROL_STATES).map(([k, v]) =>
  [v.name || label(k), label(v.from), v.holding || '', v.suffering || '']))}
<h3>Fortifying</h3>
<p>Digging in costs <strong>${C.COMBAT.MAP_COST.fortify} action points</strong> and raises the casualties an attacker takes against you by <strong>${C.COMBAT.FORTIFY_CASUALTY_INCREASE * 100}%</strong>. It ends the moment you attack, so it cannot be stacked with offence — a turn is a real choice between hitting back and holding on.</p>
<p>It costs the same as a ground battle deliberately. A free defensive action taken every single turn is not a decision, and a defender with no decisions is just a target.</p>
${note('The comeback clause', 'Only an <strong>Immense Triumph</strong> grants you a control state — but <strong>any</strong> victory nullifies your enemy&#39;s control over you. A losing player always has a cheap, achievable goal: win one roll and break their grip. Without this asymmetry, losing the first battle would mean losing the war.')}
`,
      },
      {
        id: 'resistance', h2: 'Resistance, loot and beige', nav: 'Winning a war',
        html: `
<p>Every war starts at <strong>${M.RESISTANCE_START} resistance</strong>. Attacks remove it; at zero the war is lost.</p>
${table(['Attack', 'Resistance removed (Immense Triumph)', 'Minimum attacks'], resRows)}
<h3>Loot</h3>
${formula(
`loot never exceeds ${M.LOOT_MAX_FRACTION * 100}% of their money
loot can never take a nation below ${money(M.LOOT_FLOOR)}`)}
<p>Both limits matter. The cap stops a single defeat from ending someone's game; the floor guarantees a beaten nation still has enough to rebuild.</p>
<h3>Losing a war</h3>
<ul>
  <li><strong>${C.VICTORY.LOOT_MONEY_FRACTION * 100}%</strong> of money and <strong>${C.VICTORY.LOOT_RESOURCE_FRACTION * 100}%</strong> of resources taken</li>
  <li>Up to <strong>${C.VICTORY.INFRA_LOSS_FRACTION * 100}%</strong> infrastructure lost in <em>every</em> city</li>
  <li><strong>${C.VICTORY.BEIGE_DURATION_DAYS} days of beige</strong>, stacking per war lost</li>
  <li>Credits are <strong>not</strong> lootable; the alliance bank <strong>is</strong></li>
</ul>
<p>Beige makes you immune to <em>new</em> declarations — existing wars continue. New nations start with <strong>${C.COLORS.BEIGE.newNationDays} days</strong> of it. Leaving beige is one-way: you can never go back voluntarily.</p>
${note('Alliances are not playable yet', 'The engine models alliance banks, alliance tax and colour trade blocs, and this page documents those rules because they are real code. But there is no interface to found or join an alliance yet — it is the next major system being built. Until then, the alliance-bank line above describes a rule with nothing to apply it to.', 'warn')}
`,
      },
      {
        id: 'peace', h2: 'Ending a war early', nav: 'Peace',
        html: `
<p>A war does not have to run to zero resistance. Either side may <strong>offer peace</strong> at any time, for free. Nothing happens until the other side offers as well — and when they do, the war ends immediately.</p>
<p>This is a <strong>white peace</strong>, and it is currently the only kind. No winner is recorded, no money or resources change hands, no infrastructure is lost, and <em>neither side goes beige</em>.</p>
${note('Why a white peace must not count as a defeat', 'If ending a war by agreement were filed as a loss, the loser would collect beige protection they never earned in battle — and the honest way to end a war would become the cheapest way to buy immunity. A draw is recorded as a draw.')}
<h3>The rules</h3>
<ul>
  <li>Both sides must offer. An offer on its own is a standing proposal, not a ceasefire — you can still be attacked while it sits there.</li>
  <li>You may <strong>withdraw</strong> your offer at any time; your opponent is told that you did.</li>
  <li><strong>Attacking withdraws your offer automatically.</strong> Suing for peace and hitting them in the same turn is the one thing this system will not let you do.</li>
  <li>It costs no action points. Talking is not a military action, and charging for it would make the cheap way out of a war something only a winning nation can afford.</li>
</ul>
${note('No terms yet', 'You cannot currently attach conditions to a peace offer — no reparations, no surrender terms, no ceasefire with a price. Every peace is a clean draw. Negotiated terms need a way to hold someone to them, which is a diplomacy system, not a war one.', 'warn')}
`,
      },
      {
        id: 'espionage', h2: 'Espionage',
        html: `
<p>A clean opposed check. Your spy strength against three times theirs, plus a bonus for taking your time.</p>
${formula(
`odds = (safetyLevel * ${C.ESPIONAGE.SAFETY_MULTIPLIER}) + (yourSpies * ${C.ESPIONAGE.SPY_NUMERATOR}) / ((enemySpies * ${C.ESPIONAGE.ENEMY_SPY_MULTIPLIER}) + ${C.ESPIONAGE.ENEMY_SPY_CONSTANT})
finalOdds = odds / operationModifier`)}
${table(['Operation', 'Difficulty'], espRows)}
<p>The <strong>&times;${C.ESPIONAGE.ENEMY_SPY_MULTIPLIER} weighting on enemy spies</strong> is the whole design. Defence is roughly three times cheaper than offence, so a nation that keeps a modest spy count is very hard to operate against — and ignoring spies entirely is an open invitation.</p>
${table(['Safety level', 'Odds bonus', 'What it buys'], Object.entries(C.ESPIONAGE.SAFETY_LEVELS).map(([k, v]) =>
  [C.ESPIONAGE.SAFETY_INFO[k]?.name || label(k),
   '+' + v * C.ESPIONAGE.SAFETY_MULTIPLIER + '%',
   C.ESPIONAGE.SAFETY_INFO[k]?.summary || '']))}
<p>Safety does two jobs at once: better odds, and a lower chance of being identified. A failed operation always costs you spies; a <em>detected</em> one also tells the target exactly who tried it.</p>

<h3>Spies</h3>
<p>Spies cost <strong>${money(C.ESPIONAGE.SPY_COST.money)}</strong> each, money only. You may hold <strong>${C.ESPIONAGE.MAX_SPIES}</strong> (<strong>${C.ESPIONAGE.MAX_SPIES_WITH_AGENCY}</strong> with the Intelligence Agency project) and train <strong>${C.ESPIONAGE.SPY_TRAINING_PER_DAY} per day</strong> (<strong>${C.ESPIONAGE.SPY_TRAINING_PER_DAY_WITH_AGENCY}</strong> with the project).</p>
${note('The daily cap is the real constraint, not the price', 'A full service takes weeks to build regardless of how rich you are. That is deliberate — if a wiped intelligence service could be rebuilt in an afternoon, losing spies would cost nothing and the whole system would collapse into a money sink.')}
<p>Spies cost money and nothing else. Making them cost steel would tie the intelligence game to the industrial one for no reason, and would lock a bombed-out nation out of the one thing it can still afford to do.</p>

<h3>What a successful operation does</h3>
${table(['Operation', 'Difficulty', 'On success'], Object.entries(C.ESPIONAGE.OPERATION_EFFECT).map(([k, e]) => {
  const info = C.ESPIONAGE.OPERATION_INFO[k] || {};
  const what = e.kind === 'reveal' ? 'Reveals their army, stockpile and spy count'
    : e.flat !== undefined ? `Destroys ${e.flat} ${e.target}`
    : `Destroys ${num(e.min * 100)}–${num(e.max * 100)}% of their ${e.target}` +
      (e.minCount ? ` (at least ${e.minCount})` : '');
  return [info.name || label(k), '&divide;' + num(C.ESPIONAGE.OPERATION_MODIFIER[k], 1), what];
}))}
<p>The magnitudes are deliberately small. Espionage is attrition and information — sabotage should make a war easier to win, never win one on its own.</p>
<p>You may run <strong>${C.ESPIONAGE.DAILY_OPERATIONS} operations per day</strong>, against targets inside the same score range that governs war. Nations on beige cannot be targeted: a nation that cannot retaliate should not be farmed for intelligence either.</p>
<p>Espionage results are seeded and stored the same way battles are, so a disputed result can be replayed rather than argued about.</p>
`,
      },
    ],
  });
}

// ============================================================================
// PAGE: POLICIES
// ============================================================================

function policiesPage() {
  const cat = Policy.catalogue();

  const slotSections = Policy.SLOTS.map(slot => {
    const info = Policy.SLOT_INFO[slot] || {};
    const list = Object.entries(Policy.POLICIES).filter(([, p]) => p.slot === slot);

    const rows = list.map(([key, p]) => {
      const gains = Object.entries(p.gain).map(([k, v]) =>
        `<span class="good">${describe(k, v)}</span>`).join('<br>');
      const costs = Object.entries(p.cost).map(([k, v]) =>
        `<span class="bad">${describe(k, v)}</span>`).join('<br>');
      return [`<strong>${esc(p.name)}</strong><br><span class="dim">${esc(p.summary)}</span>`, gains, costs];
    });

    return {
      id: slot,
      h2: label(slot) + ' slot',
      nav: label(slot),
      html: `
<p>${esc(info.description || '')}</p>
${table(['Policy', 'Gain', 'Cost'], rows)}
`,
    };
  });

  function describe(key, value) {
    const meta = Policy.EFFECT_KEYS[key] || { label: key, unit: 'multiplier' };
    if (meta.unit === 'flat') {
      const sign = value >= 0 ? '+' : '';
      return `${meta.label} ${sign}${num(value, 1)}${meta.suffix || ''}`;
    }
    return `${meta.label} ${mult(value)}`;
  }

  return page({
    slug: 'policies',
    title: 'Policies — SOVRA Wiki',
    description: 'All 18 policies in SOVRA across the economic, social and military slots. Every policy has a stated cost as well as a gain — no free bonuses. Generated directly from the game engine.',
    h1: 'Policies',
    standfirst: `Three slots, one active policy in each, ${Policy.SLOTS.length * 6} in total. Every single one costs you something as well as giving you something — that rule is enforced by an automated test, not by good intentions.`,
    sections: [
      {
        id: 'rule', h2: 'The one rule', nav: 'The one rule',
        html: `
<p>Politics &amp; War's domestic policies are pure upside: you pick the one that suits your playstyle and there is no reason to ever reconsider. That collapses the meta onto one obvious choice per archetype, and it makes the entire system a formality.</p>
<p>In SOVRA <strong>every policy has a cost</strong>. Laissez-Faire raises income and lowers raw output. State Industry raises manufacturing and taxes your income. There is no strictly best pick, only a pick that fits what you are currently doing.</p>
${note('Enforced by a test, not a promise', 'The test suite contains a check that iterates over every policy and fails the build if any of them has an empty cost. A future policy cannot quietly become a free bonus — the build stops first.')}
<p>Each slot locks for <strong>${C.POLICY_COOLDOWN.DOMESTIC_DAYS} days</strong> after a change, so switching is a commitment rather than a per-battle toggle. Before you commit, the game shows you a full diff of what changes.</p>
`,
      },
      ...slotSections,
      {
        id: 'amplify', h2: 'Amplifying policies', nav: 'Projects that amplify',
        html: `
<p>The Government Support Agency and Bureau of Domestic Affairs projects each amplify your active policy by <strong>${C.PROJECTS.government_support_agency.effect.domesticPolicyBonus * 100}%</strong>.</p>
${note('They amplify the gain, never the cost', 'Amplification applies to the deviation from neutral on the beneficial side only. A policy that gives -5% city cost becomes -7.5%; its cost stays exactly where it was. This is the one place in the game where you get something without paying for it, and it costs a project slot and ' + money(C.PROJECTS.government_support_agency.cost.money) + ' to have.')}
<p>Because policies are multipliers rather than additions, stacking several downward effects never reaches zero — a chain of -8% multipliers converges, it does not cancel your economy.</p>
`,
      },
      {
        id: 'wired', h2: 'Where policies actually apply', nav: 'What they touch',
        html: `
<p>Policies are not a separate scoring layer. Each one is a coefficient on a formula that already exists, wired into:</p>
<ul>
  <li><a href="/wiki/cities.html#infra">City, infrastructure and land costs</a></li>
  <li><a href="/wiki/economy.html#income">Income, upkeep, production, commerce and food</a></li>
  <li><a href="/wiki/population.html#density">Disease, crime and city age</a></li>
  <li><a href="/wiki/war.html#damage">Combat — both attacker and defender doctrine apply at once</a></li>
  <li><a href="/wiki/war.html#espionage">Espionage odds</a></li>
</ul>
<p>That is why a policy change shows up immediately in your ledger rather than in a separate panel. There is nowhere else for it to show up.</p>
`,
      },
    ],
  });
}

// ============================================================================
// PAGE: PROJECTS
// ============================================================================

function projectsPage() {
  const groups = {
    'Production': ['ironworks', 'bauxiteworks', 'arms_stockpile', 'emergency_gasoline_reserve',
                   'mass_irrigation', 'uranium_enrichment_program'],
    'Cost reduction': ['center_for_civil_engineering', 'urban_planning',
                       'advanced_urban_planning', 'metropolitan_planning'],
    'Mitigation': ['green_technologies', 'recycling_initiative',
                   'clinical_research_center', 'fallout_shelter'],
    'Military': ['iron_dome', 'vital_defense_system', 'intelligence_agency', 'military_salvage',
                 'missile_launch_pad', 'nuclear_research_facility', 'pirate_economy',
                 'propaganda_bureau'],
    'Economic': ['international_trade_center', 'government_support_agency',
                 'bureau_of_domestic_affairs'],
    'Prestige': ['moon_landing', 'mars_landing'],
  };

  function effectText(e) {
    const bits = [];
    for (const [k, v] of Object.entries(e)) {
      if (k === 'productionBonus') {
        for (const [res, amt] of Object.entries(v)) bits.push(`${res} output ${mult(1 + amt)}`);
      } else if (typeof v === 'boolean') {
        bits.push(label(k));
      } else if (k === 'unlocks') {
        bits.push('unlocks ' + v);
      } else if (typeof v === 'number' && v < 1 && v > 0) {
        bits.push(`${label(k).toLowerCase()} ${mult(v)}`);
      } else {
        bits.push(`${label(k).toLowerCase()}: ${typeof v === 'number' ? num(v) : v}`);
      }
    }
    return bits.join('; ');
  }

  const costText = c => Object.entries(c)
    .map(([k, v]) => k === 'money' ? money(v) : `${num(v)} ${k}`).join(' + ');

  const sections = Object.entries(groups).map(([name, keys]) => ({
    id: name.toLowerCase().replace(/[^a-z]+/g, '-'),
    h2: name,
    nav: name,
    html: table(['Project', 'Effect', 'Cost'], keys.map(k => {
      const p = C.PROJECTS[k];
      return [label(k), effectText(p.effect), costText(p.cost)];
    })),
  }));

  return page({
    slug: 'projects',
    title: 'National Projects — SOVRA Wiki',
    description: `All ${Object.keys(C.PROJECTS).length} national projects in SOVRA: production boosters, cost reducers, mitigation, military and economic projects, with effects and costs generated from the game engine.`,
    h1: 'National Projects',
    standfirst: `${Object.keys(C.PROJECTS).length} permanent nation-wide investments. They are expensive, they cannot be sold, and each one adds +${C.PROJECT_SCORE_VALUE} score — which pushes you up into a harder war range whether you wanted that or not.`,
    sections: [
      {
        id: 'rules', h2: 'How projects work', nav: 'How they work',
        html: `
<p>Every project is a <strong>coefficient on a formula that already exists</strong>, never a new system. That design rule is what lets a game support ${Object.keys(C.PROJECTS).length}+ projects without the codebase collapsing under its own weight. If a project would need its own table, it gets redesigned instead.</p>
<ul>
  <li><strong>Permanent.</strong> Once built, a project cannot be sold, demolished or rebuilt.</li>
  <li><strong>Nation-wide.</strong> Effects apply across every city, not per city.</li>
  <li><strong>+${C.PROJECT_SCORE_VALUE} score each.</strong> Ten projects is ${C.PROJECT_SCORE_VALUE * 10} score you did not choose to add to your war range.</li>
</ul>
${note('Projects narrow you', 'Because they are permanent and score-bearing, each project makes the nation you are becoming a little more fixed. Building the whole military set turns you into a target for anyone hunting military score; building the whole economic set makes you rich and reachable. There is no reset.', 'trap')}
<p>Costs below are still being balanced. Effects marked as verified in the engine come from Politics &amp; War; the rest are ours.</p>
`,
      },
      ...sections,
      {
        id: 'order', h2: 'The stacking-order trap', nav: 'Stacking order',
        html: `
<p>The three urban planning projects give <strong>flat</strong> discounts on new city cost, and they stack: ${costText({ money: C.PROJECTS.urban_planning.effect.cityCostDiscount })}, ${costText({ money: C.PROJECTS.advanced_urban_planning.effect.cityCostDiscount })} and ${costText({ money: C.PROJECTS.metropolitan_planning.effect.cityCostDiscount })} come off the price directly.</p>
<p>The Manifest Destiny policy is a <strong>multiplier</strong>. Order of application changes the final number materially:</p>
${worked('Why order matters — city 30, all three projects, Manifest Destiny', (() => {
  const base = City.nextCityCost(29);
  const flat = C.PROJECTS.urban_planning.effect.cityCostDiscount
             + C.PROJECTS.advanced_urban_planning.effect.cityCostDiscount
             + C.PROJECTS.metropolitan_planning.effect.cityCostDiscount;
  const m = C.DOMESTIC_POLICIES.manifest_destiny.cityCostMultiplier;
  return [
    ['Base cost', money(base)],
    ['Flat first, then multiplier (correct)', money((base - flat) * m)],
    ['Multiplier first, then flat (wrong)', money(base * m - flat)],
    ['Difference', money(Math.abs((base - flat) * m - (base * m - flat)))],
  ];
})())}
<p>The engine applies flat discounts first, then multipliers, and there is a test that fails if that order is ever changed.</p>
`,
      },
    ],
  });
}

// ============================================================================
// PAGE: WIKI INDEX
// ============================================================================

function indexPage() {
  const cards = [
    ['/wiki/cities.html', 'Cities, Infrastructure and Land',
     'Improvement slots, the three cost curves, build limits and why buildings cost steel.'],
    ['/wiki/economy.html', 'Economy, Income and Production',
     'Commerce to income, the power threshold, refining chains, stacking bonuses and upkeep.'],
    ['/wiki/population.html', 'Population, Disease and Crime',
     'The squared density term, the disease floor, crime, and the city age multiplier.'],
    ['/wiki/war.html', 'War, Combat and Espionage',
     'Score and war range, action points, the three-roll system, damage caps, loot and beige.'],
    ['/wiki/policies.html', 'Policies',
     `All ${Object.keys(Policy.POLICIES).length} policies across three slots — each with a stated cost, not just a gain.`],
    ['/wiki/projects.html', 'National Projects',
     `All ${Object.keys(C.PROJECTS).length} permanent investments, their effects and what they cost you.`],
  ];

  return page({
    slug: 'index',
    title: 'SOVRA Wiki — Game Mechanics, Formulas and Guides',
    description: 'The official SOVRA wiki. Every formula the game uses, generated directly from the game engine: city costs, income, disease, combat, policies and projects. Nothing reverse-engineered, nothing out of date.',
    h1: 'SOVRA Wiki',
    standfirst: 'Every page here is generated from the game engine itself. When a formula changes in the code, these pages change with it — so nothing on this wiki can quietly become wrong.',
    sections: [
      {
        id: 'start', h2: 'Start here',
        html: `
<div class="cards">
${cards.map(([href, h, p]) =>
  `<a class="wcard" href="${href}"><h3>${esc(h)}</h3><p>${esc(p)}</p></a>`).join('\n')}
</div>
`,
      },
      {
        id: 'why', h2: 'Why this wiki is different', nav: 'Why it is different',
        html: `
<p>Most games in this genre have a community wiki: players reverse-engineer the formulas by experiment, write them down, and the page slowly rots as the game is patched. Politics &amp; War's is the well-known example — parts of it are years out of date, and there is no way to tell which parts from the page itself.</p>
<p>These pages are built by a script that <code class="mono">require()</code>s the game's own engine modules. Constants are read out of <code class="mono">constants.js</code>. Worked examples call the same functions the game calls when it processes your turn. If a coefficient changes, the wiki changes on the next build.</p>
${note('What this means for you', 'You never have to decide whether to trust the wiki or the game. They are the same thing, presented twice. And where a number is still unverified against Politics &amp; War — our own invention rather than a sourced figure — the page says so.')}
`,
      },
      {
        id: 'quick', h2: 'Quick reference', nav: 'Quick reference',
        html: `
${table(['Thing', 'Value'], [
  ['Turn length', `${C.TICK.TURN_INTERVAL_MS / 3600000} hours (${C.TICK.TURNS_PER_DAY} turns per day)`],
  ['New nation protection', `${C.COLORS.BEIGE.newNationDays} days of beige`],
  ['Starting city', `${num(C.CITY.STARTING_INFRA)} infrastructure, ${num(C.CITY.STARTING_LAND)} land`],
  ['Improvement slots', `1 per ${C.CITY.INFRA_PER_IMPROVEMENT_SLOT} infrastructure`],
  ['Commerce cap', `${C.ECONOMY.COMMERCE_MAX}% (${C.ECONOMY.COMMERCE_MAX_WITH_ITC}% with ITC)`],
  ['War range', `${(C.WAR_RANGE.MIN_MULTIPLIER * 100 - 100).toFixed(0)}% below to +${(C.WAR_RANGE.MAX_MULTIPLIER * 100 - 100).toFixed(0)}% of your score`],
  ['War slots', `${C.COMBAT.OFFENSIVE_WAR_SLOTS} offensive, ${C.COMBAT.DEFENSIVE_WAR_SLOTS} defensive`],
  ['Action points', `${C.COMBAT.MAP_PER_TURN} per turn, max ${C.COMBAT.MAP_MAX}`],
  ['Battle rolls', `${C.COMBAT.ROLL_COUNT}, each at ${C.COMBAT.ROLL_MIN_FRACTION * 100}–${C.COMBAT.ROLL_MAX_FRACTION * 100}% of army value`],
  ['Loot cap', `${C.COMBAT.LOOT_MAX_FRACTION * 100}% of their money, never below ${money(C.COMBAT.LOOT_FLOOR)}`],
  ['Policy lock', `${C.POLICY_COOLDOWN.DOMESTIC_DAYS} days per slot`],
  ['Policies / projects', `${Object.keys(Policy.POLICIES).length} / ${Object.keys(C.PROJECTS).length}`],
])}
`,
      },
      {
        id: 'sources', h2: 'Verified and unverified numbers', nav: 'Sourcing',
        html: `
<p>SOVRA reimplements Politics &amp; War's mechanics as its blueprint. Inside the engine every constant carries a tag:</p>
<ul>
  <li><strong>VERIFIED</strong> — sourced from Politics &amp; War documentation</li>
  <li><strong>PLACEHOLDER</strong> — our value; the real one is unknown to us</li>
  <li><strong>DESIGN</strong> — our own decision, with no P&amp;W equivalent</li>
</ul>
<p>Where a whole system is ours rather than theirs — the crime equation, the policy costs, the material requirements on buildings — the relevant page says so plainly. We would rather tell you a number is provisional than have you build a nation on it and find out later.</p>
`,
      },
    ],
  });
}

// ============================================================================
// BUILD
// ============================================================================

/**
 * Render every wiki page to a { filename: html } map WITHOUT touching disk.
 *
 * Exported so the test suite can regenerate in memory and diff against what is
 * actually in public/wiki/. That check is the whole point of this file: it
 * fails the build if someone edits a constant and forgets to run `npm run wiki`,
 * which is exactly how documentation silently goes stale.
 *
 * Output must stay deterministic for that to work — no timestamps, and the
 * battle-odds simulation uses a fixed seed.
 */
function pages() {
  return {
    'index.html':      indexPage(),
    'cities.html':     citiesPage(),
    'economy.html':    economyPage(),
    'population.html': populationPage(),
    'war.html':        warPage(),
    'policies.html':   policiesPage(),
    'projects.html':   projectsPage(),
  };
}

function build() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const built = pages();

  for (const [name, html] of Object.entries(built)) {
    fs.writeFileSync(path.join(OUT_DIR, name), html, 'utf8');
    console.log(`  ${String(Math.round(html.length / 1024)).padStart(4)} KB  wiki/${name}`);
  }

  // sitemap — the whole point of building this is being found
  const urls = [
    { loc: SITE + '/', pri: '1.0' },
    { loc: SITE + '/wiki/', pri: '0.9' },
    ...Object.keys(built).filter(n => n !== 'index.html')
      .map(n => ({ loc: `${SITE}/wiki/${n}`, pri: '0.8' })),
    { loc: SITE + '/rankings.html', pri: '0.6' },
    { loc: SITE + '/privacy.html', pri: '0.3' },
    { loc: SITE + '/terms.html', pri: '0.3' },
  ];
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url><loc>${u.loc}</loc><priority>${u.pri}</priority></url>`).join('\n')}
</urlset>
`;
  fs.writeFileSync(path.join(__dirname, 'public', 'sitemap.xml'), sitemap, 'utf8');
  console.log('        public/sitemap.xml');

  const robots = `User-agent: *
Allow: /
Disallow: /api/
Disallow: /admin.html

Sitemap: ${SITE}/sitemap.xml
`;
  fs.writeFileSync(path.join(__dirname, 'public', 'robots.txt'), robots, 'utf8');
  console.log('        public/robots.txt');

  console.log(`\n  ${Object.keys(built).length} wiki pages generated from the engine.`);
}

if (require.main === module) build();
module.exports = { build, pages, OUT_DIR };
