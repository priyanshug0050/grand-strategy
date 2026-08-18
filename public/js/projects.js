/**
 * ==========================================================================
 *  projects.js
 * ==========================================================================
 *
 *  27 projects were defined in the engine and none of them could be bought,
 *  because there was no page. This is that page.
 *
 *  Two things it does that a plain shop list would not:
 *
 *    1. SHORTFALL, NOT "CANNOT AFFORD". When something is out of reach it says
 *       exactly what you are short of and by how much, so the answer is a
 *       market order rather than a shrug.
 *
 *    2. THE SCORE COST IS SHOWN. Every project adds score, and score decides
 *       who may declare war on you. A project page that only shows the money
 *       price is hiding half the cost — this one puts the new war range next to
 *       the button, before you commit to something you can never sell.
 * ==========================================================================
 */

(() => {
  'use strict';
  if (!requireLogin()) return;

  const el = id => document.getElementById(id);
  const msg = el('msg');

  let data = null, snap = null, health = null;
  let busy = null;

  el('signOut').addEventListener('click', e => { e.preventDefault(); API.logout(); });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  function startClock() {
    const tick = () => {
      el('clockTurn').textContent = `Turn ${data ? data.turn : '—'}`;
      if (!health?.lastTick || !health?.turnIntervalMs) return;
      const remaining = new Date(health.lastTick).getTime() + health.turnIntervalMs - Date.now();
      el('clockUntil').textContent = `next in ${Fmt.duration(remaining)}`;
      el('clock').classList.toggle('imminent', remaining < 60000);
    };
    tick();
    setInterval(tick, 1000);
  }

  // ------------------------------------------------------------------
  // Grouping — the same categories the wiki uses, so the two agree
  // ------------------------------------------------------------------

  const GROUPS = [
    ['Production', 'More output from what you already mine and refine.',
      ['ironworks','bauxiteworks','arms_stockpile','emergency_gasoline_reserve',
       'mass_irrigation','uranium_enrichment_program']],
    ['Cost reduction', 'Cheaper growth. The city discounts stack with each other.',
      ['center_for_civil_engineering','urban_planning','advanced_urban_planning',
       'metropolitan_planning']],
    ['Mitigation', 'Pollution, disease and fallout — the costs of running hot.',
      ['green_technologies','recycling_initiative','clinical_research_center','fallout_shelter']],
    ['Military', 'Capability you cannot buy any other way.',
      ['iron_dome','vital_defense_system','intelligence_agency','military_salvage',
       'missile_launch_pad','nuclear_research_facility','pirate_economy','propaganda_bureau']],
    ['Economic', 'Levers on income and on your policies.',
      ['international_trade_center','government_support_agency','bureau_of_domestic_affairs']],
    ['Prestige', 'No mechanical effect. Score, and the fact that you did it.',
      ['moon_landing','mars_landing']],
  ];

  // ------------------------------------------------------------------
  // Describing an effect without duplicating the engine's numbers
  // ------------------------------------------------------------------

  function pctOf(v) {
    const d = Math.round((v - 1) * 1000) / 10;
    return (d >= 0 ? '+' : '') + (Number.isInteger(d) ? d : d.toFixed(1)) + '%';
  }

  /**
   * Effect keys are engine-shaped, not player-shaped, and their numbers do not
   * all mean the same kind of thing. 0.95 on infraCostMultiplier means "5%
   * cheaper"; 0.05 on salvageFraction means "you recover 5%". A single
   * "0 < v < 1 means multiplier" heuristic renders the second one as "-95%",
   * which is not merely ugly — it is the opposite of the truth.
   *
   * So each key is described explicitly. Anything not listed falls through to a
   * conservative renderer that states the raw value rather than guessing at its
   * meaning. Adding a project without adding a line here shows a plain number,
   * never a wrong percentage.
   */
  const EFFECT_TEXT = {
    infraCostMultiplier:              v => `Infrastructure cost ${pctOf(v)}`,
    cityCostDiscount:                 v => `New city cost −${Fmt.money(v)}`,
    manufacturingPollutionMultiplier: v => `Manufacturing pollution ${pctOf(v)}`,
    farmPollutionMultiplier:          v => `Farm pollution ${pctOf(v)}`,
    resourceUpkeepMultiplier:         v => `Resource upkeep ${pctOf(v)}`,
    nukeDamageMultiplier:             v => `Nuclear damage taken ${pctOf(v)}`,
    falloutDurationMultiplier:        v => `Fallout duration ${pctOf(v)}`,

    // Farms produce land / divisor per turn, so a SMALLER divisor is more food.
    farmLandDivisor: v => {
      const base = 250;   // the unirrigated divisor; shown as a gain, not a raw number
      return `Farm output +${Math.round((base / v - 1) * 100)}%`;
    },

    subwayEffectivenessBonus: v => `Subway effectiveness +${Fmt.int(v)}`,
    recyclingCenterBonus:     v => `Recycling centres remove +${Fmt.int(v)} pollution each`,
    recyclingCenterLimit:     v => `Recycling centre limit raised to ${Fmt.int(v)}`,
    maxSpiesBonus:            v => `+${Fmt.int(v)} maximum spies`,
    offensiveWarSlots:        v => `${Fmt.int(v)} offensive war slots`,
    commerceMax:              v => `Commerce cap raised to ${Fmt.int(v)}%`,

    missileInterceptChance:   v => `${Math.round(v * 100)}% chance to intercept incoming missiles`,
    nukeInterceptChance:      v => `${Math.round(v * 100)}% chance to intercept incoming nuclear attacks`,
    salvageFraction:          v => `Recover ${Math.round(v * 100)}% of destroyed units`,
    militaryRecruitmentBonus: v => `Recruitment rate +${Math.round(v * 100)}%`,
    domesticPolicyBonus:      v => `Your active policies are ${Math.round(v * 100)}% stronger`,

    diseaseReduction:       () => 'Reduces disease in every city',
    capsRadiationFoodImpact:() => 'Caps the food penalty from radiation',
    scoreBonus:             v => (v ? `Score +${Fmt.int(v)}` : null),
  };

  function describeEffect(effect) {
    const bits = [];
    for (const [key, value] of Object.entries(effect || {})) {
      if (key === 'productionBonus') {
        for (const [res, amt] of Object.entries(value)) {
          bits.push(`${Fmt.label(res)} output +${Math.round(amt * 100)}%`);
        }
        continue;
      }
      if (key === 'unlocks') { bits.push(`Unlocks ${Fmt.label(value)}`); continue; }

      const fn = EFFECT_TEXT[key];
      if (fn) {
        const text = fn(value);
        if (text) bits.push(text);
        continue;
      }

      // Unknown key — state it, do not interpret it.
      bits.push(typeof value === 'boolean'
        ? humanKey(key)
        : `${humanKey(key)}: ${typeof value === 'number' ? Fmt.int(value) : value}`);
    }
    return bits.join(' · ') || 'No mechanical effect — score and the fact that you did it';
  }

  /** camelCase / snake_case -> "Camel case" for keys with no explicit wording. */
  function humanKey(key) {
    return String(key)
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/_/g, ' ')
      .toLowerCase()
      .replace(/^./, c => c.toUpperCase());
  }

  function costLine(cost) {
    return Object.entries(cost).map(([res, amount]) =>
      res === 'money' ? Fmt.money(amount) : `${Fmt.int(amount)} ${res}`).join(' + ');
  }

  function shortLine(short) {
    return Object.entries(short).map(([res, amount]) =>
      res === 'money' ? Fmt.money(amount) : `${Fmt.dec(amount, 2)} ${res}`)
      .join(', ');
  }

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  /**
   * Recover the war-range multipliers from the snapshot instead of typing 0.75
   * and 1.75 in here. The server already applied them; deriving them back means
   * this page cannot disagree with the declaration check if they are ever tuned.
   */
  function rangeBand() {
    if (!snap?.warRange || !snap.score) return null;
    return { min: snap.warRange.min / snap.score, max: snap.warRange.max / snap.score };
  }

  function renderStanding() {
    const newScore = data.currentScore + data.scorePerProject;
    const band = rangeBand();
    el('standingNote').textContent = `${data.ownedCount} of ${data.projects.length} built`;
    el('standing').innerHTML = `
      <table class="ledger-table">
        <tbody>
          <tr><td data-label="Metric">Treasury</td>
              <td data-label="Value" class="num">${Fmt.money(data.money)}</td></tr>
          <tr><td data-label="Metric">Current score</td>
              <td data-label="Value" class="num">${Fmt.dec(data.currentScore, 2)}</td></tr>
          <tr><td data-label="Metric">Score after one more project</td>
              <td data-label="Value" class="num">${Fmt.dec(newScore, 2)}</td></tr>
          ${band ? `
          <tr><td data-label="Metric">Nations that could declare on you now</td>
              <td data-label="Value" class="num">${Fmt.dec(snap.vulnerableTo.min, 1)} — ${Fmt.dec(snap.vulnerableTo.max, 1)}</td></tr>
          <tr><td data-label="Metric">…after one more project</td>
              <td data-label="Value" class="num">${Fmt.dec(newScore / band.max, 1)} — ${Fmt.dec(newScore / band.min, 1)}</td></tr>` : ''}
        </tbody>
      </table>
      <p class="muted" style="font-size:.72rem; margin-top:.6rem; line-height:1.5;">
        Every project is +${data.scorePerProject} score, permanently. Ten projects is
        ${data.scorePerProject * 10} score you did not choose to add to your war range,
        and there is no way to sell one back.
      </p>`;
  }

  function renderGroups() {
    const hideOwned = el('hideOwned').checked;
    const onlyAffordable = el('onlyAffordable').checked;
    const byKey = new Map(data.projects.map(p => [p.key, p]));

    el('groups').innerHTML = GROUPS.map(([title, blurb, keys]) => {
      const items = keys.map(k => byKey.get(k)).filter(Boolean).filter(p => {
        if (hideOwned && p.owned) return false;
        if (onlyAffordable && (!p.affordable || p.owned)) return false;
        return true;
      });
      if (items.length === 0) return '';

      return `
        <section class="panel" style="margin-bottom:var(--gap-l)">
          <header>
            <h2>${escapeHtml(title)}</h2>
            <span class="eyebrow">${items.filter(p => p.owned).length}/${keys.length} built</span>
          </header>
          <div class="body">
            <p class="muted" style="font-size:.74rem; margin:-.2rem 0 .8rem;">${escapeHtml(blurb)}</p>
            <div class="impgrid">
              ${items.map(renderCard).join('')}
            </div>
          </div>
        </section>`;
    }).join('') || '<p class="empty">Nothing matches those filters.</p>';

    for (const btn of document.querySelectorAll('[data-build]')) {
      btn.addEventListener('click', () => buy(btn.dataset.build));
    }
  }

  function renderCard(p) {
    const state = p.owned ? 'built' : p.affordable ? 'ready' : 'short';
    return `
      <div class="imp ${p.owned ? 'owned' : ''}">
        <div class="imp-head">
          <strong>${escapeHtml(p.name)}</strong>
          ${p.owned ? '<span class="tag">built</span>' : ''}
        </div>
        <p class="imp-effect">${escapeHtml(describeEffect(p.effect))}</p>
        <p class="imp-mats">${costLine(p.cost)}</p>
        ${state === 'short'
          ? `<p class="imp-warn">Short: ${escapeHtml(shortLine(p.short))}</p>`
          : ''}
        <div class="imp-actions">
          ${p.owned
            ? '<span class="muted" style="font-size:.72rem;">Permanent — cannot be sold</span>'
            : `<button class="primary" data-build="${p.key}"${p.affordable ? '' : ' disabled'}>
                 ${p.affordable ? 'Build' : 'Cannot afford'}
               </button>`}
        </div>
      </div>`;
  }

  // ------------------------------------------------------------------
  // Buying — confirm, because this cannot be undone
  // ------------------------------------------------------------------

  async function buy(key) {
    if (busy) return;
    const p = data.projects.find(x => x.key === key);
    if (!p) return;

    const ok = confirm(
      `Build ${p.name}?\n\n` +
      `Cost: ${costLine(p.cost)}\n` +
      `Score: +${data.scorePerProject}, permanently\n\n` +
      `Projects cannot be sold, demolished or refunded.`
    );
    if (!ok) return;

    busy = key;
    clearMessage(msg);
    try {
      await API.buildProject(key);
      await load();
      showMessage(msg, `${p.name} built.`, 'ok');
    } catch (err) {
      showMessage(msg, err.message);
    } finally {
      busy = null;
    }
  }

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------

  el('hideOwned').addEventListener('change', renderGroups);
  el('onlyAffordable').addEventListener('change', renderGroups);

  async function load() {
    [data, snap] = await Promise.all([API.projects(), API.nation()]);
    renderStanding();
    renderGroups();
  }

  (async () => {
    try {
      health = await API.health().catch(() => null);
      await load();
      startClock();
    } catch (err) {
      showMessage(msg, err.message);
    }
  })();
})();
