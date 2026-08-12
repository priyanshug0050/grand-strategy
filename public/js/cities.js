/**
 * ==========================================================================
 *  cities.js
 * ==========================================================================
 *
 *  CONSEQUENCE BEFORE COMMITMENT
 *  --------------------------------------------------------------------------
 *  In Politics & War you type a number, press buy, and find out afterwards
 *  what it did to your city. Players learn the density rule by killing a city
 *  and reading a wiki about why.
 *
 *  Here every purchase is previewed first: what it costs, what it does to
 *  disease, how many people live or die because of it. The preview comes from
 *  the SERVER, computed with the same engine functions the tick uses — the
 *  frontend never reimplements a formula, so the number shown is always the
 *  number charged.
 * ==========================================================================
 */

(() => {
  'use strict';
  if (!requireLogin()) return;

  const msg = document.getElementById('msg');
  let state = null, health = null, ref = null;
  let activeCityId = null;
  let previewTimer = null, lastPreview = null;

  document.getElementById('signOut').addEventListener('click', e => {
    e.preventDefault(); API.logout();
  });

  const el = id => document.getElementById(id);
  const city = () => state.perCity.find(c => c.id === activeCityId);

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  // ------------------------------------------------------------------
  // Clock
  // ------------------------------------------------------------------

  function startClock() {
    const tick = () => {
      el('clockTurn').textContent = `Turn ${state.turn}`;
      if (!health?.lastTick || !health?.turnIntervalMs) return;
      const remaining = new Date(health.lastTick).getTime() + health.turnIntervalMs - Date.now();
      el('clockUntil').textContent = `next in ${Fmt.duration(remaining)}`;
      el('clock').classList.toggle('imminent', remaining < 60000);
    };
    tick();
    setInterval(tick, 1000);
  }

  // ------------------------------------------------------------------
  // City tabs
  // ------------------------------------------------------------------

  function renderTabs() {
    el('cityTabs').innerHTML = state.perCity.map(c => `
      <button class="citytab ${c.id === activeCityId ? 'active' : ''}" data-city="${c.id}">
        <span class="nm">${escapeHtml(c.name)}</span>
        <span class="sub">${Fmt.dec(c.infrastructure,0)} infra · ${Fmt.int(c.population)} pop</span>
      </button>`).join('');

    el('cityTabs').querySelectorAll('[data-city]').forEach(b => {
      b.addEventListener('click', () => { activeCityId = Number(b.dataset.city); renderCity(); });
    });
  }

  // ------------------------------------------------------------------
  // Selected city
  // ------------------------------------------------------------------

  function renderCity() {
    const c = city();
    if (!c) return;

    renderTabs();

    el('infraInput').value = Math.round(c.infrastructure);
    el('landInput').value = Math.round(c.land);

    const ratio = c.land > 0 ? c.infrastructure / c.land : 0;
    const wrap = el('densityWrap');
    wrap.className = 'density ' + (ratio > 1 ? 'crit' : ratio > 0.6 ? 'warn' : '');
    el('densityFill').style.width = Math.min(ratio * 100, 100) + '%';
    el('densityText').textContent = `density ${Fmt.dec(c.populationDetail.density, 0)} · disease ${Fmt.pct(Math.max(c.populationDetail.diseaseRatePercent,0))}`;
    el('densityVerdict').textContent =
      ratio > 1 ? 'infrastructure exceeds land' : ratio > 0.6 ? 'getting tight' : 'healthy';

    el('slotLine').textContent = `${c.usedSlots}/${c.improvementSlots} slots used`;
    el('powerLine').textContent = c.powered ? 'powered' : 'NOT POWERED';

    const d = c.populationDetail;
    el('cityStats').innerHTML = `
      <div class="ledger" style="margin-top:0">
        <div class="row"><span class="k">population</span><span class="v">${Fmt.int(c.population)}</span></div>
        <div class="row"><span class="k">age</span><span class="v">${Math.floor(c.ageDays)} days</span></div>
        <div class="row"><span class="k">commerce</span><span class="v">${c.commerce}%</span></div>
        <div class="row"><span class="k">pollution</span><span class="v">${Fmt.dec(c.pollution,0)}</span></div>
        <div class="rule"></div>
        <div class="row"><span class="k">base population</span><span class="v">${Fmt.int(d.basePopulation)}</span></div>
        <div class="row minus"><span class="k">disease ${Fmt.pct(Math.max(d.diseaseRatePercent,0))}</span><span class="v">−${Fmt.int(d.diseaseDeaths)}</span></div>
        <div class="row minus"><span class="k">crime (×4)</span><span class="v">−${Fmt.int(d.crimeDeaths)}</span></div>
        <div class="row times"><span class="k">age bonus</span><span class="v">×${Fmt.dec(d.ageMultiplier,3)}</span></div>
      </div>`;

    renderImprovements(c);
    schedulePreview();
  }

  // ------------------------------------------------------------------
  // Improvements
  // ------------------------------------------------------------------

  const CATEGORY_ORDER = ['raw','manufacturing','power','civil','commerce','military'];

  const CATEGORY_NOTE = {
    raw: 'Extract resources. These are the only buildings that work WITHOUT power.',
    manufacturing: 'Refine raw into finished goods. Needs power. Far more profitable than mining, and consumes raw every turn.',
    power: 'Must cover ALL your infrastructure. One point short and every powered building goes idle.',
    civil: 'Reduce disease, crime and pollution. Boring until your city gets big, then essential.',
    commerce: 'Raise the commerce rate, which raises income per citizen. Also suppresses crime.',
    military: 'Capacity and training rate for your army. Capacity is a hard ceiling — money cannot exceed it.',
  };

  /** One line saying what the building actually DOES, in plain terms. */
  function effectLine(key, def) {
    if (def.category === 'raw') {
      if (key === 'farm') return `food = land ÷ 500 per turn`;
      return def.perDay ? `${def.perDay} ${def.produces}/day` : `produces ${def.produces}`;
    }
    if (def.category === 'manufacturing') {
      const r = ref.recipes?.[def.produces];
      if (r) {
        const ins = Object.entries(r.inputs).map(([k,v]) => `${v} ${k}`).join(' + ');
        return `${ins} → ${r.output} ${def.produces}/day`;
      }
      return `produces ${def.produces}`;
    }
    if (def.category === 'power') return `powers ${Fmt.int(def.infraCapacity)} infra${def.fuel ? ` · burns ${def.fuel}` : ' · no fuel'}`;
    if (def.commerce) return `+${def.commerce} commerce`;
    if (def.diseaseReduction) return `−${def.diseaseReduction}% disease`;
    if (def.crimeReduction) return `−${def.crimeReduction}% crime`;
    if (def.pollutionReduction) return `−${def.pollutionReduction} pollution`;
    if (def.category === 'military') return `holds ${Fmt.int(def.capacity)} ${def.unit} · +${Fmt.int(def.perDay)}/day`;
    return '';
  }

  function renderImprovements(c) {
    // Counts come from the city itself now. They used to be read from a
    // separate nation.cities array that the snapshot does not send — which is
    // why every count showed 0 and every minus button was disabled.
    const counts = c.improvements || {};
    const free = c.improvementSlots - c.usedSlots;

    const byCat = {};
    for (const [key, def] of Object.entries(ref.improvements)) {
      (byCat[def.category] = byCat[def.category] || []).push([key, def]);
    }

    // Overall slot bar — the constraint everything else competes for.
    const usedPct = c.improvementSlots > 0 ? (c.usedSlots / c.improvementSlots) * 100 : 0;
    const header = `
      <div class="slotbar ${free === 0 ? 'full' : ''}">
        <div class="track"><div class="fill" style="width:${usedPct}%"></div></div>
        <div class="caption">
          <span>${c.usedSlots} of ${c.improvementSlots} slots used</span>
          <span>${free > 0 ? `${free} free` : `full — buy ${((Math.floor(c.infrastructure/50)+1)*50) - c.infrastructure > 0 ? 50 : 50} more infrastructure for another slot`}</span>
        </div>
      </div>

      <div class="row-controls" style="margin:.9rem 0 1.2rem">
        <div class="field">
          <label for="qty">Build / demolish quantity</label>
          <input id="qty" type="number" min="1" max="50" value="1">
        </div>
        <button id="qty1" class="qtypreset">1</button>
        <button id="qty5" class="qtypreset">5</button>
        <button id="qtyMax" class="qtypreset">Max</button>
      </div>`;

    const groups = CATEGORY_ORDER.filter(cat => byCat[cat]).map(cat => {
      // Per-sector totals — the thing that was completely missing before.
      const inCat = byCat[cat].reduce((n, [key]) => n + (counts[key] || 0), 0);
      const kinds = byCat[cat].filter(([key]) => (counts[key] || 0) > 0).length;

      return `
      <div class="impgroup">
        <div class="impgroup-head">
          <h3>${Fmt.label(cat)}</h3>
          <span class="tally num">${inCat} built${kinds ? ` · ${kinds} type${kinds > 1 ? 's' : ''}` : ''}</span>
        </div>
        <p class="muted" style="font-size:.72rem; margin-bottom:.7rem;">${CATEGORY_NOTE[cat] || ''}</p>
        <div class="impgrid">
          ${byCat[cat].map(([key, def]) => {
            const have = counts[key] || 0;
            const limit = def.limit;
            const atLimit = limit !== undefined && have >= limit;
            const needsPower = def.power && !c.powered;

            let blockReason = '';
            if (atLimit) blockReason = `limit ${limit} reached`;
            else if (free < 1) blockReason = 'no free slots';

            return `
            <div class="imp ${have > 0 ? 'owned' : ''} ${needsPower && have > 0 ? 'idle' : ''}">
              <div class="imp-head">
                <span class="nm">${Fmt.label(key)}</span>
                <span class="ct num">${have}${limit !== undefined ? `<span class="lim">/${limit}</span>` : ''}</span>
              </div>
              <div class="imp-effect">${effectLine(key, def)}</div>
              <div class="imp-meta num">
                ${Fmt.money(def.cost)}${def.upkeep ? ` · −${Fmt.money(def.upkeep)}/d` : ''}${def.pollution ? ` · +${def.pollution} poll` : ''}
              </div>
              ${needsPower && have > 0 ? '<div class="imp-warn">idle — no power</div>' : ''}
              <div class="imp-actions">
                <button data-build="${key}" ${atLimit || free < 1 ? 'disabled' : ''}
                        title="${blockReason}">Build</button>
                <button data-demolish="${key}" ${have < 1 ? 'disabled' : ''}>Demolish</button>
              </div>
            </div>`;
          }).join('')}
        </div>
      </div>`;
    }).join('');

    el('improvements').innerHTML = header + groups;

    // Quantity presets
    const qty = () => Math.max(1, Number(el('qty').value) || 1);
    el('qty1').addEventListener('click', () => { el('qty').value = 1; });
    el('qty5').addEventListener('click', () => { el('qty').value = 5; });
    el('qtyMax').addEventListener('click', () => { el('qty').value = Math.max(free, 1); });

    el('improvements').querySelectorAll('[data-build]').forEach(b =>
      b.addEventListener('click', () => build(b.dataset.build, qty())));
    el('improvements').querySelectorAll('[data-demolish]').forEach(b =>
      b.addEventListener('click', () => {
        const key = b.dataset.demolish;
        const have = counts[key] || 0;
        build(key, -Math.min(qty(), have));   // never try to demolish more than you own
      }));
  }

  async function build(key, count) {
    if (count === 0) return;
    try {
      clearMessage(msg);
      const r = await API.build(activeCityId, key, count);
      showMessage(msg, count > 0
        ? `Built ${count} × ${Fmt.label(key)} for ${Fmt.money(r.cost)}. You now have ${r.total}.`
        : `Demolished ${-count} × ${Fmt.label(key)}. ${r.total} remain — no refund.`, 'ok');
      await load();
    } catch (err) {
      showMessage(msg, err.message);
    }
  }

  // ------------------------------------------------------------------
  // Purchase preview — the important part
  // ------------------------------------------------------------------

  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(runPreview, 250);
  }

  async function runPreview() {
    const c = city();
    if (!c) return;

    const infra = Number(el('infraInput').value);
    const land = Number(el('landInput').value);

    if (!Number.isFinite(infra) || !Number.isFinite(land)) return;

    // Nothing to buy.
    if (infra <= c.infrastructure && land <= c.land) {
      el('preview').innerHTML = `<div class="row"><span class="k">no change</span><span class="v">—</span></div>
        <div class="formula">Raise a number above your current value to see what it would cost and do.</div>`;
      el('buyBtn').disabled = true;
      lastPreview = null;
      return;
    }

    try {
      const p = await API.previewCity(activeCityId, infra, land);
      lastPreview = p;
      renderPreview(p, c);
    } catch (err) {
      showMessage(msg, err.message);
    }
  }

  function renderPreview(p, c) {
    const popDelta = p.populationChange;
    const diseaseDelta = p.after.diseaseRatePercent - p.before.diseaseRatePercent;

    const rows = [];
    if (p.infraCost > 0) rows.push({ k: 'infrastructure', v: Fmt.money(p.infraCost) });
    if (p.landCost > 0) rows.push({ k: 'land', v: Fmt.money(p.landCost) });

    const warnings = [];
    if (!p.infraEfficient) warnings.push('Infrastructure is cheapest bought to a multiple of 100.');
    if (!p.landEfficient) warnings.push('Land is cheapest bought to a multiple of 500.');
    if (!p.poweredAfter) warnings.push('This would push you past your power capacity — build another plant or everything that needs power goes idle.');

    el('preview').innerHTML = `
      ${rows.map(r => `<div class="row"><span class="k">${r.k}</span><span class="v">${r.v}</span></div>`).join('')}
      <div class="rule"></div>
      <div class="row total"><span class="k">total cost</span><span class="v">${Fmt.money(p.totalCost)}</span></div>
      ${p.affordable ? '' : `<div class="row minus"><span class="k">short by</span><span class="v">${Fmt.money(p.shortfall)}</span></div>`}

      <div class="rule"></div>
      <div class="row"><span class="k">density</span><span class="v">${Fmt.dec(p.before.density,0)} → ${Fmt.dec(p.after.density,0)}</span></div>
      <div class="row ${diseaseDelta > 0 ? 'minus' : ''}">
        <span class="k">disease</span>
        <span class="v">${Fmt.pct(Math.max(p.before.diseaseRatePercent,0))} → ${Fmt.pct(Math.max(p.after.diseaseRatePercent,0))}</span>
      </div>
      <div class="row ${popDelta >= 0 ? '' : 'minus'}">
        <span class="k">population</span>
        <span class="v">${Fmt.int(p.before.population)} → ${Fmt.int(p.after.population)} (${popDelta >= 0 ? '+' : ''}${Fmt.int(popDelta)})</span>
      </div>
      <div class="row"><span class="k">improvement slots</span><span class="v">${p.slotsUsed}/${p.slotsAfter}</span></div>

      ${warnings.map(w => `<div class="formula" style="color:var(--phosphor)">${w}</div>`).join('')}
      ${popDelta < 0 ? `<div class="formula" style="color:var(--alarm)">
        This purchase would COST you ${Fmt.int(-popDelta)} people. Disease rises with the square of
        density — buy land alongside infrastructure, or build hospitals.
        ${p.landForZeroDisease ? ` ${Fmt.int(p.landForZeroDisease)} land would zero it out.`
          : ` Land alone cannot fix this; the floor here is ${Fmt.pct(p.diseaseFloor)}.`}
      </div>` : ''}`;

    el('buyBtn').disabled = !p.affordable;
    el('buyBtn').textContent = p.affordable
      ? `Purchase — ${Fmt.money(p.totalCost)}`
      : `Need ${Fmt.money(p.shortfall)} more`;
  }

  async function purchase() {
    const c = city();
    const infra = Number(el('infraInput').value);
    const land = Number(el('landInput').value);
    const btn = el('buyBtn');

    btn.disabled = true; btn.textContent = 'Purchasing…';
    try {
      clearMessage(msg);
      let spent = 0;
      if (land > c.land) spent += (await API.buyLand(activeCityId, land)).cost;
      if (infra > c.infrastructure) spent += (await API.buyInfrastructure(activeCityId, infra)).cost;
      showMessage(msg, `Purchased for ${Fmt.money(spent)}.`, 'ok');
      await load();
    } catch (err) {
      showMessage(msg, err.message);
      btn.disabled = false;
    }
  }

  // ------------------------------------------------------------------
  // Found a city
  // ------------------------------------------------------------------

  async function foundCity() {
    const name = el('newCityName').value.trim();
    const continent = el('newCityContinent').value;
    if (!name) return showMessage(msg, 'Give the city a name.');

    try {
      clearMessage(msg);
      const r = await API.foundCity(name, continent);
      showMessage(msg, `Founded ${name} for ${Fmt.money(r.cost)}. You now hold ${r.cityCount} cities.`, 'ok');
      el('newCityName').value = '';
      await load();
    } catch (err) {
      showMessage(msg, err.message);
    }
  }

  // ------------------------------------------------------------------

  async function load() {
    try {
      const [nation, hp] = await Promise.all([API.nation(), API.health()]);
      state = nation;
      health = hp;
      if (!ref) ref = await API.reference();

      if (!activeCityId || !state.perCity.some(c => c.id === activeCityId)) {
        activeCityId = state.perCity[0]?.id;
      }

      el('treasuryLine').textContent = Fmt.money(state.nation.money);

      if (!el('newCityContinent').options.length) {
        el('newCityContinent').innerHTML = ref.continents
          .map(c => `<option value="${c}"${c === state.nation.continent ? ' selected' : ''}>${Fmt.label(c)}</option>`).join('');
      }

      // Next-city cost, straight from the engine's cubic curve.
      const n = state.perCity.length;
      el('foundCost').textContent = '…';
      el('foundNote').textContent = n >= 10
        ? 'Past 10 cities a 10-day cooldown applies between purchases.'
        : 'City cost is cubic — each one costs dramatically more than the last.';

      renderCity();
      startClock();
    } catch (err) {
      showMessage(msg, err.message);
    }
  }

  el('infraInput').addEventListener('input', schedulePreview);
  el('landInput').addEventListener('input', schedulePreview);
  el('buyBtn').addEventListener('click', purchase);
  el('foundBtn').addEventListener('click', foundCity);

  load();
})();
