/**
 * ==========================================================================
 *  rankings.js
 * ==========================================================================
 *
 *  PUBLIC PAGE. This is the one game page that must work signed out — it is
 *  linked from the landing page and it is what a stranger looks at before
 *  deciding whether the world is worth joining. So it never calls
 *  requireLogin(); it degrades instead.
 *
 *  Signed in, it answers the question players actually have when they open a
 *  rankings table: not "who is biggest" but "who can I hit, and who can hit
 *  me". Both bands are computed from the same war-range constants the server
 *  enforces, so the colouring cannot disagree with the declaration check.
 * ==========================================================================
 */

(() => {
  'use strict';

  const el = id => document.getElementById(id);
  const msg = el('msg');

  let data = null;        // { turn, total, nations }
  let me = null;          // my snapshot, when signed in
  let health = null;

  const loggedIn = API.isLoggedIn();

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  // ------------------------------------------------------------------
  // Navigation differs signed in vs signed out
  // ------------------------------------------------------------------

  function renderNav() {
    const nav = el('mainNav');
    if (loggedIn) {
      nav.innerHTML = `
        <a href="/dashboard.html">Situation</a>
        <a href="/cities.html">Cities</a>
        <a href="/economy.html">Economy</a>
        <a href="/policy.html">Policy</a>
        <a href="/projects.html">Projects</a>
        <a href="/market.html">Market</a>
        <a href="/military.html">Military</a>
        <a href="/espionage.html">Espionage</a>
        <a href="/history.html">History</a>
        <a href="/rankings.html" aria-current="page">Rankings</a>
        <a href="/wiki/">Wiki</a>
        <a href="#" id="signOut">Sign out</a>`;
      el('signOut').addEventListener('click', e => { e.preventDefault(); API.logout(); });
    } else {
      nav.innerHTML = `
        <a href="/">Home</a>
        <a href="/wiki/">Wiki</a>
        <a href="/rankings.html" aria-current="page">Rankings</a>
        <a href="/login.html">Play free</a>`;
    }
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
  // War range — the reason anyone reads this table
  // ------------------------------------------------------------------

  /**
   * Both bands come straight off the snapshot — the server already computed
   * them with the same functions the declaration check uses. Recomputing them
   * here from multipliers would be a second source of truth, and the moment
   * the constants changed the colouring would quietly start lying.
   */
  function myRange() {
    if (!me?.warRange || !me?.vulnerableTo) return null;
    return {
      score: me.score,
      canAttackMin: me.warRange.min,
      canAttackMax: me.warRange.max,
      hitByMin: me.vulnerableTo.min,
      hitByMax: me.vulnerableTo.max,
    };
  }

  /** '' | 'target' | 'threat' | 'both' | 'me' */
  function relation(n, range) {
    if (!range) return '';
    if (me && n.id === me.id) return 'me';
    const target = n.score >= range.canAttackMin && n.score <= range.canAttackMax;
    const threat = n.score >= range.hitByMin && n.score <= range.hitByMax;
    if (target && threat) return 'both';
    if (target) return 'target';
    if (threat) return 'threat';
    return '';
  }

  const RELATION_TAG = {
    me:     '<span class="tag">you</span>',
    both:   '<span class="tag" title="You can declare on them and they can declare on you">mutual</span>',
    target: '<span class="tag" title="Inside your war range">can attack</span>',
    threat: '<span class="tag" title="You are inside their war range">can hit you</span>',
    '':     '',
  };

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  function renderMe() {
    if (!me) return;
    const range = myRange();
    const mine = data.nations.find(n => n.id === me.id);
    el('mePanel').classList.remove('hidden');
    el('meRank').textContent = mine ? `rank ${mine.rank} of ${data.total}` : 'unranked';

    const inRange = range
      ? data.nations.filter(n => n.id !== me.id && relation(n, range) !== '').length
      : 0;

    el('meBody').innerHTML = `
      <table class="ledger-table">
        <tbody>
          <tr><td data-label="Metric">Score</td><td data-label="Value" class="num">${Fmt.dec(me.score, 2)}</td></tr>
          ${range ? `
          <tr><td data-label="Metric">You can declare on</td>
              <td data-label="Value" class="num">${Fmt.dec(range.canAttackMin, 1)} — ${Fmt.dec(range.canAttackMax, 1)}</td></tr>
          <tr><td data-label="Metric">You can be declared on by</td>
              <td data-label="Value" class="num">${Fmt.dec(range.hitByMin, 1)} — ${Fmt.dec(range.hitByMax, 1)}</td></tr>
          <tr><td data-label="Metric">Nations in one range or the other</td>
              <td data-label="Value" class="num">${inRange}</td></tr>` : ''}
        </tbody>
      </table>
      <p class="muted" style="font-size:.72rem; margin-top:.6rem; line-height:1.5;">
        The range is asymmetric on purpose — you can always be reached by someone
        bigger than you, never by someone overwhelmingly bigger.
        <a href="/wiki/war.html#range">How war range works</a>
      </p>`;
  }

  function renderTable() {
    const sortBy = el('sortBy').value;
    const onlyRange = el('onlyRange').checked;
    const range = myRange();

    let rows = data.nations.slice();
    if (onlyRange && range) {
      rows = rows.filter(n => {
        const r = relation(n, range);
        return r === 'target' || r === 'both';
      });
    }
    rows.sort((a, b) => b[sortBy] - a[sortBy]);

    if (rows.length === 0) {
      el('table').innerHTML = `<p class="empty">${
        onlyRange ? 'No nation is currently inside your war range.'
                  : 'No nations yet. The world is empty.'}</p>`;
      return;
    }

    el('table').innerHTML = `
      <table class="rankings">
        <thead>
          <tr>
            <th>#</th><th>Nation</th><th>Score</th><th>Cities</th>
            <th>Infrastructure</th><th>Land</th><th>Projects</th><th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(n => {
            const rel = relation(n, range);
            return `<tr class="${rel === 'me' ? 'myorder' : ''}">
              <td data-label="#" class="num">${n.rank}</td>
              <td data-label="Nation">${escapeHtml(n.name)} ${RELATION_TAG[rel] || ''}</td>
              <td data-label="Score" class="num">${Fmt.dec(n.score, 2)}</td>
              <td data-label="Cities" class="num">${Fmt.int(n.cities)}</td>
              <td data-label="Infrastructure" class="num">${Fmt.int(n.infrastructure)}</td>
              <td data-label="Land" class="num">${Fmt.int(n.land)}</td>
              <td data-label="Projects" class="num">${Fmt.int(n.projects)}</td>
              <td data-label="Status">${n.onBeige
                ? '<span class="tag" title="Protected from new war declarations">beige</span>'
                : '<span class="muted">—</span>'}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;
  }

  function render() {
    el('counts').textContent = `${data.total} nation${data.total === 1 ? '' : 's'}`;
    renderMe();
    renderTable();
  }

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------

  el('sortBy').addEventListener('change', renderTable);
  el('onlyRange').addEventListener('change', renderTable);

  (async () => {
    renderNav();
    try {
      [data, health] = await Promise.all([
        API.rankings(250),
        API.health().catch(() => null),
      ]);

      if (loggedIn) {
        try {
          const snap = await API.nation();
          me = {
            id: snap.nation.id,
            score: snap.score,
            warRange: snap.warRange,
            vulnerableTo: snap.vulnerableTo,
          };
        } catch {
          // An expired token must not take the public table down with it.
          me = null;
        }
      }

      render();
      startClock();
    } catch (err) {
      showMessage(msg, err.message);
    }
  })();
})();
