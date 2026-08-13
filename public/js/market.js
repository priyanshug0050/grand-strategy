/**
 * ==========================================================================
 *  market.js — the exchange
 * ==========================================================================
 *
 *  WHY THE BOOK IS THE CENTREPIECE
 *  --------------------------------------------------------------------------
 *  A market with no visible depth is a slot machine: you type a price, press
 *  a button, and find out afterwards whether anyone was there. Showing the
 *  resting orders turns it into a decision — you can see that 400 coal sits
 *  at $95 and price accordingly.
 *
 *  COST BEFORE COMMITMENT, AGAIN
 *  --------------------------------------------------------------------------
 *  Same principle as the city preview and the battle odds: before placing an
 *  order the player sees what it would fill at, how much it would actually
 *  cost, and how much would rest unfilled. All of it walks the real book
 *  rather than multiplying quantity by the best price, because a large order
 *  eats several price levels and the naive figure would be a lie.
 * ==========================================================================
 */

(() => {
  'use strict';
  if (!requireLogin()) return;

  const msg = document.getElementById('msg');
  const el = id => document.getElementById(id);

  let state = null, health = null, ref = null;
  let overview = null, book = null;
  let resource = 'coal';
  let side = 'buy';

  el('signOut').addEventListener('click', e => { e.preventDefault(); API.logout(); });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  /** Tiny inline trend line for the overview table. */
  function sparkline(points, direction) {
    if (!points || points.length < 2) return '<span class="muted">—</span>';
    const W = 60, H = 16;
    const min = Math.min(...points), max = Math.max(...points);
    const range = (max - min) || 1;
    const pts = points.map((p, i) =>
      `${((i / (points.length - 1)) * W).toFixed(1)},${(H - ((p - min) / range) * H).toFixed(1)}`).join(' ');
    const stroke = direction === 'down' ? 'var(--alarm)'
                 : direction === 'up' ? 'var(--verdigris)' : 'var(--chalk-dim)';
    return `<svg viewBox="0 0 ${W} ${H}" class="spark"><polyline points="${pts}"
            fill="none" stroke="${stroke}" stroke-width="1.5"/></svg>`;
  }

  function startClock() {
    const t = () => {
      el('clockTurn').textContent = `Turn ${state.turn}`;
      if (!health?.lastTick || !health?.turnIntervalMs) return;
      const remaining = new Date(health.lastTick).getTime() + health.turnIntervalMs - Date.now();
      el('clockUntil').textContent = `next in ${Fmt.duration(remaining)}`;
      el('clock').classList.toggle('imminent', remaining < 60000);
    };
    t(); setInterval(t, 1000);
  }

  // ------------------------------------------------------------------
  // Ticker — what everything is doing, one line
  // ------------------------------------------------------------------

  const ARROW = { up: '\u25B2', down: '\u25BC', flat: '\u2014' };

  function renderTicker() {
    // Only resources that have actually traded. A ticker full of dashes tells
    // the player nothing and buries the two prices that are moving.
    const traded = overview.resources.filter(r => r.tradeCount > 0);

    if (traded.length === 0) {
      el('ticker').innerHTML =
        '<div class="ticker-empty">No trades yet. Place an order to start the market.</div>';
      return;
    }

    el('ticker').innerHTML = traded.map(r => `
      <button class="tick ${r.direction}" data-tick="${r.resource}">
        <span class="nm">${Fmt.label(r.resource)}</span>
        <span class="px num">${Fmt.money(r.current ?? r.medianPrice)}</span>
        <span class="ch num">${ARROW[r.direction]} ${r.changePercent !== null
          ? (r.changePercent > 0 ? '+' : '') + Fmt.dec(r.changePercent, 1) + '%' : '—'}</span>
      </button>`).join('');

    el('ticker').querySelectorAll('[data-tick]').forEach(b =>
      b.addEventListener('click', () => selectResource(b.dataset.tick)));
  }

  // ------------------------------------------------------------------
  // Price chart
  // ------------------------------------------------------------------

  /**
   * Hand-drawn SVG rather than a charting library.
   *
   * A library would be ~200KB for one line and a fill, on a page that already
   * refreshes every 30 seconds. This is 40 lines and matches the rest of the
   * interface exactly — no fighting someone else's default theme.
   */
  function renderChart() {
    const h = book.history || [];

    if (h.length < 2) {
      el('chart').innerHTML = `<p class="empty">
        ${h.length === 0 ? 'No trades yet in ' + Fmt.label(resource) + '.' : 'One trade so far — a chart needs at least two.'}
      </p>`;
      el('chartTitle').textContent = `${Fmt.label(resource)} price`;
      el('chartStats').textContent = '';
      return;
    }

    const W = 600, H = 180, PAD = { t: 12, r: 46, b: 20, l: 8 };
    const plotW = W - PAD.l - PAD.r;
    const plotH = H - PAD.t - PAD.b;

    const highs = h.map(p => p.high);
    const lows = h.map(p => p.low);
    let min = Math.min(...lows);
    let max = Math.max(...highs);

    // A perfectly flat price would divide by zero and draw nothing. Give it
    // artificial headroom so the line renders in the middle.
    if (max === min) { max = min * 1.1 || 1; min = min * 0.9; }
    const range = max - min;
    // Breathing room so the line never touches the edges.
    min -= range * 0.1;
    max += range * 0.1;

    const x = i => PAD.l + (i / (h.length - 1)) * plotW;
    const y = v => PAD.t + plotH - ((v - min) / (max - min)) * plotH;

    const linePts = h.map((p, i) => `${x(i).toFixed(1)},${y(p.close).toFixed(1)}`).join(' ');
    const areaPts = `${PAD.l},${PAD.t + plotH} ${linePts} ${(PAD.l + plotW).toFixed(1)},${PAD.t + plotH}`;

    const rising = h[h.length - 1].close >= h[0].close;
    const stroke = rising ? 'var(--verdigris)' : 'var(--alarm)';

    // Volume bars along the bottom — thin, so they read as context not data.
    const maxVol = Math.max(...h.map(p => p.volume), 1);
    const barW = Math.max(plotW / h.length - 1, 1);
    const bars = h.map((p, i) => {
      const bh = (p.volume / maxVol) * 22;
      return `<rect x="${(x(i) - barW / 2).toFixed(1)}" y="${(PAD.t + plotH - bh).toFixed(1)}"
                    width="${barW.toFixed(1)}" height="${bh.toFixed(1)}"
                    fill="var(--brass)" opacity=".16"/>`;
    }).join('');

    // Gridlines at min / mid / max, labelled on the right.
    const gridVals = [max, (max + min) / 2, min];
    const grid = gridVals.map(v => `
      <line x1="${PAD.l}" y1="${y(v).toFixed(1)}" x2="${(PAD.l + plotW).toFixed(1)}" y2="${y(v).toFixed(1)}"
            stroke="var(--line)" stroke-width="1"/>
      <text x="${(PAD.l + plotW + 6).toFixed(1)}" y="${(y(v) + 3.5).toFixed(1)}"
            fill="var(--chalk-dim)" font-size="9" font-family="ui-monospace, monospace">$${Math.round(v).toLocaleString()}</text>`).join('');

    const lastY = y(h[h.length - 1].close);

    el('chart').innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" class="pricechart" preserveAspectRatio="none">
        ${grid}
        ${bars}
        <polygon points="${areaPts}" fill="${stroke}" opacity=".10"/>
        <polyline points="${linePts}" fill="none" stroke="${stroke}" stroke-width="1.75"
                  stroke-linejoin="round" stroke-linecap="round"/>
        <circle cx="${x(h.length - 1).toFixed(1)}" cy="${lastY.toFixed(1)}" r="3" fill="${stroke}"/>
        <line x1="${PAD.l}" y1="${lastY.toFixed(1)}" x2="${(PAD.l + plotW).toFixed(1)}" y2="${lastY.toFixed(1)}"
              stroke="${stroke}" stroke-width="1" stroke-dasharray="2 3" opacity=".5"/>
      </svg>
      <div class="chart-axis">
        <span>turn ${h[0].turn}</span>
        <span>${h.length} turns · ${h.reduce((n,p)=>n+p.trades,0)} trades</span>
        <span>turn ${h[h.length - 1].turn}</span>
      </div>`;

    const st = book.stats || {};
    el('chartTitle').innerHTML = `${Fmt.label(resource)}
      <span class="chg ${book.direction}">${ARROW[book.direction]} ${book.changePercent !== null
        ? (book.changePercent > 0 ? '+' : '') + Fmt.dec(book.changePercent, 1) + '%' : ''}</span>`;
    el('chartStats').textContent = st.high !== null
      ? `high ${Fmt.money(st.high)} · low ${Fmt.money(st.low)} · vol ${Fmt.dec(st.volume, 0)} · avg ${Fmt.money(st.averagePrice)}`
      : '';
  }

  // ------------------------------------------------------------------
  // Overview — every resource, one row each
  // ------------------------------------------------------------------

  function renderOverview() {
    const sp = state.nation.stockpile;
    const flow = state.revenue.resourcesPerTurn;

    el('overview').innerHTML = `
      <table class="market-overview">
        <thead>
          <tr><th>Resource</th><th>You hold</th><th>Per turn</th><th>Bid</th><th>Ask</th><th>Last</th><th>Change</th><th>Trend</th><th></th></tr>
        </thead>
        <tbody>
        ${overview.resources.map(r => {
          const held = sp[r.resource] || 0;
          const delta = flow[r.resource] || 0;
          const deltaCls = delta > 0.0001 ? 'pos' : delta < -0.0001 ? 'neg' : '';
          return `
            <tr class="${r.resource === resource ? 'selected' : ''}" data-res="${r.resource}">
              <td class="res-name">${Fmt.label(r.resource)}</td>
              <td class="num">${Fmt.dec(held, held < 100 ? 1 : 0)}</td>
              <td class="num ${deltaCls}">${Fmt.signed(delta)}</td>
              <td class="num bid">${r.bid !== null ? Fmt.money(r.bid) : '—'}</td>
              <td class="num ask">${r.ask !== null ? Fmt.money(r.ask) : '—'}</td>
              <td class="num">${r.current !== null && r.current !== undefined ? Fmt.money(r.current)
                : r.medianPrice !== null ? Fmt.money(r.medianPrice) : '—'}</td>
              <td class="num chg ${r.direction || 'flat'}">${r.changePercent !== null && r.changePercent !== undefined
                ? ARROW[r.direction] + ' ' + (r.changePercent > 0 ? '+' : '') + Fmt.dec(r.changePercent,1) + '%' : '—'}</td>
              <td class="spark-cell">${sparkline(r.spark, r.direction)}</td>
              <td><button data-open="${r.resource}">Trade</button></td>
            </tr>`;
        }).join('')}
        </tbody>
      </table>`;

    el('overview').querySelectorAll('[data-open]').forEach(b =>
      b.addEventListener('click', () => selectResource(b.dataset.open)));
  }

  async function selectResource(res) {
    resource = res;
    el('orderResource').value = res;
    await loadBook();
    renderOverview();
  }

  // ------------------------------------------------------------------
  // The book
  // ------------------------------------------------------------------

  function renderBook() {
    renderChart();
    el('bookTitle').textContent = `${Fmt.label(resource)} order book`;

    el('spreadLine').textContent = book.spread !== null
      ? `spread ${Fmt.money(book.spread)} (${Fmt.dec(book.spreadPercent,1)}%)`
      : book.ask !== null ? 'no bids' : book.bid !== null ? 'no asks' : 'empty book';

    const maxQty = Math.max(
      ...book.bids.map(b => b.quantity),
      ...book.asks.map(a => a.quantity), 1);

    const level = (o, kind) => `
      <div class="level ${kind}" data-price="${o.price}">
        <div class="depth" style="width:${(o.quantity / maxQty) * 100}%"></div>
        <span class="p num">${Fmt.money(o.price)}</span>
        <span class="q num">${Fmt.dec(o.quantity, 1)}</span>
        <span class="v num muted">${Fmt.money(o.value)}</span>
      </div>`;

    // Asks descend to the spread, bids descend from it — the classic layout,
    // so the gap between the two sides IS the spread, visually.
    el('book').innerHTML = `
      <div class="book-head">
        <span>price</span><span>quantity</span><span>value</span>
      </div>
      <div class="asks">
        ${book.asks.length
          ? [...book.asks].reverse().map(a => level(a, 'ask')).join('')
          : '<p class="empty" style="padding:.6rem">Nobody is selling.</p>'}
      </div>
      <div class="mid">
        ${book.medianPrice !== null
          ? `recent median ${Fmt.money(book.medianPrice)}`
          : 'no trades yet'}
      </div>
      <div class="bids">
        ${book.bids.length
          ? book.bids.map(b => level(b, 'bid')).join('')
          : '<p class="empty" style="padding:.6rem">Nobody is buying.</p>'}
      </div>`;

    // Clicking a level fills the price in — the most common action by far.
    el('book').querySelectorAll('[data-price]').forEach(row =>
      row.addEventListener('click', () => {
        el('orderPrice').value = row.dataset.price;
        preview();
      }));

    renderTrades();
    renderMyOrders();
  }

  function renderTrades() {
    if (!book.recentTrades?.length) {
      el('trades').innerHTML = '<p class="empty">No trades yet in this resource.</p>';
      return;
    }
    el('trades').innerHTML = `
      <table class="trades">
        <thead><tr><th>Price</th><th>Quantity</th><th>Value</th><th>When</th></tr></thead>
        <tbody>
        ${book.recentTrades.slice(0, 12).map(t => `
          <tr class="${t.flagged ? 'flagged' : ''}">
            <td class="num">${Fmt.money(t.price)}</td>
            <td class="num">${Fmt.dec(t.quantity,1)}</td>
            <td class="num">${Fmt.money(t.price * t.quantity)}</td>
            <td class="num muted">T${t.turn}</td>
          </tr>`).join('')}
        </tbody>
      </table>
      ${book.recentTrades.some(t => t.flagged)
        ? '<p class="muted" style="font-size:.7rem; margin-top:.6rem">Rows marked in red traded far from the median and are flagged for review.</p>'
        : ''}`;
  }

  function renderMyOrders() {
    const mine = book.myOrders || [];
    el('myOrderCount').textContent = mine.length ? `${mine.length} open` : '';

    if (!mine.length) {
      el('myOrders').innerHTML = '<p class="empty">No open orders in this resource.</p>';
      return;
    }

    el('myOrders').innerHTML = mine.map(o => {
      const open = o.quantity - o.filled;
      const pct = (o.filled / o.quantity) * 100;
      return `
        <div class="myorder ${o.side}">
          <div class="myorder-head">
            <span class="side">${o.side.toUpperCase()}</span>
            <span class="num">${Fmt.dec(open,1)} @ ${Fmt.money(o.price)}</span>
            <button data-cancel="${o.id}">Cancel</button>
          </div>
          ${o.filled > 0 ? `
            <div class="fillbar"><div class="fill" style="width:${pct}%"></div></div>
            <div class="muted num" style="font-size:.66rem">${Fmt.dec(o.filled,1)} of ${Fmt.dec(o.quantity,1)} filled</div>
          ` : ''}
        </div>`;
    }).join('');

    el('myOrders').querySelectorAll('[data-cancel]').forEach(b =>
      b.addEventListener('click', () => cancelOrder(Number(b.dataset.cancel))));
  }

  // ------------------------------------------------------------------
  // Order preview — walks the real book
  // ------------------------------------------------------------------

  function preview() {
    const price = Number(el('orderPrice').value);
    const qty = Number(el('orderQty').value);

    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(qty) || qty <= 0) {
      el('orderPreview').innerHTML =
        `<div class="row"><span class="k">enter a price and quantity</span><span class="v">—</span></div>`;
      return;
    }

    // Walk the opposite side of the book, taking only levels that cross.
    const opposite = side === 'buy' ? book.asks : book.bids;
    let remaining = qty, cost = 0, filledQty = 0, worst = null;

    for (const lvl of opposite) {
      if (remaining <= 0) break;
      const crosses = side === 'buy' ? price >= lvl.price : price <= lvl.price;
      if (!crosses) break;
      const take = Math.min(remaining, lvl.quantity);
      cost += take * lvl.price;
      worst = lvl.price;
      filledQty += take;
      remaining -= take;
    }

    const restingQty = remaining;
    const restingValue = side === 'buy' ? restingQty * price : 0;
    const avg = filledQty > 0 ? cost / filledQty : null;

    const sp = state.nation.stockpile;
    const held = sp[resource] || 0;
    const money = state.nation.money;

    const totalNeeded = side === 'buy' ? cost + restingValue : 0;
    const affordable = side === 'buy' ? money >= totalNeeded : held >= qty;

    const rows = [];
    if (filledQty > 0) {
      rows.push({ k: `fills now`, v: `${Fmt.dec(filledQty,1)} @ avg ${Fmt.money(avg)}` });
      rows.push({ k: side === 'buy' ? 'costs' : 'earns', v: Fmt.money(cost) });
    }
    if (restingQty > 0) {
      rows.push({ k: 'rests on the book', v: `${Fmt.dec(restingQty,1)} @ ${Fmt.money(price)}` });
      if (side === 'buy') rows.push({ k: 'escrowed', v: Fmt.money(restingValue) });
    }

    el('orderPreview').innerHTML = `
      ${rows.map(r => `<div class="row"><span class="k">${r.k}</span><span class="v">${r.v}</span></div>`).join('')}
      <div class="rule"></div>
      <div class="row total">
        <span class="k">${side === 'buy' ? 'total outlay' : 'goods committed'}</span>
        <span class="v">${side === 'buy' ? Fmt.money(totalNeeded) : Fmt.dec(qty,1) + ' ' + resource}</span>
      </div>
      ${!affordable ? `<div class="row minus"><span class="k">${side === 'buy' ? 'short by' : 'you only hold'}</span>
        <span class="v">${side === 'buy' ? Fmt.money(totalNeeded - money) : Fmt.dec(held,1)}</span></div>` : ''}

      ${filledQty === 0 && restingQty > 0 ? `<div class="formula">
        Nothing crosses at this price, so the whole order rests on the book until
        someone meets it.${side === 'buy' && book.ask !== null
          ? ` The cheapest seller is at ${Fmt.money(book.ask)}.`
          : side === 'sell' && book.bid !== null
          ? ` The best bidder is at ${Fmt.money(book.bid)}.` : ''}
      </div>` : ''}

      ${book.medianPrice !== null && Math.abs(price - book.medianPrice) / book.medianPrice > 0.35 ? `
        <div class="formula" style="color:var(--phosphor)">
          This is far from the recent median of ${Fmt.money(book.medianPrice)}. Trades that
          deviate this much get flagged for review.
        </div>` : ''}

      ${side === 'buy' && filledQty > 0 && price > (worst || 0) ? `
        <div class="formula">
          You bid ${Fmt.money(price)} but pay the resting price — the seller's number,
          not yours. Bidding high guarantees a fill without overpaying.
        </div>` : ''}`;

    el('placeBtn').disabled = !affordable;
    el('placeBtn').textContent = affordable
      ? `Place ${side} order`
      : side === 'buy' ? 'Not enough money' : `Not enough ${resource}`;
  }

  // ------------------------------------------------------------------
  // Actions
  // ------------------------------------------------------------------

  async function placeOrder() {
    const price = Number(el('orderPrice').value);
    const quantity = Number(el('orderQty').value);
    const btn = el('placeBtn');

    btn.disabled = true; btn.textContent = 'Placing…';
    try {
      clearMessage(msg);
      const r = await API.placeOrder(resource, side, price, quantity);

      let text;
      if (r.filled > 0 && r.remaining > 0) {
        text = `Filled ${Fmt.dec(r.filled,1)} at an average of ${Fmt.money(r.averagePrice)}. ${Fmt.dec(r.remaining,1)} resting on the book.`;
      } else if (r.filled > 0) {
        text = `Filled ${Fmt.dec(r.filled,1)} at an average of ${Fmt.money(r.averagePrice)}` +
               (side === 'buy' ? ` for ${Fmt.money(r.spent)}.` : ` for ${Fmt.money(r.received)}.`);
      } else {
        text = `Order placed. ${Fmt.dec(r.remaining,1)} resting at ${Fmt.money(price)} — nothing crossed yet.`;
      }
      showMessage(msg, text, 'ok');
      await load();
    } catch (err) {
      showMessage(msg, err.message);
      btn.disabled = false;
    }
  }

  async function cancelOrder(orderId) {
    try {
      clearMessage(msg);
      const r = await API.cancelOrder(orderId);
      showMessage(msg, 'Order cancelled — escrow returned.', 'ok');
      await load();
    } catch (err) {
      showMessage(msg, err.message);
    }
  }

  function setSide(s) {
    side = s;
    el('sideBuy').classList.toggle('active', s === 'buy');
    el('sideSell').classList.toggle('active', s === 'sell');
    // Default to the price that would actually fill.
    const suggested = s === 'buy' ? book?.ask : book?.bid;
    if (suggested && !el('orderPrice').value) el('orderPrice').value = suggested;
    preview();
  }

  // ------------------------------------------------------------------

  async function loadBook() {
    book = await API.marketBook(resource);
    renderBook();
    preview();
  }

  async function load() {
    try {
      const [nation, hp, ov] = await Promise.all([API.nation(), API.health(), API.market()]);
      state = nation; health = hp; overview = ov;
      if (!ref) ref = await API.reference();

      el('treasuryLine').textContent = Fmt.money(state.nation.money);

      if (!el('orderResource').options.length) {
        el('orderResource').innerHTML = overview.resources
          .map(r => `<option value="${r.resource}">${Fmt.label(r.resource)}</option>`).join('');
        el('orderResource').value = resource;
      }

      await loadBook();
      renderTicker();
      renderOverview();
      startClock();
    } catch (err) {
      showMessage(msg, err.message);
    }
  }

  el('sideBuy').addEventListener('click', () => setSide('buy'));
  el('sideSell').addEventListener('click', () => setSide('sell'));
  el('orderResource').addEventListener('change', () => selectResource(el('orderResource').value));
  el('orderPrice').addEventListener('input', preview);
  el('orderQty').addEventListener('input', preview);
  el('placeBtn').addEventListener('click', placeOrder);

  load();
  setInterval(load, 30000);   // the book moves without you
})();
