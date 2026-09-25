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

/**
 * Two spellings of the same product, treated as one.
 *
 * Kept deliberately in step with SKU_ALIASES in
 * bluejelly-sync/takealot/sku_aliases.py — **change both together**. It is
 * one entry, and pulling it from the database would cost a query on every
 * load to avoid duplicating a single line.
 *
 * Storage stays faithful: offers_cache and sales_cache hold exactly what
 * Takealot said, so the app still reconciles against the seller portal.
 * Only grouping and cost lookups canonicalise, so a product listed under a
 * misspelt SKU cannot split into two rows or lose its own history.
 */
const SKU_ALIASES = {
  // "BLVK Ultra 55k Disposable Vape - Peach Mango Lychee", offer
  // 250871010. Listed on 1 Sept with an extra 2; the spreadsheet, and the
  // other nine in the family, say BLVK55K002.
  BLVK55K0022: "BLVK55K002",
};

export function canonicalSku(sku) {
  return SKU_ALIASES[sku] || sku;
}

/**
 * A SKU's cost record, found under either spelling.
 *
 * The sync already writes a cost row under both, so this is the second
 * line of defence — it also covers a row that predates the alias.
 */
function costRecord(costsBySku, sku) {
  return costsBySku.get(sku) || costsBySku.get(canonicalSku(sku));
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
/**
 * What a sale's units cost us, landed: the spreadsheet's product cost at
 * the sale's own date, plus the offer's current cost to ship into
 * Takealot's warehouse.
 *
 * Shared by the dashboard table and the chart. Two copies of this would
 * drift, and the pair are printed next to each other on the same screen.
 */
function landedCost(costsBySku, costHistory, s) {
  const c = costRecord(costsBySku, s.sku);
  const at = costAt(costHistory, c, s.sku, s._date);
  return (num(at?.cost_incl_vat) + num(c?.shipping_cost)) * num(s.quantity);
}

function computeWindow(sales, w, coverageStart, costsBySku, fallbackRate, costHistory = new Map()) {
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
    // Landed cost: what the stock cost us plus what it cost to get it
    // into Takealot's warehouse. Shipping is per unit, same as product
    // cost, so both scale with quantity.
    //
    // Product cost is read AT THE SALE'S DATE, so a spreadsheet update
    // stops rewriting last month's profit. Shipping has no history — it
    // comes from the live offer — so it stays current.
    const unitCost = landedCost(costsBySku, costHistory, s);

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
export function buildRows(sales, now = Date.now(), coverageStart = null, costsBySku = new Map(), costHistory = new Map()) {
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
    const row = computeWindow(sales, w, coverageStart, costsBySku, fallbackRate, costHistory);
    if (w.companion) {
      row.companion = computeWindow(sales, w.companion, coverageStart, costsBySku, fallbackRate, costHistory);
    }
    return row;
  });
}

/**
 * Per-bucket sales for the hero chart, one bucket per bar:
 *
 *   today  24 hours
 *   week    7 days
 *   month   4 weeks
 *
 * The month is in WEEKS, not days — 30 daily bars on a phone are
 * hairlines, and the question a month asks is which week was strong, not
 * which Tuesday.
 *
 * Those weeks are blocks counted from the 1st, NOT calendar
 * Monday-to-Sunday weeks. A calendar week straddles the month boundary,
 * so the first bar would cover however many days the month happened to
 * start with — a short bar that looks like a bad week rather than a
 * partial one.
 *
 * Four blocks means 8 days each for a 30- or 31-day month, so the last
 * one is a day or two short. Unavoidable: no month divides into four
 * equal weeks. The alternative — three 7-day blocks and a 9-day fourth —
 * makes the last bar tall for the wrong reason.
 */
export function buildSeries(sales, now = Date.now(), costsBySku = new Map(), costHistory = new Map()) {
  // Each bucket carries three figures, because the chart shows all three:
  // sales value across every unit sold, profit on the units that actually
  // shipped, and the margin those shipped units earned.
  //
  // Margin is profit over SHIPPED value, not over total value. An hour
  // whose orders are all still packing has no margin yet — dividing by
  // everything sold would report a real margin as a poor one purely
  // because Takealot had not dispatched yet.
  const bucket = (from, count, sizeMs) => {
    const value = new Array(count).fill(0);
    const profit = new Array(count).fill(0);
    const shipped = new Array(count).fill(0);
    // Line counts, so the tap can say "1 of 15 shipped". Without it, an
    // hour that has sold R4,323 and banked R22 reads as a terrible hour
    // rather than as one Takealot has barely started dispatching.
    const lines = new Array(count).fill(0);
    const shippedLines = new Array(count).fill(0);

    for (const s of sales) {
      // Same exclusion as buildRows — the chart and the table must agree,
      // and there is a test asserting exactly that.
      if (!s._date || !s._counts) continue;
      const offset = s._date.getTime() - from.getTime();
      if (offset < 0) continue;
      const i = Math.min(count - 1, Math.floor(offset / sizeMs));
      value[i] += s._value;
      lines[i] += 1;

      // Profit is shipped units only, at fees actually charged — the same
      // rule the Gross Profit column follows.
      if (orderStatusKey(s.status) === "shipped") {
        shipped[i] += s._value;
        shippedLines[i] += 1;
        profit[i] += s._value - s._fees - landedCost(costsBySku, costHistory, s);
      }
    }

    return {
      value: value.map((v) => Math.round(v)),
      profit: profit.map((v) => Math.round(v)),
      // Guarded: an hour with nothing shipped divides by zero.
      margin: profit.map((v, i) => (shipped[i] > 0 ? Math.round((v / shipped[i]) * 1000) / 10 : 0)),
      lines,
      shippedLines,
    };
  };

  // Calendar-aligned, matching the hero's "Today / This week / This
  // month" segments. A rolling 7-day series under a "This week" label
  // would quietly disagree with the table beneath it.
  const monthStart = sastMonthStart(0, now);
  const nextMonth = sastMonthStart(-1, now);
  const daysInMonth = Math.max(
    1, Math.round((nextMonth.getTime() - monthStart.getTime()) / 86400000)
  );

  // How many buckets have started, the current one included. The chart
  // draws a running total, so the last step is "so far today" and lands
  // exactly on the figure printed above it. Hours still to come are left
  // off — carried forward flat they would read as a day already finished.
  const dayStart = sastDayStart(0, now);
  const weekStart = sastWeekStart(0, now);
  const startedBuckets = (from, sizeMs, cap) =>
    Math.min(cap, Math.max(1, Math.floor((now - from.getTime()) / sizeMs) + 1));

  // Four bars a month, so the block is 8 days for a 30- or 31-day month
  // and 7 for February.
  const MONTH_BARS = 4;
  const daysPerBlock = Math.ceil(daysInMonth / MONTH_BARS);

  const today = bucket(dayStart, 24, 3600000);
  const week = bucket(weekStart, 7, 86400000);
  const month = bucket(monthStart, MONTH_BARS, daysPerBlock * 86400000);

  return {
    // `today` / `week` / `month` stay the value arrays they always were,
    // so every existing reader keeps working; profit and margin sit
    // alongside rather than changing the shape underneath them.
    today: today.value,
    week: week.value,
    month: month.value,
    profit: { today: today.profit, week: week.profit, month: month.profit },
    margin: { today: today.margin, week: week.margin, month: month.margin },
    lines: { today: today.lines, week: week.lines, month: month.lines },
    shippedLines: { today: today.shippedLines, week: week.shippedLines, month: month.shippedLines },
    elapsed: {
      today: startedBuckets(dayStart, 3600000, 24),
      week: startedBuckets(weekStart, 86400000, 7),
      month: startedBuckets(monthStart, daysPerBlock * 86400000, MONTH_BARS),
    },
  };
}

/** Orders list, newest first. Shaped like the old ORDERS sample array. */
export function buildOrders(sales, costsBySku, costHistory = new Map()) {
  return sales
    .filter((s) => s._date)
    .slice()
    .sort((a, b) => b._date - a._date)
    .map((s) => {
      const current = costRecord(costsBySku, s.sku);
      // Priced at the sale's own date, so reopening a July order shows
      // what it actually cost in July.
      const cost = { ...current, ...costAt(costHistory, current, s.sku, s._date) };
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
        // Cost of the WHOLE line, not one unit. `sell` in the detail
        // view is unit x qty, so a per-unit cost here under-counted every
        // multi-unit order — a 2-unit line deducted one unit's cost.
        // buildRows (the dashboard) already multiplied; this is the same
        // calculation written twice and disagreeing.
        productCost: num(cost?.cost_incl_vat) * (num(s.quantity) || 1),
        unitCost: num(cost?.cost_incl_vat),
        // "Cost to Ship to Takealot DC", per unit, from
        // /offers/offer_charges via offers_cache. R2 for most vapes, R20
        // for heaters — it matches the portal's own profit calculator.
        // Line-total like productCost, since the detail view compares it
        // against unit x qty.
        deliveryCost: num(cost?.shipping_cost) * (num(s.quantity) || 1),
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

/**
 * Takealot serves cover images from S3 over plain `http://`.
 *
 * The app is https on Vercel, so a browser blocks those as mixed content
 * and the tile silently stays empty — no error, just no picture. The same
 * URL answers fine over https, so upgrade the scheme here rather than
 * re-syncing 418 rows. Applied on read so every row already in
 * offers_cache is covered without waiting for a sync.
 */
function secureImageUrl(url) {
  return url ? String(url).replace(/^http:\/\//i, "https://") : null;
}

/**
 * What a SKU cost on a given day.
 *
 * `sku_costs` holds one current cost per SKU with no date on it, so before
 * this existed every sale was priced at whatever sat in that table right
 * now. Importing the September spreadsheet moved August's gross profit
 * from R125,702 to R139,240 on identical sales and identical fees, purely
 * because Nasty 9K went from R162 to R159 — August was being reported at
 * September's prices.
 *
 * `history` is a Map of sku -> change points sorted oldest first. Points
 * are sparse: a SKU appears only in the months its cost actually moved, so
 * the answer is the last point at or before the sale's date.
 *
 * `fallback` is the current `sku_costs` row, used for sales older than the
 * earliest point (the archive only goes back to July 2026) and for SKUs
 * that have no history at all. That is the old behaviour, now confined to
 * the cases where nothing better exists.
 */
export function costAt(history, fallback, sku, when) {
  const points = history.get(sku) || history.get(canonicalSku(sku));
  if (!points || !points.length) return fallback;
  if (!when) return points[points.length - 1];

  const t = when instanceof Date ? when.getTime() : new Date(when).getTime();
  // Scanning backwards: a SKU has a handful of points at most, and the
  // sales being priced are usually recent, so the answer is near the end.
  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i]._from <= t) return points[i];
  }
  // Older than anything on record. The earliest known cost beats the
  // current one — it is at least closer in time to the sale.
  return points[0];
}

/**
 * Index change-point rows by SKU, oldest first, with the date parsed once.
 *
 * `valid_from` is a bare date (2026-08-01). Parsed as SAST midnight rather
 * than UTC, so a sale at 01:30 on the 1st is not priced at the previous
 * month's cost.
 */
export function buildCostHistory(rows = []) {
  const bySku = new Map();
  for (const r of rows) {
    if (!r.sku || !r.valid_from) continue;
    const list = bySku.get(r.sku) || [];
    list.push({
      ...r,
      _from: new Date(`${String(r.valid_from).slice(0, 10)}T00:00:00+02:00`).getTime(),
    });
    bySku.set(r.sku, list);
  }
  for (const list of bySku.values()) list.sort((a, b) => a._from - b._from);
  return bySku;
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
    imageUrl: secureImageUrl(o.image_url),
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
    // Also Python's. Null until migration 010 has run and a sync has
    // written it, which the screen shows as "—" rather than inventing one.
    targetStock: o.target_stock ?? null,
    trendFactor: o.trend_factor ?? 1,
    syncedAt: o.synced_at || null,
  }));
}

/**
 * Reasons that say something about the product rather than the customer.
 *
 * This split is the whole point of reading returns_cache instead of the
 * "Returned" status on a sale. Across the archive, 928 of 1,104 returns
 * are Customer Cancellation and 983 come back as sellable stock. Counting
 * those as returns turns a healthy profile into an alarming one and
 * buries the few SKUs that genuinely misbehave — it made Elf Bar 9000
 * look like a quality problem when 135 of its 145 returns were
 * cancellations.
 */
export const QUALITY_REASONS = ["Defective or damaged", "Not what I ordered"];

export function isQualityReturn(reason) {
  return QUALITY_REASONS.includes(reason);
}

/** 1 = CPT, 3 = JHB, 6 = DBN, per /v2/shipment/filter_options/warehouse. */
const WAREHOUSES = { 1: "CPT", 3: "JHB", 6: "DBN" };

/**
 * Returns, from returns_cache rather than from sale statuses.
 *
 * `sales` is still needed for one thing: the denominator. A rate has to
 * be measured against what left the warehouse, and only sales_cache knows
 * that. Both are windowed the same way by the caller, or the rate compares
 * a year of returns against a month of sales.
 */
export function buildReturns(returnRows = [], sales = [], costsBySku = new Map()) {
  const dated = sales.filter((s) => s._date);

  // Units that went out: shipped plus returned, since a returned line
  // shipped before it came back. Excludes Preparing (not gone yet),
  // cancellations, Inter DC Transfer and Lost In Transit.
  let sold = 0;
  const soldBySku = new Map();
  for (const s of dated) {
    const status = (s.status || "").toLowerCase();
    if (!status.includes("ship") && !status.includes("return")) continue;
    const qty = num(s.quantity) || 1;
    sold += qty;
    // Canonical too, or a return rate divides one spelling's returns by
    // the other spelling's sales.
    const key = canonicalSku(s.sku);
    soldBySku.set(key, (soldBySku.get(key) || 0) + qty);
  }

  let units = 0;
  let defectUnits = 0;
  let cancelUnits = 0;
  let value = 0;
  let netValue = 0;
  const bySku = new Map();
  const reasons = new Map();
  const outcomes = new Map();

  for (const r of returnRows) {
    const qty = num(r.qty) || 1;
    const quality = isQualityReturn(r.reason);
    units += qty;
    if (quality) defectUnits += qty;
    else if ((r.reason || "").toLowerCase().includes("cancel")) cancelUnits += qty;
    value += num(r.sale_reversed);
    netValue += num(r.net_value);

    const reason = r.reason || "Unknown";
    const re = reasons.get(reason) || { reason, lines: 0, units: 0 };
    re.lines += 1;
    re.units += qty;
    reasons.set(reason, re);

    const outcome = r.outcome || "Unknown";
    const oe = outcomes.get(outcome) || { outcome, lines: 0, units: 0 };
    oe.lines += 1;
    oe.units += qty;
    outcomes.set(outcome, oe);

    // Canonical: a return under either spelling belongs to one product.
    const sku = canonicalSku(r.sku) || "—";
    const pe = bySku.get(sku) || {
      sku, title: r.title || sku, units: 0, defectUnits: 0, value: 0,
    };
    pe.units += qty;
    if (quality) pe.defectUnits += qty;
    pe.value += num(r.sale_reversed);
    bySku.set(sku, pe);
  }

  const rateOf = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);

  const products = [...bySku.values()]
    .map((p) => {
      const out = soldBySku.get(p.sku) || 0;
      return {
        ...p,
        value: Math.round(p.value),
        sold: out,
        // null rather than 0 when the SKU shipped nothing in this window:
        // a return with no matching sales is a real case (it shipped
        // before the window opened) and 0% would read as "no problem".
        rate: out > 0 ? rateOf(p.units, out) : null,
        defectRate: out > 0 ? rateOf(p.defectUnits, out) : null,
      };
    })
    // Quality first — that is the list worth acting on. Cancellations
    // rank by volume only because they say nothing about the product.
    .sort((a, b) => b.defectUnits - a.defectUnits || b.units - a.units);

  const items = returnRows
    .slice()
    .sort((a, b) => String(b.return_date || "").localeCompare(String(a.return_date || "")))
    .map((r) => {
      const when = r.return_date ? new Date(r.return_date) : null;
      const sast = when ? new Date(when.getTime() + SAST_OFFSET_MS) : null;
      const dd = sast ? String(sast.getUTCDate()).padStart(2, "0") : "—";
      const mon = sast ? sast.toLocaleString("en-ZA", { month: "short", timeZone: "UTC" }) : "";
      // Takealot's own six-month defect counters, which is what its 7.5%
      // SLA is measured against — their arithmetic, not a re-derivation.
      const slaBase = num(r.sales_units_6m);
      const defects6m = num(r.damaged_defective_6m) + num(r.wrong_item_6m);
      return {
        sellerReturnId: r.seller_return_id,
        rrn: r.rrn || "—",
        orderId: r.order_id ?? "—",
        sku: r.sku || "—",
        tsin: r.tsin ?? "—",
        title: r.title || r.sku || "Unknown product",
        qty: num(r.qty) || 1,
        date: sast ? `${dd} ${mon}` : "—",
        time: sast
          ? `${String(sast.getUTCHours()).padStart(2, "0")}:${String(sast.getUTCMinutes()).padStart(2, "0")}`
          : "",
        reason: r.reason || "Unknown",
        quality: isQualityReturn(r.reason),
        outcome: r.outcome || "Unknown",
        outcomeStatus: r.outcome_status || null,
        // A removal order is stock you must collect — the only outcome
        // that is actually a loss. Sellable stock goes back on sale.
        removal: String(r.outcome_status || r.outcome || "").toLowerCase().includes("removal"),
        warehouse: WAREHOUSES[r.warehouse_id] || (r.warehouse_id ? `DC ${r.warehouse_id}` : "—"),
        imageUrl: secureImageUrl(r.cover_image_url),
        productUrl: r.product_url || null,
        comment: r.comment || null,
        reversalRequired: r.reversal_required === true,
        saleReversed: Math.round(num(r.sale_reversed)),
        feesCredited: Math.round(num(r.fees_credited)),
        netValue: Math.round(num(r.net_value)),
        deliveries6m: num(r.deliveries_6m),
        salesUnits6m: slaBase,
        damaged6m: num(r.damaged_defective_6m),
        wrongItem6m: num(r.wrong_item_6m),
        defectRate6m: slaBase > 0 ? rateOf(defects6m, slaBase) : null,
        hasDetails: !!r.details_synced_at,
        cost: Math.round(num(costRecord(costsBySku, r.sku)?.cost_incl_vat) * (num(r.qty) || 1)),
      };
    });

  return {
    lines: returnRows.length,
    units,
    defectUnits,
    cancelUnits,
    // Anything neither a quality fault nor a cancellation: failed
    // delivery, exception, changed my mind.
    otherUnits: units - defectUnits - cancelUnits,
    value: Math.round(value),
    netValue: Math.round(netValue),
    sold,
    rate: rateOf(units, sold),
    // The headline. Takealot's SLA is on defects, not on cancellations.
    defectRate: rateOf(defectUnits, sold),
    removals: items.filter((i) => i.removal).length,
    byReason: [...reasons.values()].sort((a, b) => b.units - a.units),
    byOutcome: [...outcomes.values()].sort((a, b) => b.units - a.units),
    products,
    items,
  };
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

/**
 * Sales Ops recommendations, shaped for the card the UI already draws.
 *
 * The generator (Python, takealot/sales_ops.py) owns the logic; this only
 * renames fields. Undecided items sort first so the list is a worklist
 * rather than an archive — actioned ones stay visible underneath.
 */
export function buildRecommendations(rows) {
  return rows
    .map((r) => ({
      id: r.id,
      type: r.type,
      sku: r.sku,
      family: r.title || r.sku,
      confidence: num(r.confidence),
      urgency: r.urgency || "low",
      signal: r.signal || "",
      impact: r.impact || "",
      reasoning: r.reasoning || "",
      // The card reads `current` / `proposed` as free-form objects.
      current: r.current_state || {},
      proposed: r.proposed || {},
      value: num(r.value_rand),
      decision: r.decision || null,
      decidedAt: r.decided_at || null,
    }))
    .sort((a, b) => {
      const aDone = a.decision ? 1 : 0;
      const bDone = b.decision ? 1 : 0;
      if (aDone !== bDone) return aDone - bDone;
      return b.value - a.value;
    });
}
