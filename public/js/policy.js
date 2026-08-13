/**
 * ==========================================================================
 *  policy.js — the government page
 * ==========================================================================
 *
 *  WHAT THIS PAGE HAS TO COMMUNICATE
 *  --------------------------------------------------------------------------
 *  Politics & War lists six domestic policies with one line each, all of them
 *  pure bonuses. There is nothing to weigh, so the page is a menu.
 *
 *  Here every policy costs something, which means the page has real work to
 *  do: show the gain AND the cost side by side, and — before you commit —
 *  the full diff of what swapping would change, because one swap moves several
 *  unrelated numbers and then locks for days.
 *
 *  Same principle as the city purchase preview and the battle odds:
 *  consequence before commitment.
 * ==========================================================================
 */

(() => {
  'use strict';
  if (!requireLogin()) return;

  const msg = document.getElementById('msg');
  const el = id => document.getElementById(id);
  let data = null, health = null;
  let previewing = {};   // slot -> policy key currently being previewed

  el('signOut').addEventListener('click', e => { e.preventDefault(); API.logout(); });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  function startClock() {
    const t = () => {
      el('clockTurn').textContent = `Turn ${data.turn}`;
      if (!health?.lastTick || !health?.turnIntervalMs) return;
      const remaining = new Date(health.lastTick).getTime() + health.turnIntervalMs - Date.now();
      el('clockUntil').textContent = `next in ${Fmt.duration(remaining)}`;
      el('clock').classList.toggle('imminent', remaining < 60000);
    };
    t(); setInterval(t, 1000);
  }

  // ------------------------------------------------------------------
  // In force — the net effect of everything you are running
  // ------------------------------------------------------------------

  function renderCurrent() {
    const active = data.activeEffects;

    el('ampLine').textContent = data.amplification > 0
      ? `policy effects amplified ${Math.round(data.amplification * 100)}% by projects`
      : '';

    if (!active.length) {
      el('current').innerHTML = `<p class="empty">
        No policies set. Every slot below is empty — you are running a government
        with no doctrine at all, which costs nothing and gains nothing.
      </p>`;
      return;
    }

    // Grouped so the tradeoff is visible at a glance: what you gained on the
    // left, what it cost on the right.
    const good = active.filter(e => e.good);
    const bad = active.filter(e => !e.good);

    el('current').innerHTML = `
      <div class="effect-split">
        <div class="effect-col">
          <h3 class="pos">You gain</h3>
          ${good.length
            ? good.map(e => `<div class="effect pos">${escapeHtml(e.text)}</div>`).join('')
            : '<p class="muted" style="font-size:.75rem">Nothing yet.</p>'}
        </div>
        <div class="effect-col">
          <h3 class="neg">You give up</h3>
          ${bad.length
            ? bad.map(e => `<div class="effect neg">${escapeHtml(e.text)}</div>`).join('')
            : '<p class="muted" style="font-size:.75rem">Nothing yet.</p>'}
        </div>
      </div>`;
  }

  // ------------------------------------------------------------------
  // Slots
  // ------------------------------------------------------------------

  function renderSlots() {
    el('slots').innerHTML = Object.entries(data.catalogue).map(([slot, info]) => {
      const state = data.slots[slot];
      const activeKey = state.active;

      return `
      <section class="panel" style="margin-bottom:var(--gap-l)">
        <header>
          <h2>${escapeHtml(info.label)}</h2>
          <span class="eyebrow ${state.canChange ? '' : 'locked'}">
            ${state.canChange
              ? (activeKey ? 'can be changed' : 'empty slot')
              : `locked ${state.daysRemaining}d`}
          </span>
        </header>
        <div class="body">
          <p class="muted" style="font-size:.78rem; margin-bottom:.9rem;">${escapeHtml(info.blurb)}</p>

          <div class="policy-grid">
            ${info.policies.map(p => policyCard(p, activeKey, state)).join('')}
          </div>

          ${activeKey && state.canChange ? `
            <button class="clear-policy" data-clear="${slot}">Repeal ${escapeHtml(
              info.policies.find(p => p.key === activeKey)?.name || activeKey)}</button>` : ''}
        </div>
      </section>`;
    }).join('');

    el('slots').querySelectorAll('[data-pick]').forEach(b =>
      b.addEventListener('click', () => preview(b.dataset.slot, b.dataset.pick)));
    el('slots').querySelectorAll('[data-clear]').forEach(b =>
      b.addEventListener('click', () => preview(b.dataset.clear, null)));
  }

  function policyCard(p, activeKey, state) {
    const isActive = p.key === activeKey;

    return `
    <div class="policy ${isActive ? 'active' : ''} ${state.canChange ? '' : 'locked'}"
         id="policy-${p.key}">
      <div class="policy-head">
        <span class="nm">${escapeHtml(p.name)}</span>
        ${isActive ? '<span class="badge active-badge">in force</span>' : ''}
      </div>
      <p class="policy-summary">${escapeHtml(p.summary)}</p>

      <div class="policy-effects">
        ${p.gain.map(e => `<div class="effect pos">${escapeHtml(e.text)}</div>`).join('')}
        ${p.cost.map(e => `<div class="effect neg">${escapeHtml(e.text)}</div>`).join('')}
      </div>

      ${isActive ? '' : `
        <button data-pick="${p.key}" data-slot="${p.slot}"
                ${state.canChange ? '' : 'disabled'}
                title="${state.canChange ? '' : escapeHtml(state.reason || '')}">
          ${state.canChange ? 'Adopt' : `Locked ${state.daysRemaining}d`}
        </button>`}

      <div class="policy-diff hidden" id="diff-${p.key}"></div>
    </div>`;
  }

  // ------------------------------------------------------------------
  // Preview — the diff, before it locks
  // ------------------------------------------------------------------

  async function preview(slot, policyKey) {
    // Close any other open preview in this slot.
    document.querySelectorAll('.policy-diff').forEach(d => {
      if (d.id !== `diff-${policyKey}`) d.classList.add('hidden');
    });

    const box = policyKey ? el(`diff-${policyKey}`) : null;
    if (box) {
      box.classList.remove('hidden');
      box.innerHTML = '<div class="row"><span class="k">calculating…</span></div>';
    }

    try {
      const p = await API.previewPolicy(slot, policyKey);
      previewing[slot] = policyKey;

      const rows = p.changes.length
        ? p.changes.map(c => `
            <div class="row ${c.improved ? '' : 'minus'}">
              <span class="k">${escapeHtml(c.label)}</span>
              <span class="v">${c.delta > 0 ? '+' : ''}${c.delta}${
                c.key.endsWith('Flat') ? '%' : '%'}</span>
            </div>`).join('')
        : '<div class="row"><span class="k">no net change</span><span class="v">—</span></div>';

      const html = `
        ${rows}
        <div class="formula">
          Adopting this locks the ${escapeHtml(slot)} slot for ${p.lockDays} days.
          ${p.from ? `You are replacing ${escapeHtml(nameOf(p.from))}.` : ''}
        </div>
        <button class="primary" style="width:100%; margin-top:.6rem"
                data-confirm="${policyKey || ''}" data-slot="${slot}"
                ${p.canChange ? '' : 'disabled'}>
          ${p.canChange
            ? (policyKey ? 'Adopt this policy' : 'Repeal')
            : `Locked for ${p.daysRemaining} more days`}
        </button>`;

      if (box) {
        box.innerHTML = html;
        box.querySelector('[data-confirm]')?.addEventListener('click', () =>
          commit(slot, policyKey));
      } else {
        // Repeal has no card of its own — confirm inline in the message area.
        showMessage(msg, `Repealing will change: ${p.changes.map(c => c.text).join(', ') || 'nothing'}.`, 'warn');
        if (p.canChange) commit(slot, null);
      }
    } catch (err) {
      showMessage(msg, err.message);
    }
  }

  function nameOf(key) {
    for (const info of Object.values(data.catalogue)) {
      const found = info.policies.find(p => p.key === key);
      if (found) return found.name;
    }
    return key;
  }

  async function commit(slot, policyKey) {
    try {
      clearMessage(msg);
      const r = await API.setPolicy(slot, policyKey);
      showMessage(msg, policyKey
        ? `${r.description.name} adopted. The ${slot} slot is locked for ${r.lockedForDays} days.`
        : `${Fmt.label(slot)} policy repealed.`, 'ok');
      await load();
    } catch (err) {
      showMessage(msg, err.message +
        (err.details.daysRemaining ? ` (${err.details.daysRemaining} days left)` : ''));
    }
  }

  // ------------------------------------------------------------------

  async function load() {
    try {
      const [p, hp] = await Promise.all([API.policies(), API.health()]);
      data = p; health = hp;
      renderCurrent();
      renderSlots();
      startClock();
    } catch (err) {
      showMessage(msg, err.message);
    }
  }

  load();
})();
