/**
 * ==========================================================================
 *  espionage.js
 * ==========================================================================
 *
 *  ODDS BEFORE COMMITMENT, AGAIN
 *
 *  The military page already refuses to let you attack blind. Espionage has the
 *  same problem in a worse form: a failed operation costs you up to a quarter of
 *  a spy roster that takes weeks to rebuild, and in Politics & War you find that
 *  out afterwards.
 *
 *  So every operation shows its real success chance for the chosen target and
 *  safety level BEFORE the button does anything — computed on the server by the
 *  same function that will resolve the attempt, never re-derived here.
 *
 *  What is deliberately NOT shown is the target's spy count. That is what
 *  gather_intelligence is for. You get the odds, which already encode it.
 * ==========================================================================
 */

(() => {
  'use strict';
  if (!requireLogin()) return;

  const el = id => document.getElementById(id);
  const msg = el('msg');

  let data = null;        // /api/espionage, optionally with a target
  let ref = null;
  let rankings = null;
  let log = null;
  let health = null;
  let busy = false;

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
  // Roster and training
  // ------------------------------------------------------------------

  function renderRoster() {
    el('rosterNote').textContent = `${data.spies}/${data.maxSpies} spies`;
    el('roster').innerHTML = `
      <table class="ledger-table"><tbody>
        <tr><td data-label="Metric">Spies</td>
            <td data-label="Value" class="num">${data.spies} of ${data.maxSpies}</td></tr>
        <tr><td data-label="Metric">Operations left today</td>
            <td data-label="Value" class="num">${data.operationsPerDay - data.operationsToday} of ${data.operationsPerDay}</td></tr>
        <tr><td data-label="Metric">Your score</td>
            <td data-label="Value" class="num">${Fmt.dec(data.score, 2)}</td></tr>
        <tr><td data-label="Metric">Espionage range</td>
            <td data-label="Value" class="num">${Fmt.dec(data.range.min, 1)} — ${Fmt.dec(data.range.max, 1)}</td></tr>
      </tbody></table>
      ${data.hasAgency
        ? '<p class="muted" style="font-size:.72rem; margin-top:.6rem;">Intelligence Agency built — raised roster and training rate.</p>'
        : `<p class="muted" style="font-size:.72rem; margin-top:.6rem;">
             The <a href="/projects.html">Intelligence Agency</a> project raises both your roster cap and how fast you can train.
           </p>`}`;
  }

  function renderTrain() {
    const left = data.trainingPerDay - data.trainedToday;
    const roomInRoster = data.maxSpies - data.spies;
    const canTrain = Math.min(left, roomInRoster);
    const unit = data.spyCost.money;

    el('trainNote').textContent = `${data.trainedToday}/${data.trainingPerDay} trained today`;
    el('train').innerHTML = `
      <p class="muted" style="font-size:.74rem; margin-bottom:.7rem; line-height:1.5;">
        ${Fmt.money(unit)} each. The daily cap, not the price, is the real limit —
        a full service takes weeks, which is why losing spies actually hurts.
      </p>
      ${canTrain <= 0
        ? `<p class="empty">${roomInRoster <= 0
             ? 'Your service is at full strength.'
             : 'You have trained all you can today.'}</p>`
        : `<div class="row-controls" style="gap:.4rem;">
             <input type="number" id="trainQty" min="1" max="${canTrain}" value="${canTrain}" style="width:90px">
             <button class="primary" id="trainBtn">Train · ${Fmt.money(unit)} each</button>
           </div>
           <p class="muted" style="font-size:.7rem; margin-top:.5rem;">
             You can train ${canTrain} more right now.
           </p>`}`;

    if (el('trainBtn')) el('trainBtn').addEventListener('click', doTrain);
  }

  async function doTrain() {
    const count = Number(el('trainQty').value);
    if (!Number.isInteger(count) || count <= 0) return showMessage(msg, 'Enter a whole number above zero.');
    try {
      clearMessage(msg);
      const r = await API.trainSpies(count);
      showMessage(msg, `Trained ${count}. Your service now holds ${r.spies} spies.`, 'ok');
      await load();
    } catch (err) {
      showMessage(msg, err.message + (err.details?.maxPossible !== undefined
        ? ` You can train ${err.details.maxPossible} right now.` : ''));
    }
  }

  // ------------------------------------------------------------------
  // Targets and operations
  // ------------------------------------------------------------------

  function renderTargetPicker() {
    const sel = el('target');
    const chosen = sel.value;
    const inRange = (rankings?.nations || []).filter(n =>
      n.id !== undefined && n.score >= data.range.min && n.score <= data.range.max);

    sel.innerHTML = '<option value="">Choose a nation…</option>' + inRange.map(n =>
      `<option value="${n.id}"${String(n.id) === chosen ? ' selected' : ''}>
         ${escapeHtml(n.name)} · score ${Fmt.dec(n.score, 1)}${n.onBeige ? ' · beige' : ''}
       </option>`).join('');

    const safety = el('safety');
    if (!safety.options.length) {
      safety.innerHTML = Object.entries(ref.espionage.safetyLevels).map(([key, info]) =>
        `<option value="${key}"${key === 'normal_precautions' ? ' selected' : ''}>${escapeHtml(info.name)}</option>`).join('');
    }
  }

  function renderOperations() {
    const t = data.target;
    el('opsNote').textContent = `${data.operationsPerDay - data.operationsToday} left today`;

    if (!t) {
      el('operations').innerHTML = '<p class="empty">Choose a target to see your real odds for each operation.</p>';
      return;
    }
    if (t.onBeige) {
      el('operations').innerHTML =
        `<p class="empty">${escapeHtml(t.name)} is on beige and cannot be targeted.</p>`;
      return;
    }
    if (!t.inRange) {
      el('operations').innerHTML =
        `<p class="empty">${escapeHtml(t.name)} is outside your espionage range.</p>`;
      return;
    }

    const safety = el('safety').value;
    const noSpies = data.spies < 1;
    const noOps = data.operationsToday >= data.operationsPerDay;

    const rows = Object.entries(ref.espionage.operations).map(([key, info]) => {
      const odds = t.odds[key]?.[safety] ?? 0;
      const difficulty = ref.espionage.difficulty[key];
      const cls = odds >= 60 ? 'good' : odds >= 25 ? '' : 'bad';
      return `
        <tr>
          <td data-label="Operation">
            <strong>${escapeHtml(info.name)}</strong><br>
            <span class="muted" style="font-size:.72rem">${escapeHtml(info.summary)}</span>
          </td>
          <td data-label="Difficulty" class="num">&divide;${Fmt.dec(difficulty, 1)}</td>
          <td data-label="Odds" class="num ${cls}">${Fmt.dec(odds, 1)}%</td>
          <td data-label="">
            <button data-op="${key}"${noSpies || noOps ? ' disabled' : ''}>Run</button>
          </td>
        </tr>`;
    }).join('');

    el('operations').innerHTML = `
      <table class="rankings">
        <thead><tr><th>Operation</th><th>Difficulty</th><th>Success</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="muted" style="font-size:.72rem; margin-top:.6rem; line-height:1.5;">
        ${noSpies ? '<strong>You have no spies.</strong> Train some first. ' : ''}
        ${noOps ? '<strong>No operations left today.</strong> ' : ''}
        Odds already account for their spies, your safety level and both military doctrines.
        A failed operation costs you spies; a detected one tells them who you are.
      </p>`;

    el('operations').querySelectorAll('[data-op]').forEach(b =>
      b.addEventListener('click', () => runOp(b.dataset.op)));
  }

  async function runOp(operation) {
    if (busy || !data.target) return;
    const safety = el('safety').value;
    const info = ref.espionage.operations[operation];
    const odds = data.target.odds[operation]?.[safety] ?? 0;

    const ok = confirm(
      `${info.name} against ${data.target.name}?\n\n` +
      `Success chance: ${odds.toFixed(1)}%\n` +
      `Safety: ${ref.espionage.safetyLevels[safety].name}\n\n` +
      `A failure costs spies. Detection tells them it was you.`
    );
    if (!ok) return;

    busy = true;
    clearMessage(msg);
    try {
      const r = await API.runEspionage(data.target.id, operation, safety);
      showMessage(msg, describeResult(r), r.success ? 'ok' : 'error');
      await load();
    } catch (err) {
      showMessage(msg, err.message);
    } finally {
      busy = false;
    }
  }

  function describeResult(r) {
    const parts = [];
    if (r.success) {
      if (r.outcome?.kind === 'reveal') {
        const v = r.outcome.revealed;
        const army = Object.entries(v.units || {})
          .filter(([, n]) => n > 0).map(([k, n]) => `${Fmt.int(n)} ${k}`).join(', ') || 'nothing';
        parts.push(`Intelligence gathered. Army: ${army}. Spies: ${v.spies}.`);
      } else if (r.outcome?.hitNothing) {
        parts.push(`Operation succeeded, but they had no ${r.outcome.target} to destroy.`);
      } else {
        parts.push(`Success — destroyed ${Fmt.int(r.outcome.destroyed)} ${r.outcome.target}.`);
      }
    } else {
      parts.push(`Failed at ${Fmt.dec(r.odds, 1)}% odds.`);
    }
    if (r.spiesLost > 0) parts.push(`Lost ${r.spiesLost} spies.`);
    parts.push(r.detected ? 'You were identified.' : 'You were not identified.');
    return parts.join(' ');
  }

  // ------------------------------------------------------------------
  // Log
  // ------------------------------------------------------------------

  function renderLog() {
    const ops = log?.operations || [];
    el('logNote').textContent = `${ops.length} recorded`;

    if (ops.length === 0) {
      el('log').innerHTML = '<p class="empty">No operations yet, in either direction.</p>';
      return;
    }

    el('log').innerHTML = `
      <table class="rankings">
        <thead><tr>
          <th>Turn</th><th>Direction</th><th>Operation</th><th>Other nation</th>
          <th>Odds</th><th>Result</th><th>Effect</th>
        </tr></thead>
        <tbody>
          ${ops.map(o => {
            const info = ref.espionage.operations[o.operation];
            // "0 tanks" reads as a bug. An operation that lands on an empty
            // hangar succeeded and achieved nothing — say that.
            const eff = o.result && o.result.kind === 'destroy'
              ? (o.result.destroyed > 0
                  ? `${Fmt.int(o.result.destroyed)} ${o.result.target}`
                  : `<span class="muted">nothing to destroy</span>`)
              : o.result && o.result.kind === 'reveal' ? 'intelligence' : '—';
            return `<tr>
              <td data-label="Turn" class="num">${o.turn}</td>
              <td data-label="Direction">${o.yoursToRun ? 'you ran' : 'against you'}</td>
              <td data-label="Operation">${escapeHtml(info?.name || o.operation)}</td>
              <td data-label="Other nation">${o.other
                ? escapeHtml(o.other)
                : '<span class="muted">unidentified</span>'}</td>
              <td data-label="Odds" class="num">${Fmt.dec(o.odds, 1)}%</td>
              <td data-label="Result" class="${o.success ? 'good' : 'bad'}">${o.success ? 'success' : 'failed'}</td>
              <td data-label="Effect">${eff}${o.spiesLost ? ` · lost ${o.spiesLost} spies` : ''}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
      <p class="muted" style="font-size:.72rem; margin-top:.6rem;">
        An operation run against you shows "unidentified" unless the attacker was
        detected. That is what the safety level buys.
      </p>`;
  }

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------

  el('target').addEventListener('change', () => load());
  el('safety').addEventListener('change', () => renderOperations());

  async function load() {
    const targetId = el('target').value || null;
    [data, log] = await Promise.all([API.espionage(targetId), API.espionageLog(40)]);
    renderRoster();
    renderTrain();
    renderTargetPicker();
    renderOperations();
    renderLog();
  }

  (async () => {
    try {
      [ref, rankings, health] = await Promise.all([
        API.reference(), API.rankings(250), API.health().catch(() => null),
      ]);
      await load();
      startClock();
    } catch (err) {
      showMessage(msg, err.message);
    }
  })();
})();
