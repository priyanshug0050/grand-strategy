/**
 * ==========================================================================
 *  economy.js — the ledger
 * ==========================================================================
 *
 *  WHAT P&W'S REVENUE PAGE DOES NOT DO
 *  --------------------------------------------------------------------------
 *  It shows totals. Gross income, expenses, net. When your income drops you
 *  are left guessing which of forty buildings caused it, and the community
 *  answer is "build a spreadsheet".
 *
 *  This page shows the WORKING. Every number traces to the building that
 *  produced it, every deduction is named, and — the part no summary can give
 *  you — it says WHY a factory is idle rather than just showing you a zero.
 *
 *  THE ONE NUMBER THAT MATTERS MOST
 *  --------------------------------------------------------------------------
 *  Runway. Not "you are losing 87 food per turn" but "you run out in 11
 *  turns". A rate is arithmetic; a deadline is a decision.
 * ==========================================================================
 */

(() => {
  'use strict';
  if (!requireLogin()) return;

  const msg = document.getElementById('msg');
  const el = id => document.getElementById(id);
  let eco = null, health = null;

  el('signOut').addEventListener('click', e => { e.preventDefault(); API.logout(); });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  function startClock() {
    const t = () => {
      el('clockTurn').textContent = `Turn ${eco.turn}`;
      if (!health?.lastTick || !health?.turnIntervalMs) return;
      const remaining = new Date(health.lastTick).getTime() + health.turnIntervalMs - Date.now();
      el('clockUntil').textContent = `next in ${Fmt.duration(remaining)}`;
      el('clock').classList.toggle('imminent', remaining < 60000);
    };
    t(); setInterval(t, 1000);
  }

  // ------------------------------------------------------------------
  // Alerts — things actively going wrong, stated as consequences
  // ------------------------------------------------------------------

  function renderAlerts() {
    const alerts = [];

    if (eco.cash.outOfFood) {
      alerts.push({ kind: 'error', text:
        `Out of food. Gross income is cut by a third — that is ${Fmt.money(eco.cash.foodPenaltyCost)} a day you are not collecting. Buy food on the market or build farms.` });
    }

    // Runway warnings, soonest first.
    const running = Object.entries(eco.flow)
      .filter(([, f]) => f.turnsRemaining !== null && f.turnsRemaining < 60)
      .sort((a, b) => a[1].turnsRemaining - b[1].turnsRemaining);

    for (const [resource, f] of running.slice(0, 3)) {
      alerts.push({ kind: f.turnsRemaining < 12 ? 'error' : 'warn', text:
        `${Fmt.label(resource)} runs out in ${f.turnsRemaining} turns (${Fmt.dec(f.daysRemaining,1)} days) at ${Fmt.signed(f.netPerTurn)}/turn.` });
    }

    // Power failures, with the actual cause named.
    for (const c of eco.perCity) {
      if (c.powered || !c.power) continue;
      alerts.push({ kind: 'error', text: `${c.name}: ${c.power.message}` });
    }

    // Idle buildings — money spent on upkeep for nothing.
    const idleAll = eco.perCity.flatMap(c => c.idle.map(i => ({ ...i, city: c.name })));
    for (const i of idleAll.slice(0, 3)) {
      alerts.push({ kind: 'warn', text:
        `${i.count} × ${Fmt.label(i.key)} in ${i.city} ${i.partial ? 'throttled' : 'idle'} — ${i.reason}. You are paying upkeep for ${i.partial ? 'reduced' : 'zero'} output.` });
    }

    if (eco.cash.netIncomePerDay < 0) {
      alerts.push({ kind: 'error', text:
        `Losing ${Fmt.money(-eco.cash.netIncomePerDay)} a day. At this rate your treasury lasts ${Math.floor(eco.money / -eco.cash.netIncomePerDay)} days.` });
    }

    el('alerts').innerHTML = alerts.length
      ? alerts.map(a => `<div class="msg ${a.kind}">${escapeHtml(a.text)}</div>`).join('')
      : '';
  }

  // ------------------------------------------------------------------
  // Cash flow
  // ------------------------------------------------------------------

  function renderCash() {
    const c = eco.cash;
    const perTurn = v => Fmt.money(v / 12);

    el('cash').innerHTML = `
      <div class="ledger" style="margin-top:0">
        <div class="row"><span class="k">gross income</span><span class="v">${Fmt.money(c.grossIncomePerDay)}</span></div>
        ${c.outOfFood ? `<div class="row minus"><span class="k">food shortage penalty (−33%)</span><span class="v">−${Fmt.money(c.foodPenaltyCost)}</span></div>` : ''}
        <div class="row minus"><span class="k">building upkeep</span><span class="v">−${Fmt.money(c.improvementUpkeepPerDay)}</span></div>
        <div class="row minus"><span class="k">military upkeep</span><span class="v">−${Fmt.money(c.unitUpkeepPerDay)}</span></div>
        <div class="rule"></div>
        <div class="row total"><span class="k">net per day</span><span class="v">${Fmt.money(c.netIncomePerDay)}</span></div>
        <div class="row"><span class="k">net per turn</span><span class="v">${Fmt.money(c.netIncomePerTurn)}</span></div>
        <div class="rule"></div>
        <div class="row"><span class="k">treasury</span><span class="v">${Fmt.money(eco.money)}</span></div>
        <div class="formula">
          Income is collected on the daily rollover, not every turn — the per-turn
          figure is the daily amount divided by 12, shown so you can compare it
          against production rates.
        </div>
      </div>`;
  }

  // ------------------------------------------------------------------
  // Resource flow — the runway table
  // ------------------------------------------------------------------

  function renderFlow() {
    const order = ['food','coal','oil','iron','bauxite','lead','uranium','steel','aluminum','gasoline','munitions'];

    el('flow').innerHTML = `
      <table class="ledger-table">
        <thead>
          <tr>
            <th>Resource</th><th>Stockpile</th><th>Produced</th>
            <th>Consumed</th><th>Net</th><th>Runway</th>
          </tr>
        </thead>
        <tbody>
        ${order.map(r => {
          const f = eco.flow[r];
          if (!f) return '';
          const idle = f.producedPerTurn === 0 && f.consumedPerTurn === 0 && f.stockpile === 0;
          const netCls = f.netPerTurn > 0.0001 ? 'pos' : f.netPerTurn < -0.0001 ? 'neg' : '';

          let runway = '—';
          let runwayCls = '';
          if (f.turnsRemaining !== null) {
            runway = `${f.turnsRemaining} turns`;
            runwayCls = f.turnsRemaining < 12 ? 'neg' : f.turnsRemaining < 60 ? 'warn' : '';
          } else if (f.netPerTurn < -0.0001) {
            runway = 'empty';
            runwayCls = 'neg';
          } else if (f.netPerTurn > 0.0001) {
            runway = 'growing';
            runwayCls = 'pos';
          }

          return `
            <tr class="${idle ? 'dim' : ''}">
              <td class="res-name">${Fmt.label(r)}</td>
              <td class="num">${Fmt.dec(f.stockpile, f.stockpile < 100 ? 1 : 0)}</td>
              <td class="num pos">${f.producedPerTurn > 0 ? '+' + Fmt.dec(f.producedPerTurn,2) : '—'}</td>
              <td class="num neg">${f.consumedPerTurn > 0 ? '−' + Fmt.dec(f.consumedPerTurn,2) : '—'}</td>
              <td class="num ${netCls}"><strong>${Fmt.signed(f.netPerTurn)}</strong></td>
              <td class="num ${runwayCls}">${runway}</td>
            </tr>`;
        }).join('')}
        </tbody>
      </table>
      <p class="muted" style="font-size:.72rem; margin-top:.7rem; line-height:1.5;">
        Runway is what matters, not the rate. A deficit with 400 turns of stock is
        a note; a deficit with 8 turns is a decision.
      </p>`;
  }

  // ------------------------------------------------------------------
  // Attribution — the part P&W has no equivalent of
  // ------------------------------------------------------------------

  const CATEGORY_ORDER = ['raw','manufacturing','power','commerce','civil','military'];

  /**
   * Each category gets the columns it actually needs.
   *
   * Only raw and manufacturing move resources. Forcing a bank, a hospital and
   * a barracks through "Produces / Consumes" left three quarters of the table
   * showing dashes, which reads as "this building does nothing" — the opposite
   * of the truth.
   */
  const CATEGORY_COLUMNS = {
    raw:           ['Produces /turn', 'Consumes /turn'],
    manufacturing: ['Produces /turn', 'Consumes /turn'],
    power:         ['Powers', 'Burns /turn'],
    commerce:      ['Commerce', 'Effect on income'],
    civil:         ['Reduces', 'Why it matters'],
    military:      ['Capacity', 'Trains /day'],
  };

  const CATEGORY_NOTE = {
    raw: 'Extraction. Works without power.',
    manufacturing: 'Refining. Needs power, and consumes raw every turn.',
    power: 'Gates everything below. A plant with no fuel is just a building.',
    commerce: 'Raises income per citizen. Also suppresses crime.',
    civil: 'No output of their own — they remove losses from population and pollution.',
    military: 'Capacity is a hard ceiling. Money cannot exceed it.',
  };

  function flowText(obj) {
    const parts = Object.entries(obj).map(([r, v]) => `${Fmt.dec(v,2)} ${r}`);
    return parts.length ? parts.join(', ') : '<span class="muted">—</span>';
  }

  /** The two right-hand cells, written in the language of that category. */
  function effectCells(line) {
    const parts = line.effect?.parts || [];
    const find = l => parts.find(p => p.label === l)?.value;

    switch (line.category) {
      case 'raw':
      case 'manufacturing':
        return [
          `<span class="pos">${flowText(line.produces)}</span>`,
          `<span class="neg">${flowText(line.consumes)}</span>`,
        ];

      case 'power': {
        const fuel = find('fuel');
        const burn = Object.keys(line.consumes).length
          ? `<span class="neg">${flowText(line.consumes)}</span>`
          : (fuel === 'none' ? '<span class="pos">no fuel</span>' : '<span class="muted">—</span>');
        return [`${find('powers') || '—'}`, burn];
      }

      case 'commerce': {
        // Commerce is worth showing in money, not as an abstract number.
        const perCitizen = (line.commerce / 50) * 0.725;
        const daily = perCitizen * eco.totalPopulation;
        return [
          `<span class="pos">+${line.commerce}</span>`,
          daily > 0 ? `<span class="pos">${Fmt.money(daily)}/day</span>` : '<span class="muted">—</span>',
        ];
      }

      case 'civil': {
        const reductions = parts.filter(p => ['disease','crime','pollution'].includes(p.label) && !p.bad);
        if (!reductions.length) return ['<span class="muted">—</span>', '<span class="muted">—</span>'];
        const label = reductions.map(p => `${p.value} ${p.label}`).join(', ');
        const why = reductions.some(p => p.label === 'disease')
          ? 'more citizens survive'
          : reductions.some(p => p.label === 'crime')
          ? 'crime costs 4× its rate'
          : 'pollution raises disease';
        return [`<span class="pos">${label}</span>`, `<span class="muted">${why}</span>`];
      }

      case 'military': {
        const holds = find('holds');
        const trains = find('trains');
        return [holds || '<span class="muted">—</span>', trains || '<span class="muted">—</span>'];
      }

      default:
        return ['<span class="muted">—</span>', '<span class="muted">—</span>'];
    }
  }

  function renderByImprovement() {
    const byCat = {};
    for (const line of eco.byImprovement) {
      (byCat[line.category] = byCat[line.category] || []).push(line);
    }

    el('byImprovement').innerHTML = CATEGORY_ORDER.filter(c => byCat[c]).map(cat => {
      const lines = byCat[cat];
      const catUpkeep = lines.reduce((s, l) => s + l.upkeepPerDay, 0);
      const cols = CATEGORY_COLUMNS[cat] || ['Produces /turn', 'Consumes /turn'];

      return `
      <div class="attr-group">
        <div class="attr-head">
          <h3>${Fmt.label(cat)}</h3>
          <span class="num muted">${catUpkeep > 0 ? Fmt.money(catUpkeep) + '/day upkeep' : 'no upkeep'}</span>
        </div>
        <p class="muted" style="font-size:.7rem; margin-bottom:.5rem;">${CATEGORY_NOTE[cat] || ''}</p>
        <table class="ledger-table">
          <thead>
            <tr>
              <th>Building</th><th>#</th>
              <th>${cols[0]}</th><th>${cols[1]}</th>
              <th>Upkeep /day</th>
            </tr>
          </thead>
          <tbody>
          ${lines.map(l => {
            const [a, b] = effectCells(l);
            const pollution = (l.effect?.parts || []).find(p => p.bad);
            return `
            <tr>
              <td class="res-name">${Fmt.label(l.key)}
                ${pollution ? `<span class="badge poll">${pollution.value} pollution</span>` : ''}
              </td>
              <td class="num">${l.count}</td>
              <td class="num">${a}</td>
              <td class="num">${b}</td>
              <td class="num">${l.upkeepPerDay ? Fmt.money(l.upkeepPerDay) : '<span class="muted">—</span>'}</td>
            </tr>`;
          }).join('')}
          </tbody>
        </table>
      </div>`;
    }).join('') || '<p class="empty">No buildings yet.</p>';
  }

  // ------------------------------------------------------------------
  // Food — split civilian vs military
  // ------------------------------------------------------------------

  function renderFood() {
    const f = eco.food;
    const flow = eco.flow.food;

    el('food').innerHTML = `
      <div class="ledger" style="margin-top:0">
        <div class="row pos"><span class="k">farms produce</span><span class="v">+${Fmt.dec(flow.producedPerTurn,2)}</span></div>
        <div class="rule"></div>
        <div class="row minus"><span class="k">${Fmt.int(eco.totalPopulation)} citizens</span><span class="v">−${Fmt.dec(f.civilianPerTurn,2)}</span></div>
        ${f.soldiers > 0 ? `<div class="row minus">
          <span class="k">${Fmt.int(f.soldiers)} soldiers${f.atWar ? ' (at war)' : ''}</span>
          <span class="v">−${Fmt.dec(f.militaryPerTurn,2)}</span></div>` : ''}
        <div class="rule"></div>
        <div class="row total"><span class="k">net per turn</span><span class="v">${Fmt.signed(flow.netPerTurn)}</span></div>
        <div class="row"><span class="k">stockpile</span><span class="v">${Fmt.dec(flow.stockpile,0)}</span></div>
        ${flow.turnsRemaining !== null ? `<div class="row minus">
          <span class="k">runs out in</span>
          <span class="v">${flow.turnsRemaining} turns (${Fmt.dec(flow.daysRemaining,1)} days)</span></div>` : ''}
        <div class="formula">
          Citizens eat in proportion to population, so growing a city raises its food
          bill. Soldiers eat more at war than at peace — one of several ways fighting
          costs money even when you are winning.
        </div>
      </div>`;
  }

  // ------------------------------------------------------------------
  // Per-city
  // ------------------------------------------------------------------

  function renderPerCity() {
    el('perCity').innerHTML = eco.perCity.map(c => {
      const net = c.incomePerDay - c.upkeepPerDay;
      return `
      <div class="citycard">
        <div class="citycard-head">
          <span class="nm">${escapeHtml(c.name)}</span>
          <span class="num ${net >= 0 ? 'pos' : 'neg'}">${Fmt.money(net)}/day</span>
        </div>
        <div class="citycard-body num">
          <div><span class="muted">income</span> ${Fmt.money(c.incomePerDay)}</div>
          <div><span class="muted">upkeep</span> ${Fmt.money(c.upkeepPerDay)}</div>
          <div><span class="muted">commerce</span> ${c.commerce}%</div>
          <div><span class="muted">pollution</span> ${Fmt.dec(c.pollution,0)}</div>
        </div>
        ${!c.powered ? `<div class="msg error" style="margin:.5rem 0 0">
          ${escapeHtml(c.power?.message || `Unpowered — ${Fmt.int(c.powerDeficit)} infrastructure uncovered.`)}
        </div>` : ''}
        ${c.idle.length ? c.idle.map(i => `<div class="msg warn" style="margin:.4rem 0 0">
          ${i.count} × ${Fmt.label(i.key)} — ${escapeHtml(i.reason)}</div>`).join('') : ''}
      </div>`;
    }).join('');
  }

  // ------------------------------------------------------------------

  async function load() {
    try {
      const [e, hp] = await Promise.all([API.economy(), API.health()]);
      eco = e; health = hp;
      clearMessage(msg);

      el('treasuryLine').textContent = Fmt.money(eco.money);

      renderAlerts();
      renderCash();
      renderFlow();
      renderByImprovement();
      renderFood();
      renderPerCity();
      startClock();
    } catch (err) {
      showMessage(msg, err.message);
    }
  }

  load();
  setInterval(load, 30000);
})();
