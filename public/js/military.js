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

    el('mapLine').textContent = `${state.nation.map}/${ref.mapMax} action points · score ${Fmt.dec(state.score,1)}`;
  }

  // ------------------------------------------------------------------
  // Recruitment
  // ------------------------------------------------------------------

  /**
   * Missiles and nukes are in this list too.
   *
   * They were not, which meant the only way to build one was to call the API by
   * hand — the projects that unlock them, their costs, their score and the
   * whole launch mechanic existed with no route to the weapon itself.
   *
   * They are shown even when locked, with the project that unlocks them named.
   * A weapon you cannot see is a weapon you never plan for, and planning is the
   * entire point of a strategic weapon.
   */
  function renderRecruit() {
    const ORDER = ['soldiers', 'tanks', 'aircraft', 'ships', 'missiles', 'nukes'];
    const owned = state.nation.projects || [];

    el('recruit').innerHTML = ORDER.map(k => {
      const def = ref.units[k];
      if (!def) return '';

      const costParts = Object.entries(def.cost)
        .map(([r, v]) => r === 'money' ? Fmt.money(v) : `${v} ${r}`).join(' + ');

      const locked = def.requiresProject && !owned.includes(def.requiresProject);
      const rate = def.perDay !== undefined ? `${def.perDay}/day` : null;

      return `
        <div class="recruit-row${locked ? ' locked' : ''}">
          <div>
            <div class="nm">${Fmt.label(k)}${rate ? ` <span class="tag">${rate}</span>` : ''}</div>
            <div class="meta num">${costParts} each${def.upkeepPeace
              ? ` · −${Fmt.money(def.upkeepPeace)}/day upkeep` : ' · no upkeep'}</div>
            ${locked ? `<div class="meta">Needs the
              <a href="/projects.html">${Fmt.label(def.requiresProject)}</a> project</div>` : ''}
          </div>
          <div class="row-controls" style="gap:.35rem">
            <input type="number" min="1" value="${def.perDay !== undefined ? def.perDay : 100}"
                   id="qty-${k}" style="width:90px"${locked ? ' disabled' : ''}>
            <button data-unit="${k}"${locked ? ' disabled' : ''}>${locked ? 'Locked' : 'Recruit'}</button>
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

  // Labels are ours; the MAP costs come from the server. They used to be typed
  // here as well, which meant tuning MAP_COST in the engine silently left the
  // buttons advertising the old price.
  const ATTACK_LABELS = {
    ground_battle: 'Ground',
    airstrike: 'Airstrike',
    naval_battle: 'Naval',
  };
  const attacks = () => Object.keys(ATTACK_LABELS).map(key => ({
    key, label: ATTACK_LABELS[key], map: ref.mapCosts[key],
  }));

  /**
   * Control states are the single most confusing thing in a war for a new
   * player: your tanks are worth half and nothing on screen says so. The state
   * was resolved, stored and then never shown. Now each side's state is spelled
   * out in the engine's own words — see CONTROL_STATES in constants.js.
   */
  function controlPanel(w) {
    const rows = [];

    if (w.theirControlState) {
      const c = ref.controlStates[w.theirControlState];
      rows.push(`<div class="ctrl bad">
        <span class="k">${escapeHtml(c?.name || Fmt.label(w.theirControlState))} — they hold it</span>
        <span class="v">${escapeHtml(c?.suffering || '')}</span>
      </div>`);
    }
    if (w.myControlState) {
      const c = ref.controlStates[w.myControlState];
      rows.push(`<div class="ctrl good">
        <span class="k">${escapeHtml(c?.name || Fmt.label(w.myControlState))} — you hold it</span>
        <span class="v">${escapeHtml(c?.holding || '')}</span>
      </div>`);
    }

    if (rows.length === 0) {
      rows.push(`<div class="ctrl">
        <span class="k">No control state</span>
        <span class="v">An Immense Triumph grants one. Any victory at all breaks theirs.</span>
      </div>`);
    }
    return `<div class="controls">${rows.join('')}</div>`;
  }

  /**
   * Launches sit apart from the attack buttons on purpose.
   *
   * They are not another attack — they cost far more MAP, they consume a weapon
   * that took real resources to build, and a nuclear strike puts radiation on
   * every nation in the world including the ones watching. Putting a nuke next
   * to "Ground · 3 MAP" would make it read like one more option in a row.
   *
   * The intercept chance is NOT shown, because you do not know what projects
   * they have bought. Finding that out is what Gather Intelligence is for.
   */
  function launchRow(w) {
    const u = state.nation.units || {};
    const rows = [
      { key: 'missile_launch', unit: 'missiles', label: 'Missile',
        note: 'Levels infrastructure in their largest city. Cannot be rolled for — it arrives, or Iron Dome stops it.' },
      { key: 'nuclear_attack', unit: 'nukes', label: 'Nuclear strike',
        note: 'Far heavier damage, takes buildings with it, and poisons the whole continent AND the world for weeks — including nations with no part in this war.' },
    ].filter(r => (u[r.unit] || 0) > 0 || ref.mapCosts[r.key] !== undefined);

    return rows.map(r => {
      const held = u[r.unit] || 0;
      const cost = ref.mapCosts[r.key];
      const short = state.nation.map < cost;
      const none = held < 1;
      return `<div class="ctrl ${r.key === 'nuclear_attack' ? 'bad' : ''}">
        <span class="k">${escapeHtml(r.label)} · ${held} held</span>
        <span class="v">
          ${escapeHtml(r.note)}
          <button data-launch="${w.id}" data-kind="${r.key}"${none || short ? ' disabled' : ''}>
            ${none ? `No ${r.unit}` : short ? `Need ${cost} MAP` : `Launch · ${cost} MAP`}
          </button>
        </span>
      </div>`;
    }).join('');
  }

  /**
   * There is no "accept" button, because accepting is the same act as offering.
   * When both sides have an offer standing the war ends — which is why this row
   * shows THEIR offer as prominently as yours: an opponent who has already
   * offered is one click away from a war being over.
   */
  function peaceRow(w) {
    if (w.theyOfferedPeace && !w.iOfferedPeace) {
      return `<div class="ctrl good">
        <span class="k">They want peace</span>
        <span class="v">
          They have offered a white peace. Offer one yourself and the war ends now —
          no winner, nothing changes hands, no beige for either side.
          <button data-peace="${w.id}">Accept — end the war</button>
        </span>
      </div>`;
    }
    if (w.iOfferedPeace) {
      return `<div class="ctrl">
        <span class="k">Peace offered</span>
        <span class="v">
          Waiting for them. The war ends the moment they offer too.
          <strong>Attacking withdraws your offer.</strong>
          <button data-unpeace="${w.id}">Withdraw</button>
        </span>
      </div>`;
    }
    return `<div class="ctrl">
      <span class="k">No peace offer</span>
      <span class="v">
        Offer a white peace — the war ends only if they offer as well.
        Nobody wins, nothing changes hands, and neither side gets beige.
        <button data-peace="${w.id}">Offer peace</button>
      </span>
    </div>`;
  }

  function fortifyRow(w) {
    const cost = ref.mapCosts.fortify;
    const pct = Math.round(ref.fortifyCasualtyIncrease * 100);

    if (w.iAmFortified) {
      return `<div class="ctrl good">
        <span class="k">Fortified</span>
        <span class="v">Attacking you costs them ${pct}% more casualties. Ends the moment you attack.</span>
      </div>`;
    }
    const short = state.nation.map < cost;
    return `<div class="ctrl">
      <span class="k">Not fortified</span>
      <span class="v">
        Dig in for ${cost} action points — attackers take ${pct}% more casualties until you attack.
        <button data-fortify="${w.id}"${short ? ' disabled' : ''}>${short
          ? `Need ${cost} points` : `Fortify · ${cost} MAP`}</button>
      </span>
    </div>`;
  }

  function renderWars() {
    el('warCount').textContent = `${wars.length} active`;

    if (wars.length === 0) {
      el('wars').innerHTML = '<p class="empty">No active wars. Pick a target below.</p>';
      return;
    }

    el('wars').innerHTML = wars.map(w => {
      const type = ref.warTypes[w.war_type] || {};
      return `
      <div class="war">
        <div class="war-head">
          <div>
            <h3>${escapeHtml(w.opponentName)}</h3>
            <span class="eyebrow">${w.youDeclared ? 'you declared' : 'declared on you'}${
              w.theyAreFortified ? ' · they are fortified' : ''}</span>
          </div>
          <span class="tag" title="${escapeHtml(type.summary || '')}">${w.war_type}</span>
        </div>

        <p class="muted" style="font-size:.72rem; margin:-.2rem 0 .6rem;">
          ${escapeHtml(type.summary || '')}
          ${type.infraDamage !== undefined
            ? `<span class="num">(infrastructure damage &times;${Fmt.dec(type.infraDamage, 2)}, loot &times;${Fmt.dec(type.loot, 2)})</span>`
            : ''}
        </p>

        <div class="resist">
          <div class="r">
            <span class="k">their resistance</span>
            <div class="track"><div class="fill them" style="width:${w.theirResistance}%"></div></div>
            <span class="v num">${Fmt.dec(w.theirResistance, 0)}</span>
          </div>
          <div class="r">
            <span class="k">yours</span>
            <div class="track"><div class="fill mine" style="width:${w.myResistance}%"></div></div>
            <span class="v num">${Fmt.dec(w.myResistance, 0)}</span>
          </div>
        </div>

        ${controlPanel(w)}
        ${peaceRow(w)}
        ${fortifyRow(w)}
        ${launchRow(w)}

        <div class="attack-buttons">
          ${attacks().map(a => `
            <button data-odds="${w.id}" data-type="${a.key}"
              ${state.nation.map < a.map ? 'disabled' : ''}>${a.label} · ${a.map} MAP</button>`).join('')}
        </div>

        <div class="ledger hidden" id="odds-${w.id}"></div>
      </div>`;
    }).join('');

    el('wars').querySelectorAll('[data-odds]').forEach(b =>
      b.addEventListener('click', () => showOdds(Number(b.dataset.odds), b.dataset.type)));
    el('wars').querySelectorAll('[data-fortify]').forEach(b =>
      b.addEventListener('click', () => doFortify(Number(b.dataset.fortify))));
    el('wars').querySelectorAll('[data-launch]').forEach(b =>
      b.addEventListener('click', () => doLaunch(Number(b.dataset.launch), b.dataset.kind)));
    el('wars').querySelectorAll('[data-peace]').forEach(b =>
      b.addEventListener('click', () => doPeace(Number(b.dataset.peace), false)));
    el('wars').querySelectorAll('[data-unpeace]').forEach(b =>
      b.addEventListener('click', () => doPeace(Number(b.dataset.unpeace), true)));
  }

  async function doLaunch(warId, kind) {
    const nuke = kind === 'nuclear_attack';
    const cost = ref.mapCosts[kind];

    const ok = confirm(
      `${nuke ? 'Launch a NUCLEAR STRIKE' : 'Launch a missile'}?\n\n` +
      `Costs ${cost} action points and one ${nuke ? 'nuke' : 'missile'}.\n` +
      `The weapon is spent even if it is intercepted.\n\n` +
      (nuke
        ? 'Radiation will be added to the entire continent AND the world. ' +
          'Every nation is affected, including those with no part in this war.\n\n'
        : '') +
      'This cannot be undone.'
    );
    if (!ok) return;

    try {
      clearMessage(msg);
      const r = await API.attack(warId, kind);
      showMessage(msg, describeLaunch(r), r.intercepted ? 'error' : 'ok');
      await load();
    } catch (err) {
      showMessage(msg, err.message);
    }
  }

  function describeLaunch(r) {
    if (r.intercepted) {
      return 'Intercepted. The weapon is gone and nothing was destroyed — they have the defence project.';
    }
    const parts = [`Landed on ${r.targetCity}. ${Fmt.dec(r.infraDestroyed, 2)} infrastructure destroyed.`];
    if (r.improvementsDestroyed?.length) {
      parts.push(`Destroyed ${r.improvementsDestroyed.map(Fmt.label).join(', ')}.`);
    }
    if (r.radiation) {
      parts.push(`Radiation added to ${Fmt.label(r.radiation.continent || 'the continent')} and to the world.`);
    }
    return parts.join(' ');
  }

  async function doPeace(warId, withdraw) {
    try {
      clearMessage(msg);
      const r = withdraw ? await API.withdrawPeace(warId) : await API.offerPeace(warId);
      showMessage(msg,
        r.peace
          ? 'White peace agreed. The war is over — no winner, nothing changed hands.'
          : withdraw
            ? 'Peace offer withdrawn.'
            : 'Peace offered. The war ends the moment they offer too.',
        r.peace || !withdraw ? 'ok' : 'error');
      await load();
    } catch (err) {
      showMessage(msg, err.message);
    }
  }

  async function doFortify(warId) {
    try {
      clearMessage(msg);
      const r = await API.fortify(warId);
      showMessage(msg,
        `Fortified. Attacking you now costs ${Math.round(r.attackerCasualtyIncrease * 100)}% ` +
        `more casualties. ${r.mapRemaining} action points left.`, 'ok');
      await load();
    } catch (err) {
      showMessage(msg, err.message);
    }
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
