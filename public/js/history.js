/**
 * ==========================================================================
 *  history.js
 * ==========================================================================
 *
 *  WHY THIS PAGE EXISTS
 *
 *  Every battle stores its rng_seed. That single column is what separates
 *  "the game cheated me" from a checkable claim — feed the seed and the two
 *  army values back through the same roll function and you must get the same
 *  result. The server does exactly that and returns whether it matched.
 *
 *  So this page does not merely list what happened. Each battle can be
 *  verified, live, and the page shows the verdict. A player who thinks a loss
 *  was wrong gets an answer instead of an argument.
 * ==========================================================================
 */

(() => {
  'use strict';
  if (!requireLogin()) return;

  const el = id => document.getElementById(id);
  const msg = el('msg');

  let wars = [], me = null, health = null, turn = 0;
  const battlesByWar = new Map();   // warId -> battle rows
  const openWars = new Set();

  el('signOut').addEventListener('click', e => { e.preventDefault(); API.logout(); });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  function startClock() {
    const tick = () => {
      el('clockTurn').textContent = `Turn ${turn || '—'}`;
      if (!health?.lastTick || !health?.turnIntervalMs) return;
      const remaining = new Date(health.lastTick).getTime() + health.turnIntervalMs - Date.now();
      el('clockUntil').textContent = `next in ${Fmt.duration(remaining)}`;
      el('clock').classList.toggle('imminent', remaining < 60000);
    };
    tick();
    setInterval(tick, 1000);
  }

  const VICTORY = ['Utter Failure', 'Pyrrhic Victory', 'Moderate Success', 'Immense Triumph'];

  function outcome(w) {
    if (w.active) return { label: 'ongoing', cls: '' };
    if (w.winner_id === null) return { label: 'ended, no winner', cls: 'muted' };
    const won = Number(w.winner_id) === me.id;
    return { label: won ? 'won' : 'lost', cls: won ? 'good' : 'bad' };
  }

  // ------------------------------------------------------------------
  // Summary
  // ------------------------------------------------------------------

  function renderRecord() {
    const finished = wars.filter(w => !w.active);
    const won = finished.filter(w => Number(w.winner_id) === me.id).length;
    const lost = finished.filter(w => w.winner_id !== null && Number(w.winner_id) !== me.id).length;
    const active = wars.filter(w => w.active).length;
    const offensive = wars.filter(w => w.youAttacked).length;

    el('recordNote').textContent = `${wars.length} war${wars.length === 1 ? '' : 's'}`;
    el('record').innerHTML = wars.length === 0
      ? '<p class="empty">You have not fought a war yet.</p>'
      : `<table class="ledger-table"><tbody>
          <tr><td data-label="Metric">Active</td><td data-label="Value" class="num">${active}</td></tr>
          <tr><td data-label="Metric">Won</td><td data-label="Value" class="num ${won ? 'good' : ''}">${won}</td></tr>
          <tr><td data-label="Metric">Lost</td><td data-label="Value" class="num ${lost ? 'bad' : ''}">${lost}</td></tr>
          <tr><td data-label="Metric">You declared</td><td data-label="Value" class="num">${offensive}</td></tr>
          <tr><td data-label="Metric">Declared on you</td><td data-label="Value" class="num">${wars.length - offensive}</td></tr>
        </tbody></table>`;
  }

  // ------------------------------------------------------------------
  // Wars
  // ------------------------------------------------------------------

  function renderWars() {
    if (wars.length === 0) { el('wars').innerHTML = ''; return; }

    el('wars').innerHTML = wars.map(w => {
      const o = outcome(w);
      const them = w.youAttacked ? w.defender_name : w.attacker_name;
      const open = openWars.has(w.id);
      return `
        <section class="panel war" style="margin-bottom:var(--gap-l)">
          <header>
            <h2>${w.youAttacked ? 'You attacked' : 'Attacked by'} ${escapeHtml(them)}</h2>
            <span class="eyebrow ${o.cls}">${o.label}</span>
          </header>
          <div class="body">
            <table class="ledger-table"><tbody>
              <tr><td data-label="Metric">War type</td>
                  <td data-label="Value">${Fmt.label(w.war_type)}</td></tr>
              <tr><td data-label="Metric">Turns</td>
                  <td data-label="Value" class="num">${w.started_turn}${w.ended_turn ? ` — ${w.ended_turn}` : ' — now'}</td></tr>
              <tr><td data-label="Metric">Your resistance</td>
                  <td data-label="Value" class="num">${Fmt.dec(w.youAttacked ? w.attacker_resistance : w.defender_resistance, 0)}</td></tr>
              <tr><td data-label="Metric">Their resistance</td>
                  <td data-label="Value" class="num">${Fmt.dec(w.youAttacked ? w.defender_resistance : w.attacker_resistance, 0)}</td></tr>
              <tr><td data-label="Metric">Battles</td>
                  <td data-label="Value" class="num">${w.battleCount}</td></tr>
            </tbody></table>
            ${w.battleCount > 0 ? `
              <button data-war="${w.id}" style="margin-top:.7rem;">
                ${open ? 'Hide battles' : `Show ${w.battleCount} battle${w.battleCount === 1 ? '' : 's'}`}
              </button>` : '<p class="muted" style="font-size:.74rem; margin-top:.6rem;">No battles were fought.</p>'}
            <div id="battles-${w.id}">${open ? renderBattles(w) : ''}</div>
          </div>
        </section>`;
    }).join('');

    for (const btn of document.querySelectorAll('[data-war]')) {
      btn.addEventListener('click', () => toggleWar(Number(btn.dataset.war)));
    }
    for (const btn of document.querySelectorAll('[data-verify]')) {
      btn.addEventListener('click', () => verify(Number(btn.dataset.verify)));
    }
  }

  function renderBattles(w) {
    const rows = battlesByWar.get(w.id);
    if (!rows) return '<p class="muted" style="font-size:.74rem;">Loading…</p>';

    return `
      <table class="battles" style="margin-top:.8rem;">
        <thead><tr>
          <th>Turn</th><th>Attack</th><th>By</th><th>Result</th>
          <th>Infra</th><th>Loot</th><th>Seed</th><th></th>
        </tr></thead>
        <tbody>
          ${rows.map(b => {
            const mine = Number(b.attacker_id) === me.id;
            return `<tr>
              <td data-label="Turn" class="num">${b.turn}</td>
              <td data-label="Attack">${Fmt.label(b.attack_type)}</td>
              <td data-label="By">${mine ? 'you' : 'them'}</td>
              <td data-label="Result" class="${mine === (b.victoryType > 0) ? 'good' : 'bad'}">${VICTORY[b.victoryType]}</td>
              <td data-label="Infra" class="num">${Fmt.dec(b.infra_destroyed, 2)}</td>
              <td data-label="Loot" class="num">${Fmt.money(b.loot)}</td>
              <td data-label="Seed" class="num muted" style="font-size:.68rem;">${escapeHtml(b.rngSeed || '—')}</td>
              <td data-label="">${b.replayable
                ? `<button data-verify="${b.id}" id="v-${b.id}">Replay</button>`
                : '<span class="muted">—</span>'}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
      <p class="muted" style="font-size:.72rem; margin-top:.6rem; line-height:1.5;">
        Replay re-runs the stored seed through the live combat engine and compares
        the outcome with what was recorded. A mismatch would mean the engine changed
        under a finished battle — which is exactly what you would want to know.
      </p>`;
  }

  async function toggleWar(warId) {
    const w = wars.find(x => x.id === warId);
    if (!w) return;
    if (openWars.has(warId)) {
      openWars.delete(warId);
      renderWars();
      return;
    }
    openWars.add(warId);
    renderWars();
    try {
      if (!battlesByWar.has(warId)) {
        const res = await API.warBattles(warId);
        battlesByWar.set(warId, res.battles);
      }
      renderWars();
    } catch (err) {
      showMessage(msg, err.message);
    }
  }

  async function verify(battleId) {
    const btn = el(`v-${battleId}`);
    if (btn) { btn.disabled = true; btn.textContent = 'Replaying…'; }
    try {
      const res = await API.battle(battleId);
      if (btn) {
        btn.textContent = res.verified ? 'Verified ✓' : 'MISMATCH';
        btn.className = res.verified ? 'good' : 'bad';
      }
      if (!res.verified) {
        showMessage(msg,
          `Battle ${battleId} did not reproduce: recorded ${VICTORY[res.battle.victory_type]}, ` +
          `replay gave ${VICTORY[res.replay.victoryType]}. Please report this.`);
      }
    } catch (err) {
      if (btn) { btn.disabled = false; btn.textContent = 'Replay'; }
      showMessage(msg, err.message);
    }
  }

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------

  (async () => {
    try {
      const [hist, snap, h] = await Promise.all([
        API.warHistory(100), API.nation(), API.health().catch(() => null),
      ]);
      wars = hist.wars;
      me = { id: snap.nation.id };
      turn = snap.turn;
      health = h;
      renderRecord();
      renderWars();
      startClock();
    } catch (err) {
      showMessage(msg, err.message);
    }
  })();
})();
