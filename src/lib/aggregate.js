/**
 * Pure aggregation — raw Supabase rows in, UI-shaped data out.
 *
 * Deliberately imports nothing. That keeps it runnable under plain Node
 * (see tests/aggregate.test.mjs), which is what makes the date-bucketing
 * testable at all — it's the part most likely to be subtly wrong and the
 * least likely to look wrong on screen.
 *
 * A deliberate rule: this file does NOT recompute the replenishment
 * formula. That lives in Python (takealot/replenishment.py) and its result
 * arrives in offers_cache.send_in_*. Two implementations would drift.
 */

// Takealot reports in South African time. The sync stores proper
// timestamptz values, but every bucket boundary the dashboard shows
// ("Today", "Yesterday") has to be a SAST boundary, not the viewer's —
// otherwise a seller checking the app from a different timezone, or a
// browser set to UTC, sees the day roll over at the wrong moment.
export const SAST_OFFSET_MS = 2 * 60 * 60 * 1000;

/** Midnight SAST for the day `daysAgo` days back, as a real Date. */
export function sastDayStart(daysAgo = 0, now = Date.now()) {
  const shifted = new Date(now + SAST_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - SAST_OFFSET_MS - daysAgo * 86400000);
}

/** Map a Takealot status string onto the Orders screen's status keys. */
export function orderStatusKey(status) {
  const s = (status || "").toLowerCase();
  if (s.includes("cancel") || s.includes("return")) return "cancelled";
  if (s.includes("ship")) return "shipped";
  if (s.includes("lead")) return "leadtime";
  return "preparing";
}

/** Map a Takealot offer status onto the Offers screen's status keys. */
export function offerStatusKey(status) {
  const s = (status || "").toLowerCase();
  if (s.includes("disabled")) return "disabled";
  if (s.includes("not")) return "notbuyable";
  return "buyable";
}

const num = (v) => (typeof v === "number" && isFinite(v) ? v : 0);

/**
 * Annotates raw sales rows in place with a parsed date and a "counts"
 * flag. Done once so the four builders below don't each re-parse dates.
 */
/** Takealot's cut on a line: the four fee components added up. */
export function feesOf(sale) {
  return (
    num(sale.success_fee) +
    num(sale.fulfilment_fee) +
    num(sale.courier_fee) +
    num(sale.stock_transfer_fee)
  );
}

export function prepareSales(rawSales) {
  for (const s of rawSales) {
    const t = s.order_date ? new Date(s.order_date) : null;
    s._date = t && !isNaN(t.getTime()) ? t : null;
    s._counts = s.counts_toward_velocity !== false;
    s._fees = feesOf(s);
    // The value of this line. `line_total` is what Takealot reports;
    // `unit_price` is derived from it as line_total / quantity.
    //
    // The fallback multiplies, because post-migration-007 every row has a
    // genuinely per-unit unit_price. An earlier version fell back to a
    // bare unit_price — correct only for pre-007 rows, which no longer
    // exist — and that silently under-counted every multi-unit order when
    // a caller forgot to SELECT line_total. Quietly wrong beats loudly
    // broken only if you never ship it.
    s._value = s.line_total != null
      ? num(s.line_total)
      : num(s.unit_price) * (num(s.quantity) || 1);
  }
  return rawSales;
}

/**
 * Start of the ISO week (Monday 00:00 SAST) `weeksAgo` weeks back.
 */
export function sastWeekStart(weeksAgo = 0, now = Date.now()) {
  const shifted = new Date(now + SAST_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  // getUTCDay(): 0=Sun … 6=Sat. Days elapsed since Monday:
  const sinceMonday = (shifted.getUTCDay() + 6) % 7;
  shifted.setUTCDate(shifted.getUTCDate() - sinceMonday - weeksAgo * 7);
  return new Date(shifted.getTime() - SAST_OFFSET_MS);
}

/**
 * Start of the calendar month (1st 00:00 SAST) `monthsAgo` months back.
 */
export function sastMonthStart(monthsAgo = 0, now = Date.now()) {
  const shifted = new Date(now + SAST_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  // Set the day before the month, or 31 Mar minus one month lands in
  // March again.
  shifted.setUTCDate(1);
  shifted.setUTCMonth(shifted.getUTCMonth() - monthsAgo);
  return new Date(shifted.getTime() - SAST_OFFSET_MS);
}

const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

/**
 * The fee rate Takealot actually charges, measured across every settled
 * sale given. Used as a fallback when a window has no settled orders of
 * its own to learn from — a brand-new trading day, for instance, where
 * everything is still "Preparing".
 */
export function observedFeeRate(sales) {
  let value = 0;
  let fees = 0;
  for (const s of sales) {
    if (!s._counts || !(s._fees > 0)) continue;
    value += s._value;
    fees += s._fees;
  }
  return value > 0 ? fees / value : 0;
}

/**
 * Totals for one time window. Everything the breakdown table shows for a
 * single row, including the payout waterfall behind it.
 *
 * `coverageStart` is where the synced data actually begins. Takealot's
 * /sales endpoint only exposes a rolling 30 days, so any window reaching
 * further back is genuinely incomplete and gets flagged `partial` rather
 * than quietly under-reporting.
 */
function computeWindow(sales, w, coverageStart, costsBySku, fallbackRate) {
  let qty = 0;
  let value = 0;
  let placedQty = 0;
  let returnedQty = 0;
  let returnedValue = 0;
  let preparingQty = 0;
  let preparingValue = 0;
  let shippedQty = 0;
  let shippedValue = 0;
  let shippedFees = 0;
  let shippedCost = 0;
  let preparingCost = 0;

  for (const s of sales) {
    if (!s._date) continue;
    if (s._date < w.from) continue;
    if (w.to && s._date >= w.to) continue;

    placedQty += num(s.quantity);

    if (!s._counts) {
      returnedQty += num(s.quantity);
      returnedValue += s._value;
      continue; // never sold: no units, no value, no fees, no cost
    }

    qty += num(s.quantity);
    value += s._value;

    // The table shows these two side by side as separate groups, so they
    // must not overlap: preparing + shipped === qty. `qty` stays the
    // total, because Sales Value, average order value and the hero are
    // all computed against every unit sold, dispatched or not.
    const unitCost = num(costsBySku.get(s.sku)?.cost_incl_vat) * num(s.quantity);

    if (orderStatusKey(s.status) === "shipped") {
      shippedQty += num(s.quantity);
      shippedValue += s._value;
      // Fees are only ever charged on dispatch, so these are actual
      // amounts — nothing here is estimated.
      shippedFees += s._fees;
      shippedCost += unitCost;
    } else {
      preparingQty += num(s.quantity);
      preparingValue += s._value;
      preparingCost += unitCost;
    }
  }

  // Rate actually charged on this window's shipped orders. Used only to
  // hint at what the undispatched portion will cost once it ships — it
  // does NOT feed payout or profit, which are strictly what has shipped.
  const feeRate = shippedValue > 0 ? shippedFees / shippedValue : fallbackRate;

  // Round components first, then derive totals from the rounded figures,
  // or the displayed waterfall misses by a rand.
  const rValue = Math.round(value);
  const rReturned = Math.round(returnedValue);
  const rPlaced = rValue + rReturned;
  const rShippedValue = Math.round(shippedValue);
  const rFeesCharged = Math.round(shippedFees);
  const rCost = Math.round(shippedCost);
  const rPreparingValue = Math.round(preparingValue);

  // Money in the bank and gross profit count ONLY units already shipped,
  // at fees Takealot has actually charged — nothing estimated. Sales
  // Value above still covers everything sold, so the two deliberately do
  // not tie; `pendingFeeValue` is the difference.
  const rPayout = rShippedValue - rFeesCharged;

  return {
    label: w.label,
    short: w.short,
    qty,
    value: rValue,
    preparingQty,
    preparingValue: rPreparingValue,
    shippedQty,
    shippedValue: rShippedValue,
    placedQty,
    placedValue: rPlaced,
    returnedQty,
    returnedValue: rReturned,
    netSales: rValue,
    fees: rFeesCharged,
    feesCharged: rFeesCharged,
    payout: rPayout,
    cost: rCost,
    profit: rPayout - rCost,
    // Context for the gap between Sales Value and the banked figures.
    preparingCost: Math.round(preparingCost),
    feesExpected: Math.round(preparingValue * feeRate),
    estimatedPendingFees: Math.round(preparingValue * feeRate),
    feesPending: preparingValue > 0,
    pendingFeeValue: rPreparingValue,
    feeRate,
    partial: coverageStart ? w.from < coverageStart : true,
  };
}

/**
 * The dashboard breakdown table: Today, Yesterday, Last Week, Last Month.
 *
 * "Last Week" and "Last Month" are the previous COMPLETE calendar periods
 * (Mon–Sun, and the previous month), not rolling windows. Each carries a
 * `companion` — the same period in progress right now — which the
 * expanded row shows so a finished period can be read against the
 * current one.
 */
export function buildRows(sales, now = Date.now(), coverageStart = null, costsBySku = new Map()) {
  // Orders arrive as "Preparing for Customer" and become "Shipped to
  // Customer" within a day or two; Takealot only charges its fees at that
  // point. Fees on unshipped orders are therefore estimated at the rate
  // this store is actually charged, or every morning's profit would look
  // inflated and shrink through the day.
  const fallbackRate = observedFeeRate(sales);

  const lastMonthStart = sastMonthStart(1, now);
  const thisMonthStart = sastMonthStart(0, now);
  const monthName = (d) => MONTHS[new Date(d.getTime() + SAST_OFFSET_MS).getUTCMonth()];

  const windows = [
    { label: "Today", short: "Today", from: sastDayStart(0, now), to: null },
    { label: "Yesterday", short: "Yesterday", from: sastDayStart(1, now), to: sastDayStart(0, now) },
    {
      label: "Last week", short: "Last week",
      from: sastWeekStart(1, now), to: sastWeekStart(0, now),
      companion: { label: "This week so far", short: "This week", from: sastWeekStart(0, now), to: null },
    },
    {
      label: `Last month · ${monthName(lastMonthStart)}`, short: monthName(lastMonthStart),
      from: lastMonthStart, to: thisMonthStart,
      companion: {
        label: `This month so far · ${monthName(thisMonthStart)}`, short: monthName(thisMonthStart),
        from: thisMonthStart, to: null,
      },
    },
  ];

  return windows.map((w) => {
    const row = computeWindow(sales, w, coverageStart, costsBySku, fallbackRate);
    if (w.companion) {
      row.companion = computeWindow(sales, w.companion, coverageStart, costsBySku, fallbackRate);
    }
    return row;
  });
}

/**
 * Sparkline buckets. heroChart() turns these into a cumulative curve
 * scaled to the period total, so only the shape matters, not the count.
 */
export function buildSeries(sales, now = Date.now()) {
  const bucket = (from, count, sizeMs) => {
    const out = new Array(count).fill(0);
    for (const s of sales) {
      // Same exclusion as buildRows — the chart and the table must agree,
      // and there is a test asserting exactly that.
      if (!s._date || !s._counts) continue;
      const offset = s._date.getTime() - from.getTime();
      if (offset < 0) continue;
      const i = Math.min(count - 1, Math.floor(offset / sizeMs));
      out[i] += s._value;
    }
    return out.map((v) => Math.round(v));
  };

  // Calendar-aligned, matching the hero's "Today / This week / This
  // month" segments. A rolling 7-day series under a "This week" label
  // would quietly disagree with the table beneath it.
  const monthStart = sastMonthStart(0, now);
  const nextMonth = sastMonthStart(-1, now);
  const daysInMonth = Math.max(
    1, Math.round((nextMonth.getTime() - monthStart.getTime()) / 86400000)
  );

  return {
    today: bucket(sastDayStart(0, now), 24, 3600000),
    week: bucket(sastWeekStart(0, now), 7, 86400000),
    month: bucket(monthStart, daysInMonth, 86400000),
  };
}

/** Orders list, newest first. Shaped like the old ORDERS sample array. */
export function buildOrders(sales, costsBySku) {
  return sales
    .filter((s) => s._date)
    .slice()
    .sort((a, b) => b._date - a._date)
    .map((s) => {
      const cost = costsBySku.get(s.sku);
      // Rendered in SAST so timestamps match the Takealot seller portal.
      const sast = new Date(s._date.getTime() + SAST_OFFSET_MS);
      const dd = String(sast.getUTCDate()).padStart(2, "0");
      const mon = sast.toLocaleString("en-ZA", { month: "short", timeZone: "UTC" });
      const hh = String(sast.getUTCHours()).padStart(2, "0");
      const mm = String(sast.getUTCMinutes()).padStart(2, "0");

      return {
        // The order number a customer or Takealot support would quote is
        // order_id; order_item_id identifies the line within it.
        id: s.order_id ?? s.order_item_id,
        orderItemId: s.order_item_id,
        date: `${dd} ${mon}`,
        time: `${hh}:${mm}`,
        // product_title comes straight from the API, so a SKU with no
        // sku_costs row still shows a real name rather than a bare code.
        title: s.product_title || cost?.title || s.sku || "Unknown product",
        // Genuinely per-unit, so the list's `unit * qty` reproduces the
        // line total Takealot reports.
        unit: num(s.unit_price),
        lineTotal: s._value,
        qty: num(s.quantity) || 1,
        status: orderStatusKey(s.status),
        rawStatus: s.status,
        sku: s.sku,
        tsin: s.tsin ?? "—",
        offerId: s.offer_id ?? "—",
        customer: s.customer_name || "—",
        orderDC: s.order_dc || s.customer_dc || "—",
        customerDC: s.customer_dc || "—",
        productCost: num(cost?.cost_incl_vat),
        deliveryCost: 0,
        // Takealot only populates fees once an order ships — exactly the
        // "Fees Pending" state the detail view already draws.
        fees: {
          success: num(s.success_fee),
          fulfillment: num(s.fulfilment_fee),
          courier: num(s.courier_fee),
          stockTransfer: num(s.stock_transfer_fee),
        },
      };
    });
}

/** Offers list. Shaped like the old OFFERS sample array. */
export function buildOffers(offers) {
  return offers.map((o) => ({
    title: o.title || o.sku,
    sku: o.sku,
    barcode: o.barcode || "—",
    label: o.label || "—",
    price: num(o.price),
    rrp: num(o.rrp),
    status: offerStatusKey(o.status),
    rawStatus: o.status,
    tsin: o.tsin ?? "—",
    offerId: o.offer_id ?? "—",
    offerUrl: o.offer_url || null,
    imageUrl: o.image_url || null,
    // The Offers screen labels this "Warehouse ID"; the offer_id is the
    // identifier Takealot actually exposes and the one that's useful.
    warehouseId: o.offer_id ?? "—",
    created: o.date_created ? String(o.date_created).slice(0, 16).replace("T", " ") : "—",
    // leadtime_days is null on offers with no lead-time arrangement,
    // which is what the screen means by "Disabled".
    leadTime: o.leadtime_days ? `${o.leadtime_days} days` : "Disabled",
    storageEligible: o.storage_fee_eligible === true,
    // [stock, 30-day sales] per DC — the tuple shape offerStats() expects.
    dcs: {
      CPT: [num(o.stock_cpt), num(o.sales_30d_cpt)],
      JHB: [num(o.stock_jhb), num(o.sales_30d_jhb)],
      DBN: [num(o.stock_dbn), num(o.sales_30d_dbn)],
    },
    onWay: { CPT: num(o.on_way_cpt), JHB: num(o.on_way_jhb), DBN: num(o.on_way_dbn) },
    // Straight from Python — the canonical payday-aware formula.
    sendIn: { CPT: num(o.send_in_cpt), JHB: num(o.send_in_jhb), DBN: num(o.send_in_dbn) },
    trendFactor: o.trend_factor ?? 1,
    syncedAt: o.synced_at || null,
  }));
}

/** Report definitions built from live data, replacing the REPORT_DEFS sample. */
export function buildReportDefs(data, now = Date.now()) {
  const money = (v) => Math.round(v);

  // Stock Replenishment — straight from the Python-computed send_in_*.
  const replenRows = data.offers
    .map((o) => {
      const stock = o.dcs.CPT[0] + o.dcs.JHB[0] + o.dcs.DBN[0];
      const sold30 = o.dcs.CPT[1] + o.dcs.JHB[1] + o.dcs.DBN[1];
      const sendIn = o.sendIn.CPT + o.sendIn.JHB + o.sendIn.DBN;
      return [o.title, stock, sold30, sendIn];
    })
    .filter((r) => r[3] > 0)
    .sort((a, b) => b[3] - a[3]);

  const totalSendIn = replenRows.reduce((a, r) => a + r[3], 0);

  // Weekly — the last 7 SAST days, bucketed off raw sales (data.orders
  // carries display-formatted dates, not parseable ones).
  const weeklyRows = [];
  for (let i = 6; i >= 0; i--) {
    const from = sastDayStart(i, now);
    const to = sastDayStart(i - 1, now);
    let orders = 0;
    let units = 0;
    let value = 0;
    for (const s of data.rawSales) {
      if (!s._date || !s._counts) continue;
      if (s._date < from || s._date >= to) continue;
      orders += 1;
      units += num(s.quantity);
      value += s._value;
    }
    weeklyRows.push([
      from.toLocaleDateString("en-ZA", { weekday: "short" }),
      orders,
      units,
      money(value),
    ]);
  }

  const weekValue = weeklyRows.reduce((a, r) => a + r[3], 0);
  const weekUnits = weeklyRows.reduce((a, r) => a + r[2], 0);
  const weekOrders = weeklyRows.reduce((a, r) => a + r[1], 0);
  const bestDay = weeklyRows.reduce((a, r) => (r[3] > a[3] ? r : a), weeklyRows[0]);

  const r7 = data.rows[2] || { qty: 0, value: 0 };
  const r30 = data.rows[3] || { qty: 0, value: 0, partial: false };
  const za = (n) => Number(n).toLocaleString("en-ZA");

  return {
    "Stock Replenishment": {
      subtitle: "Recommended reorder — payday-aware formula, computed by the sync",
      columns: ["Product", "In stock", "30-day sold", "Send in"],
      money: [],
      rows: replenRows.slice(0, 50),
      summary: [
        `${replenRows.length} SKUs need replenishment`,
        `Total units to send in: ${za(totalSendIn)}`,
        replenRows.length
          ? `Largest: ${replenRows[0][0]} — ${replenRows[0][3]} units`
          : "Nothing to send in right now",
      ],
    },
    "Weekly Report": {
      subtitle: "Performance for the last 7 days",
      columns: ["Day", "Orders", "Units", "Sales value"],
      money: [3],
      rows: weeklyRows,
      summary: [
        `Week total: ${za(weekUnits)} units · R ${za(weekValue)}`,
        `Best day: ${bestDay[0]} — R ${za(bestDay[3])}`,
        `Avg order value: R ${weekOrders ? za(Math.round(weekValue / weekOrders)) : 0}`,
      ],
    },
    "Monthly Report": {
      subtitle: "Performance for the last 30 days",
      columns: ["Period", "Units", "Sales value"],
      money: [2],
      rows: [
        ["Last 7 days", r7.qty, money(r7.value)],
        ["Last 30 days", r30.qty, money(r30.value)],
      ],
      summary: [
        `30-day total: ${za(r30.qty)} units · R ${za(money(r30.value))}`,
        r30.partial
          ? "Incomplete — the sync holds less than 30 days of history"
          : "Full 30-day window synced",
      ],
    },
  };
}
