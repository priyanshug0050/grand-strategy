/**
 * ==========================================================================
 *  admin.js — the admin panel
 * ==========================================================================
 *
 *  SECURITY NOTE, BECAUSE IT IS EASY TO MISREAD THIS FILE
 *  --------------------------------------------------------------------------
 *  Nothing here is a security control. This page is served from public/ like
 *  any other file, and anyone can open it, read this source, and call any
 *  function in it.
 *
 *  That is fine. Every request it makes returns 404 unless the DATABASE says
 *  the caller is an admin. The gate below hides the UI from non-admins as a
 *  courtesy — so a normal player who stumbles here sees nothing confusing —
 *  not as protection.
 *
 *  If you ever find yourself adding a check here "for security", the check
 *  belongs on the server instead.
 * ==========================================================================
 */

(() => {
  'use strict';
  if (!requireLogin()) return;

  const el = id => document.getElementById(id);
  const msg = () => el('msg');
  let currentNation = null;

  el('signOut').addEventListener('click', e => { e.preventDefault(); API.logout(); });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  // ------------------------------------------------------------------
  // Gate — the server decides, not this file
  // ------------------------------------------------------------------

  async function checkAdmin() {
    try {
      const r = await API.adminWhoami();
      el('whoami').textContent = r.email;
      el('gate').classList.add('hidden');
      el('panel').classList.remove('hidden');
      return true;
    } catch {
      // 404 for non-admins. Say nothing about what lives here.
      el('gate').innerHTML = '<p class="empty">Not found.</p>';
      return false;
    }
  }

  // ------------------------------------------------------------------
  // Tabs
  // ------------------------------------------------------------------

  document.querySelectorAll('[data-tab]').forEach(b =>
    b.addEventListener('click', () => {
      document.querySelectorAll('[data-tab]').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      document.querySelectorAll('.admin-tab').forEach(t => t.classList.add('hidden'));
      el('tab-' + b.dataset.tab).classList.remove('hidden');
      if (b.dataset.tab === 'integrity') loadIntegrity();
      if (b.dataset.tab === 'log') loadLog();
    }));

  // ------------------------------------------------------------------
  // Nations
  // ------------------------------------------------------------------

  async function loadNations() {
    try {
      const q = el('search').value.trim();
      const r = await API.adminNations(q);

      el('nations').innerHTML = `
        <table class="ledger-table">
          <thead>
            <tr><th>Nation</th><th>Email</th><th>Cities</th><th>Infra</th>
                <th>Money</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
          ${r.nations.map(n => `
            <tr class="${n.isDeleted || n.isBanned ? 'dim' : ''}">
              <td class="res-name">${escapeHtml(n.name)}</td>
              <td class="num muted" data-label="Email">${escapeHtml(n.email)}</td>
              <td class="num" data-label="Cities">${n.cities}</td>
              <td class="num" data-label="Infrastructure">${Fmt.int(n.infrastructure)}</td>
              <td class="num" data-label="Money">${Fmt.money(n.money)}</td>
              <td class="num" data-label="Status">
                ${n.isAdmin ? '<span class="badge">admin</span>' : ''}
                ${n.isBanned ? '<span class="badge poll">banned</span>' : ''}
                ${n.onBeige ? '<span class="badge">beige</span>' : ''}
              </td>
              <td><button data-inspect="${n.id}">Inspect</button></td>
            </tr>`).join('')}
          </tbody>
        </table>`;

      el('nations').querySelectorAll('[data-inspect]').forEach(b =>
        b.addEventListener('click', () => inspect(Number(b.dataset.inspect))));
    } catch (err) {
      showMessage(msg(), err.message);
    }
  }

  async function inspect(id) {
    try {
      const d = await API.adminInspect(id);
      currentNation = d;
      const n = d.nation;

      const resources = Object.entries(n.stockpile)
        .filter(([k]) => k !== 'money' && k !== 'credits')
        .map(([k, v]) => `
          <div class="admin-res">
            <span class="k">${k}</span>
            <span class="num">${Fmt.dec(v, 1)}</span>
            <button data-res="${k}">Set</button>
          </div>`).join('');

      el('inspector').innerHTML = `
        <section class="panel" style="margin-top:var(--gap-l)">
          <header>
            <h2>${escapeHtml(n.name)}</h2>
            <span class="eyebrow">score ${d.score} · pop ${Fmt.int(d.population)}</span>
          </header>
          <div class="body">

            <div class="field">
              <label for="reason">Reason (required, and permanently recorded)</label>
              <input id="reason" placeholder="Refund for the failed build in war #412">
            </div>

            <div class="admin-grid">
              <div>
                <h3>Money</h3>
                <div class="row-controls">
                  <div class="field">
                    <label for="moneyVal">Set to</label>
                    <input id="moneyVal" type="number" min="0" value="${Math.round(n.money)}">
                  </div>
                  <button id="setMoney">Apply</button>
                </div>
                <p class="muted" style="font-size:.68rem; margin-top:.4rem;">
                  Absolute, not relative — so the log stays reproducible.
                </p>
              </div>

              <div>
                <h3>Beige</h3>
                <div class="row-controls">
                  <div class="field">
                    <label for="beigeTurns">Turns (0 to lift)</label>
                    <input id="beigeTurns" type="number" min="0" value="0">
                  </div>
                  <button id="setBeige">Apply</button>
                </div>
              </div>
            </div>

            <h3 style="margin-top:1.2rem">Resources</h3>
            <div class="admin-res-grid">${resources}</div>

            ${d.wars.length ? `
              <h3 style="margin-top:1.2rem">Active wars</h3>
              ${d.wars.map(w => `
                <div class="admin-war">
                  <span>${escapeHtml(w.attacker_name)} → ${escapeHtml(w.defender_name)} (${w.war_type})</span>
                  <button data-endwar="${w.id}">End war</button>
                </div>`).join('')}` : ''}

            ${d.adminHistory.length ? `
              <h3 style="margin-top:1.2rem">Previous admin actions on this nation</h3>
              <div class="ledger" style="margin-top:.4rem">
                ${d.adminHistory.map(h => `
                  <div class="row">
                    <span class="k">${escapeHtml(h.action)} — ${escapeHtml(h.reason || 'no reason given')}</span>
                    <span class="v muted">${escapeHtml(h.admin_email)}</span>
                  </div>`).join('')}
              </div>` : ''}

          </div>
        </section>`;

      el('setMoney').addEventListener('click', () => act(
        () => API.adminSetMoney(id, Number(el('moneyVal').value), reason()),
        r => `${r.nation}: money ${Fmt.money(r.before)} → ${Fmt.money(r.after)}`));

      el('setBeige').addEventListener('click', () => act(
        () => API.adminSetBeige(id, Number(el('beigeTurns').value), reason()),
        r => `${r.nation}: beige ${r.beigeUntilTurn ? 'set to turn ' + r.beigeUntilTurn : 'lifted'}`));

      el('inspector').querySelectorAll('[data-res]').forEach(b =>
        b.addEventListener('click', () => {
          const res = b.dataset.res;
          const amount = prompt(`Set ${res} to:`, Math.round(n.stockpile[res] || 0));
          if (amount === null) return;
          act(() => API.adminSetResource(id, res, Number(amount), reason()),
              r => `${r.nation}: ${r.resource} ${Fmt.dec(r.before,1)} → ${Fmt.dec(r.after,1)}`);
        }));

      el('inspector').querySelectorAll('[data-endwar]').forEach(b =>
        b.addEventListener('click', () => act(
          () => API.adminEndWar(Number(b.dataset.endwar), reason()),
          r => `War ${r.warId} ended on turn ${r.endedTurn}`)));

    } catch (err) {
      showMessage(msg(), err.message);
    }
  }

  function reason() {
    return el('reason')?.value.trim() || '';
  }

  /** Run an admin action, report it, then refresh so the log is visible. */
  async function act(fn, describe) {
    if (!reason()) {
      return showMessage(msg(), 'Give a reason first. It is recorded permanently and you will want it later.');
    }
    try {
      clearMessage(msg());
      const r = await fn();
      showMessage(msg(), describe(r) + ' — recorded in the audit log.', 'ok');
      if (currentNation) inspect(currentNation.nation.id);
      loadNations();
    } catch (err) {
      showMessage(msg(), err.message);
    }
  }

  // ------------------------------------------------------------------
  // Integrity
  // ------------------------------------------------------------------

  async function loadIntegrity() {
    try {
      const [l, t] = await Promise.all([API.adminLinks(), API.adminFlaggedTrades()]);

      el('links').innerHTML = l.links.length
        ? `<table class="ledger-table">
             <thead><tr><th>Nation</th><th>shares an IP with</th></tr></thead>
             <tbody>${l.links.map(x => `
               <tr><td class="res-name">${escapeHtml(x.a.name)}</td>
                   <td class="res-name">${escapeHtml(x.b.name)}</td></tr>`).join('')}
             </tbody></table>`
        : '<p class="empty">No shared connections found.</p>';

      el('trades').innerHTML = t.trades.length
        ? `<table class="ledger-table">
             <thead><tr><th>Resource</th><th>Price</th><th>Qty</th>
                        <th>Seller</th><th>Buyer</th><th>Turn</th></tr></thead>
             <tbody>${t.trades.map(x => `
               <tr>
                 <td class="res-name">${escapeHtml(x.resource)}</td>
                 <td class="num neg">${Fmt.money(x.price)}</td>
                 <td class="num">${Fmt.dec(x.quantity,1)}</td>
                 <td class="num">${escapeHtml(x.seller || '—')}</td>
                 <td class="num">${escapeHtml(x.buyer || '—')}</td>
                 <td class="num muted">T${x.turn}</td>
               </tr>`).join('')}
             </tbody></table>`
        : '<p class="empty">No unusual trades.</p>';
    } catch (err) {
      showMessage(msg(), err.message);
    }
  }

  // ------------------------------------------------------------------
  // Audit log
  // ------------------------------------------------------------------

  async function loadLog() {
    try {
      const r = await API.adminLog();
      el('log').innerHTML = r.entries.length
        ? `<table class="ledger-table">
             <thead><tr><th>When</th><th>Admin</th><th>Action</th>
                        <th>Target</th><th>Change</th><th>Reason</th></tr></thead>
             <tbody>${r.entries.map(e => `
               <tr>
                 <td class="num muted" data-label="When">${new Date(e.created_at).toLocaleString()}</td>
                 <td class="num" data-label="Admin">${escapeHtml(e.admin_email)}</td>
                 <td class="res-name">${escapeHtml(e.action)}</td>
                 <td class="num" data-label="Target">${escapeHtml(e.target_name || '—')}</td>
                 <td class="num muted" style="font-size:.66rem">
                   ${e.before_value ? escapeHtml(JSON.stringify(e.before_value)) : ''}
                   ${e.after_value ? '→ ' + escapeHtml(JSON.stringify(e.after_value)) : ''}
                 </td>
                 <td class="num muted">${escapeHtml(e.reason || '—')}</td>
               </tr>`).join('')}
             </tbody></table>`
        : '<p class="empty">Nothing has been done yet.</p>';
    } catch (err) {
      showMessage(msg(), err.message);
    }
  }

  // ------------------------------------------------------------------

  el('searchBtn').addEventListener('click', loadNations);
  el('search').addEventListener('keydown', e => { if (e.key === 'Enter') loadNations(); });

  (async () => {
    if (await checkAdmin()) loadNations();
  })();
})();
