/**
 * ==========================================================================
 *  military.js
 * ==========================================================================
 *
 *  ODDS BEFORE COMMITMENT
 *  --------------------------------------------------------------------------
 *  Politics & War tells you nothing before an attack. Players run external
 *  spreadsheets to estimate whether a fight is worth the MAP and munitions.
 *
 *  Here every attack shows its real odds first — army value on both sides, the
 *  ratio, and the probability of each outcome tier. The numbers come from
 *  Monte-Carloing the SAME roll function the battle will use, on the server,
 *  so they cannot drift from reality.
 *
 *  Supply is shown before anything else, because an unsupplied army has
 *  already lost: unsupplied units contribute zero combat value and still take
 *  casualties.
 * ==========================================================================
 */

(() => {
  'use strict';
  if (!requireLogin()) return;

  const msg = document.getElementById('msg');
  const el = id => document.getElementById(id);
  let state = null, health = null, ref = null, wars = [], targetData = null;
  let openPreview = {};   // warId -> attackType currently previewed

  el('signOut').addEventListener('click', e => { e.preventDefault(); API.logout(); });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

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
  // Forces & supply
  // ------------------------------------------------------------------

  function renderForces() {
    const u = state.nation.units;
    const sp = state.nation.stockpile;

    // Rough supply read so the player sees the problem without opening a war.
    const munitionsNeeded = (u.tanks || 0) / 100 + (u.aircraft || 0) * 0.25 + (u.ships || 0) * 2.5;
    const gasNeeded = (u.tanks || 0) / 100 + (u.aircraft || 0) * 0.25 + (u.ships || 0) * 1.5;
    const supplied = (sp.munitions || 0) >= munitionsNeeded && (sp.gasoline || 0) >= gasNeeded;

    const tag = el('supplyTag');
    tag.textContent = supplied ? 'supplied' : 'UNDER-SUPPLIED';
    tag.style.color = supplied ? 'var(--verdigris)' : 'var(--alarm)';

    el('forces').innerHTML = ['soldiers','tanks','aircraft','ships','missiles','nukes'].map(k => `
      <div class="vital">
        <div class="label">${k}</div>
        <div class="value">${Fmt.int(u[k] || 0)}</div>
      </div>`).join('') + `
      <div class="vital">
        <div class="label">munitions</div>
        <div class="value ${(sp.munitions||0) >= munitionsNeeded ? '' : 'bad'}">${Fmt.dec(sp.munitions||0,1)}</div>
        <div class="sub">need ${Fmt.dec(munitionsNeeded,1)}/battle</div>
      </div>
      <div class="vital">
        <div class="label">gasoline</div>
        <div class="value ${(sp.gasoline||0) >= gasNeeded ? '' : 'bad'}">${Fmt.dec(sp.gasoline||0,1)}</div>
        <div class="sub">need ${Fmt.dec(gasNeeded,1)}/battle</div>
      </div>`;

    el('mapLine').textContent = `${state.nation.map}/12 action points · score ${Fmt.dec(state.score,1)}`;
  }

  // ------------------------------------------------------------------
  // Recruitment
  // ------------------------------------------------------------------

  function renderRecruit() {
    el('recruit').innerHTML = ['soldiers','tanks','aircraft','ships'].map(k => {
      const def = ref.units[k];
      const costParts = Object.entries(def.cost)
        .map(([r, v]) => r === 'money' ? Fmt.money(v) : `${v} ${r}`).join(' + ');
      return `
        <div class="recruit-row">
          <div>
            <div class="nm">${Fmt.label(k)}</div>
            <div class="meta num">${costParts} each · −${Fmt.money(def.upkeepPeace)}/day upkeep</div>
          </div>
          <div class="row-controls" style="gap:.35rem">
            <input type="number" min="1" value="100" id="qty-${k}" style="width:90px">
            <button data-unit="${k}">Recruit</button>
          </div>
        </div>`;
    }).join('');

    el('recruit').querySelectorAll('[data-unit]').forEach(b =>
      b.addEventListener('click', () => recruit(b.dataset.unit)));
  }

  async function recruit(unit) {
    const count = Number(el('qty-' + unit).value);
    if (!Number.isInteger(count) || count <= 0) return showMessage(msg, 'Enter a whole number above zero.');
    try {
      clearMessage(msg);
      const r = await API.recruit(unit, count);
      showMessage(msg, `Recruited ${Fmt.int(count)} ${unit}. You now have ${Fmt.int(r.total)}.`, 'ok');
      await load();
    } catch (err) {
      showMessage(msg, err.message + (err.details.maxPossible !== undefined
        ? ` You can recruit ${Fmt.int(err.details.maxPossible)} right now.` : ''));
    }
  }

  // ------------------------------------------------------------------
  // Wars
  // ------------------------------------------------------------------

  const ATTACKS = [
    { key: 'ground_battle', label: 'Ground', map: 3 },
    { key: 'airstrike', label: 'Airstrike', map: 4 },
    { key: 'naval_battle', label: 'Naval', map: 4 },
  ];

  function renderWars() {
    el('warCount').textContent = `${wars.length} active`;

    if (wars.length === 0) {
      el('wars').innerHTML = '<p class="empty">No active wars. Pick a target below.</p>';
      return;
    }

    el('wars').innerHTML = wars.map(w => {
      const iAmAttacker = Number(w.attacker_id) === state.nation.id;
      const opponent = iAmAttacker ? w.defender_name : w.attacker_name;
      const theirResistance = Number(iAmAttacker ? w.defender_resistance : w.attacker_resistance);
      const myResistance = Number(iAmAttacker ? w.attacker_resistance : w.defender_resistance);

      return `
      <div class="war">
        <div class="war-head">
          <div>
            <h3>${escapeHtml(opponent)}</h3>
            <span class="eyebrow">${iAmAttacker ? 'you declared' : 'declared on you'} · ${w.war_type}</span>
          </div>
          <span class="tag">${w.war_type}</span>
        </div>

        <div class="resist">
          <div class="r">
            <span class="k">their resistance</span>
            <div class="track"><div class="fill them" style="width:${theirResistance}%"></div></div>
            <span class="v num">${theirResistance}</span>
          </div>
          <div class="r">
            <span class="k">yours</span>
            <div class="track"><div class="fill mine" style="width:${myResistance}%"></div></div>
            <span class="v num">${myResistance}</span>
          </div>
        </div>

        <div class="attack-buttons">
          ${ATTACKS.map(a => `
            <button data-odds="${w.id}" data-type="${a.key}"
              ${state.nation.map < a.map ? 'disabled' : ''}>${a.label} · ${a.map} MAP</button>`).join('')}
        </div>

        <div class="ledger hidden" id="odds-${w.id}"></div>
      </div>`;
    }).join('');

    el('wars').querySelectorAll('[data-odds]').forEach(b =>
      b.addEventListener('click', () => showOdds(Number(b.dataset.odds), b.dataset.type)));
  }

  /** The signature: real odds, before spending anything. */
  async function showOdds(warId, attackType) {
    const box = el('odds-' + warId);
    box.classList.remove('hidden');
    box.innerHTML = '<div class="row"><span class="k">calculating…</span><span class="v"></span></div>';

    try {
      const p = await API.previewAttack(warId, attackType);
      openPreview[warId] = attackType;

      const o = p.odds;
      const pct = n => (n * 100).toFixed(1) + '%';
      const winsNeeded = Math.ceil(p.resistanceRemaining / p.resistancePerWin);

      box.innerHTML = `
        <div class="row"><span class="k">your strength</span><span class="v">${Fmt.int(p.myValue)}</span></div>
        <div class="row"><span class="k">their strength</span><span class="v">${Fmt.int(p.theirValue)}</span></div>
        <div class="row times"><span class="k">ratio</span><span class="v">${p.ratio !== null ? p.ratio + '×' : 'no defence'}</span></div>
        <div class="rule"></div>
        <div class="row total"><span class="k">Immense Triumph</span><span class="v">${pct(o.immenseTriumph)}</span></div>
        <div class="row"><span class="k">Moderate Success</span><span class="v">${pct(o.moderateSuccess)}</span></div>
        <div class="row"><span class="k">Pyrrhic Victory</span><span class="v">${pct(o.pyrrhicVictory)}</span></div>
        <div class="row minus"><span class="k">Utter Failure</span><span class="v">${pct(o.utterFailure)}</span></div>
        <div class="rule"></div>
        <div class="row"><span class="k">resistance left</span><span class="v">${p.resistanceRemaining}</span></div>
        <div class="row"><span class="k">wins needed at this rate</span><span class="v">${winsNeeded}</span></div>

        ${p.supply.fullySupplied ? '' : `<div class="formula" style="color:var(--alarm)">
          ${p.supply.shortfalls.join(' ')}
          Unsupplied units contribute NOTHING to the roll but still take casualties.</div>`}

        ${o.utterFailure > 0.3 ? `<div class="formula" style="color:var(--phosphor)">
          A failure removes zero resistance and still costs you ${p.map.cost} MAP,
          munitions and casualties. Build up first unless you need the pressure now.</div>` : ''}

        <button class="primary" style="width:100%; margin-top:.8rem"
          data-attack="${warId}" data-type="${attackType}"
          ${p.map.ok ? '' : 'disabled'}>
          ${p.map.ok ? `Attack — ${p.map.cost} MAP` : `Need ${p.map.cost} MAP, have ${p.map.have}`}
        </button>`;

      box.querySelector('[data-attack]')?.addEventListener('click', () => attack(warId, attackType));
    } catch (err) {
      box.innerHTML = `<div class="row minus"><span class="k">${escapeHtml(err.message)}</span><span class="v"></span></div>`;
    }
  }

  async function attack(warId, attackType) {
    try {
      clearMessage(msg);
      const r = await API.attack(warId, attackType);

      let text = `${r.victoryName}.`;
      if (r.infraDestroyed > 0) text += ` Destroyed ${Fmt.dec(r.infraDestroyed,2)} infrastructure in ${r.targetCity}.`;
      if (r.loot > 0) text += ` Looted ${Fmt.money(r.loot)}.`;
      text += ` Resistance now ${r.resistanceRemaining}.`;
      if (r.control.gained) text += ` Gained ${Fmt.label(r.control.gained)}.`;
      if (r.warEnded) text += ' WAR WON — they are on beige.';

      showMessage(msg, text, r.victoryType > 0 ? 'ok' : 'warn');
      await load();
    } catch (err) {
      showMessage(msg, err.message);
    }
  }

  // ------------------------------------------------------------------
  // Targets
  // ------------------------------------------------------------------

  function renderTargets() {
    const d = targetData;
    el('rangeLine').textContent = `score ${Fmt.int(d.range.min)}–${Fmt.int(d.range.max)}`;

    if (d.targets.length === 0) {
      el('targets').innerHTML = `<p class="empty">
        Nobody is in your score range (${Fmt.int(d.range.min)}–${Fmt.int(d.range.max)}).
        Range is 25% below to 75% above your own score of ${Fmt.dec(d.myScore,1)}.</p>`;
      return;
    }

    el('targets').innerHTML = `
      <table class="targets">
        <thead><tr><th>Nation</th><th>Score</th><th>Cities</th><th>Infra</th><th></th></tr></thead>
        <tbody>
        ${d.targets.map(t => `
          <tr class="${t.attackable ? '' : 'blocked'}">
            <td class="res-name">${escapeHtml(t.name)}</td>
            <td class="num" data-label="Score">${Fmt.dec(t.score,1)}</td>
            <td class="num" data-label="Cities">${t.cities}</td>
            <td class="num" data-label="Infrastructure">${Fmt.int(t.infrastructure)}</td>
            <td>
              ${t.attackable
                ? `<select data-wartype="${t.id}">
                     <option value="raid">Raid</option>
                     <option value="ordinary" selected>Ordinary</option>
                     <option value="attrition">Attrition</option>
                   </select>
                   <button data-declare="${t.id}">Declare</button>`
                : `<span class="muted" style="font-size:.7rem">${t.blockedReason}</span>`}
            </td>
          </tr>`).join('')}
        </tbody>
      </table>
      <p class="muted" style="font-size:.72rem; margin-top:.8rem; line-height:1.5;">
        <strong>Raid</strong> maximises loot, minimises damage.
        <strong>Attrition</strong> is the reverse.
        <strong>Ordinary</strong> splits both.
      </p>`;

    el('targets').querySelectorAll('[data-declare]').forEach(b =>
      b.addEventListener('click', () => {
        const id = Number(b.dataset.declare);
        const type = el('targets').querySelector(`[data-wartype="${id}"]`).value;
        declareWar(id, type);
      }));
  }

  async function declareWar(targetId, warType) {
    try {
      clearMessage(msg);
      const r = await API.declareWar(targetId, warType);
      showMessage(msg, `Declared ${r.warType} war on ${r.target}.`, 'ok');
      await load();
    } catch (err) {
      showMessage(msg, err.message);
    }
  }

  // ------------------------------------------------------------------

  function renderLog(events) {
    const relevant = events.filter(e =>
      ['attacked','war_declared','war_lost','bankruptcy'].includes(e.type));

    el('log').innerHTML = relevant.length === 0
      ? '<li class="empty" style="border:0">No military activity yet.</li>'
      : relevant.slice(0, 15).map(e => `
          <li><span class="t">T${e.turn}</span><span>${escapeHtml(e.payload?.message || Fmt.label(e.type))}</span></li>`).join('');
  }

  async function load() {
    try {
      const [nation, hp, warList, ev] = await Promise.all([
        API.nation(), API.health(), API.wars(), API.events(40),
      ]);
      state = nation; health = hp; wars = warList.wars;
      if (!ref) ref = await API.reference();

      targetData = await API.targets();

      renderForces();
      renderRecruit();
      renderWars();
      renderTargets();
      renderLog(ev.events);
      startClock();
    } catch (err) {
      showMessage(msg, err.message);
    }
  }

  load();
})();
