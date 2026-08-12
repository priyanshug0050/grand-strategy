/**
 * ==========================================================================
 *  dashboard.js
 * ==========================================================================
 *
 *  THE DERIVATION LEDGER
 *  --------------------------------------------------------------------------
 *  Politics & War hides its formulas completely. Players consult external
 *  wikis to understand why their own city is dying, and most never find out.
 *
 *  Here, every derived number unfolds into the arithmetic that produced it.
 *  The server already sends the full breakdown — it is the same object the
 *  tick engine acts on, so what the player sees and what the game does can
 *  never disagree. All this file does is lay it out as a ledger.
 * ==========================================================================
 */

(() => {
  'use strict';
  if (!requireLogin()) return;

  const msg = document.getElementById('msg');
  let state = null;
  let health = null;
  let clockTimer = null;

  document.getElementById('signOut').addEventListener('click', e => {
    e.preventDefault(); API.logout();
  });

  // ------------------------------------------------------------------
  // Turn clock
  // ------------------------------------------------------------------

  function startClock() {
    if (clockTimer) clearInterval(clockTimer);
    const tick = () => {
      document.getElementById('clockTurn').textContent = `Turn ${state.turn}`;
      const until = document.getElementById('clockUntil');
      if (!health || !health.lastTick || !health.turnIntervalMs) { until.textContent = ''; return; }

      const next = new Date(health.lastTick).getTime() + health.turnIntervalMs;
      const remaining = next - Date.now();
      until.textContent = `next in ${Fmt.duration(remaining)}`;
      document.getElementById('clock').classList.toggle('imminent', remaining < 60000);

      // The turn has passed — pull fresh numbers rather than showing stale ones.
      if (remaining < -3000) load();
    };
    tick();
    clockTimer = setInterval(tick, 1000);
  }

  // ------------------------------------------------------------------
  // Vitals
  // ------------------------------------------------------------------

  function renderVitals() {
    const n = state.nation;
    const r = state.revenue;
    const net = r.netIncomePerDay;

    const cards = [
      { label: 'Treasury', value: Fmt.money(n.money) },
      { label: 'Net income', value: Fmt.money(net) + '/day', cls: net >= 0 ? 'good' : 'bad' },
      { label: 'Population', value: Fmt.int(state.totalPopulation) },
      { label: 'Score', value: Fmt.dec(state.score, 1), cls: 'hot',
        sub: `war range ${Fmt.int(state.warRange.min)}–${Fmt.int(state.warRange.max)}` },
      { label: 'Action points', value: `${n.map} / 12` },
      { label: 'Attackable by', value: `${Fmt.int(state.vulnerableTo.min)}–${Fmt.int(state.vulnerableTo.max)}`,
        sub: 'score range' },
    ];

    document.getElementById('vitals').innerHTML = cards.map(c => `
      <div class="vital">
        <div class="label">${c.label}</div>
        <div class="value ${c.cls || ''}">${c.value}</div>
        ${c.sub ? `<div class="sub">${c.sub}</div>` : ''}
      </div>`).join('');

    document.getElementById('nationName').textContent = n.name;
    document.getElementById('leaderLine').textContent =
      `${n.leaderName || 'Leader'} · ${Fmt.label(n.continent)}`;

    const tag = document.getElementById('colorTag');
    const cs = state.colorState;
    tag.textContent = cs.color === 'beige'
      ? `Protected · ${Math.ceil(cs.turnsRemaining / 12)}d left`
      : Fmt.label(cs.color);
    tag.className = 'tag ' + (cs.color === 'beige' ? 'beige' : '');
  }

  // ------------------------------------------------------------------
  // Cities + the population ledger
  // ------------------------------------------------------------------

  function renderCities() {
    const el = document.getElementById('cities');
    document.getElementById('cityCount').textContent = `${state.perCity.length} held`;

    el.innerHTML = state.perCity.map((c, i) => {
      const infra = c.infrastructure;
      const land = c.land;

      // Density is the single most important relationship in the game.
      // Disease rises with its SQUARE, which is why a bar reads better than
      // a number — players need to feel it approaching, not read it after.
      const ratio = land > 0 ? infra / land : 0;
      const level = ratio > 1 ? 'crit' : ratio > 0.6 ? 'warn' : '';

      return `
      <article class="panel city">
        <div class="body">
          <div class="head">
            <h3>${escapeHtml(c.name)}</h3>
            <span class="eyebrow">${Math.floor(c.ageDays)}d old</span>
          </div>

          <div class="density ${level}">
            <div class="track"><div class="fill" style="width:${Math.min(ratio * 100, 100)}%"></div></div>
            <div class="caption">
              <span>density ${Fmt.dec(c.populationDetail.density, 0)}</span>
              <span>${ratio > 1 ? 'infrastructure exceeds land' : 'healthy'}</span>
            </div>
          </div>

          <div class="stats">
            <div class="stat"><span class="k">infra</span><span class="num">${Fmt.dec(infra, 0)}</span></div>
            <div class="stat"><span class="k">land</span><span class="num">${Fmt.dec(land, 0)}</span></div>
            <div class="stat"><span class="k">slots</span><span class="num">${c.usedSlots}/${c.improvementSlots}</span></div>
            <div class="stat"><span class="k">commerce</span><span class="num">${c.commerce}%</span></div>
          </div>

          <div class="stat" style="border-top:1px solid var(--line); padding-top:.7rem;">
            <span class="k">population</span>
            <button class="derived num" data-ledger="${i}">${Fmt.int(c.population)}</button>
          </div>
          <div class="ledger hidden" id="ledger-${i}">${populationLedger(c.populationDetail)}</div>

          ${c.powered ? '' : '<div class="msg warn">Unpowered. Factories, commerce and civil buildings are all idle until power covers every point of infrastructure.</div>'}
        </div>
      </article>`;
    }).join('');

    el.querySelectorAll('[data-ledger]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.getElementById('ledger-' + btn.dataset.ledger).classList.toggle('hidden');
      });
    });
  }

  /**
   * The signature element.
   *
   * Shows the population formula as a worked sum: base, minus disease, minus
   * crime at its 4x weight, times the age multiplier. A player who sees
   * "-8,987 to disease" immediately knows to buy land or build hospitals —
   * which is a conclusion P&W players currently reach by reading a wiki.
   */
  function populationLedger(d) {
    const rows = [
      { k: 'base population', v: Fmt.int(d.basePopulation) },
      { k: `disease ${Fmt.pct(d.diseaseRatePercent)}`, v: '−' + Fmt.int(d.diseaseDeaths), cls: 'minus' },
      { k: `crime ${Fmt.pct(d.crimeRatePercent)} (×4 weight)`, v: '−' + Fmt.int(d.crimeDeaths), cls: 'minus' },
      { k: `age bonus ×${Fmt.dec(d.ageMultiplier, 3)}`, v: `${Math.floor(d.cityAgeDays)} days`, cls: 'times' },
    ];

    return `
      ${rows.map(r => `<div class="row ${r.cls || ''}"><span class="k">${r.k}</span><span class="v">${r.v}</span></div>`).join('')}
      <div class="rule"></div>
      <div class="row total"><span class="k">living here</span><span class="v">${Fmt.int(d.population)}</span></div>
      <div class="formula">
        Disease climbs with the <em>square</em> of density, so doubling infrastructure
        without doubling land roughly quadruples deaths. Land and hospitals both
        reduce it; pollution raises it.
      </div>`;
  }

  // ------------------------------------------------------------------
  // Treasury — itemised, not a single number
  // ------------------------------------------------------------------

  function renderTreasury() {
    const r = state.revenue;
    const rows = [
      { k: 'gross income', v: Fmt.money(r.grossIncomePerDay) },
      { k: 'building upkeep', v: '−' + Fmt.money(r.improvementUpkeepPerDay), cls: 'minus' },
      { k: 'military upkeep', v: '−' + Fmt.money(r.unitUpkeepPerDay), cls: 'minus' },
    ];

    document.getElementById('treasury').innerHTML = `
      <div class="ledger" style="margin-top:0">
        ${rows.map(x => `<div class="row ${x.cls || ''}"><span class="k">${x.k}</span><span class="v">${x.v}</span></div>`).join('')}
        <div class="rule"></div>
        <div class="row total"><span class="k">net per day</span><span class="v">${Fmt.money(r.netIncomePerDay)}</span></div>
        <div class="row"><span class="k">per turn</span><span class="v">${Fmt.money(r.netIncomePerTurn)}</span></div>
        ${r.outOfFood ? `<div class="formula" style="color:var(--alarm)">
          Out of food: gross income is cut by a third until you have some again.</div>` : ''}
      </div>`;
  }

  // ------------------------------------------------------------------
  // Resources
  // ------------------------------------------------------------------

  function renderResources() {
    const sp = state.nation.stockpile;
    const flow = state.revenue.resourcesPerTurn;
    const order = ['food','coal','oil','iron','bauxite','lead','uranium','steel','aluminum','gasoline','munitions'];

    document.getElementById('resources').innerHTML = order.map(r => {
      const amount = sp[r] || 0;
      const delta = flow[r] || 0;
      const cls = delta > 0.0001 ? 'pos' : delta < -0.0001 ? 'neg' : '';
      return `
        <div class="r">
          <div class="n">${r}</div>
          <div class="a">${Fmt.dec(amount, amount < 100 ? 1 : 0)}</div>
          <div class="d ${cls}">${Fmt.signed(delta)}</div>
        </div>`;
    }).join('');
  }

  // ------------------------------------------------------------------
  // Warnings — an empty state is an invitation, not an apology
  // ------------------------------------------------------------------

  function renderWarnings() {
    const items = [];
    state.perCity.forEach(c => c.warnings.forEach(w => items.push({ city: c.name, text: w })));
    state.revenue.perCity.forEach(c => c.warnings.forEach(w => items.push({ text: w })));

    const el = document.getElementById('warnings');
    if (items.length === 0) {
      el.innerHTML = '<p class="empty">Nothing needs your attention. Good time to expand.</p>';
      return;
    }
    el.innerHTML = items.slice(0, 8).map(i => `
      <div class="msg warn">${i.city ? `<strong>${escapeHtml(i.city)}</strong> — ` : ''}${escapeHtml(i.text)}</div>
    `).join('');
  }

  function renderLog(events) {
    const el = document.getElementById('log');
    if (!events.length) {
      el.innerHTML = '<li class="empty" style="border:0">Nothing has happened yet. The first turn will change that.</li>';
      return;
    }
    el.innerHTML = events.slice(0, 12).map(e => {
      const p = e.payload || {};
      let text = p.message || Fmt.label(e.type);
      if (e.type === 'daily_income') text = `Collected ${Fmt.money(p.net)}`;
      if (e.type === 'day_change') return '';
      return `<li><span class="t">T${e.turn}</span><span>${escapeHtml(text)}</span></li>`;
    }).filter(Boolean).join('') || '<li class="empty" style="border:0">Quiet so far.</li>';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ------------------------------------------------------------------

  async function load() {
    try {
      const [nation, ev, hp] = await Promise.all([API.nation(), API.events(30), API.health()]);
      state = nation;
      health = hp;
      clearMessage(msg);

      renderVitals();
      renderCities();
      renderTreasury();
      renderResources();
      renderWarnings();
      renderLog(ev.events);
      startClock();
    } catch (err) {
      showMessage(msg, err.message);
    }
  }

  load();
  // Refresh periodically so a turn resolving in another tab is picked up.
  setInterval(load, 60000);
})();
