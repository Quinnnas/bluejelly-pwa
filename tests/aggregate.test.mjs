/**
 * Tests for the pure aggregation layer. Run from bluejelly-pwa:
 *
 *     node tests/aggregate.test.mjs
 *
 * No test framework and no build step — aggregate.js imports nothing, so
 * Node can load it directly. Exits non-zero on failure.
 *
 * The date bucketing gets the most attention here because it's the part
 * that fails silently: wrong numbers still look like plausible numbers.
 */
import assert from "node:assert/strict";
import {
  buildOffers,
  canonicalSku,
  buildCostHistory,
  costAt,
  buildReturns,
  isQualityReturn,
  buildOrders,
  buildReportDefs,
  buildRows,
  buildSeries,
  offerStatusKey,
  orderStatusKey,
  prepareSales,
  sastDayStart,
} from "../src/lib/aggregate.js";

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  FAIL  ${name}\n        ${e.message}`);
  }
}

// A fixed "now": 15 Aug 2026, 10:00 UTC = 12:00 SAST.
const NOW = Date.parse("2026-08-15T10:00:00Z");
// `line_total` is what Takealot reports for the whole line; unit_price is
// derived from it. Helpers default to a single R100 unit.
const sale = (iso, over = {}) => {
  const quantity = over.quantity ?? 1;
  const unit = over.unit_price ?? 100;
  return {
    order_item_id: over.id || iso,
    order_date: iso,
    sku: over.sku || "SKU1",
    quantity,
    line_total: over.line_total ?? unit * quantity,
    unit_price: unit,
    status: over.status || "Shipped to Customer",
    counts_toward_velocity: over.counts !== false,
    customer_dc: "JHB",
    ...over,
  };
};

console.log("\nsastDayStart");
test("today starts at 22:00 UTC the previous day", () => {
  assert.equal(sastDayStart(0, NOW).toISOString(), "2026-08-14T22:00:00.000Z");
});
test("yesterday is exactly 24h earlier", () => {
  assert.equal(
    sastDayStart(0, NOW).getTime() - sastDayStart(1, NOW).getTime(),
    86400000
  );
});
test("a 23:30 SAST sale counts as today, not tomorrow", () => {
  // 21:30 UTC on the 15th = 23:30 SAST on the 15th.
  const s = prepareSales([sale("2026-08-15T21:30:00Z")]);
  const rows = buildRows(s, NOW);
  assert.equal(rows[0].qty, 1, "should land in Today");
  assert.equal(rows[1].qty, 0, "should not land in Yesterday");
});
test("a 00:30 SAST sale counts as today, not yesterday", () => {
  // 22:30 UTC on the 14th = 00:30 SAST on the 15th. This is the case a
  // naive UTC boundary gets wrong.
  const s = prepareSales([sale("2026-08-14T22:30:00Z")]);
  const rows = buildRows(s, NOW);
  assert.equal(rows[0].qty, 1, "should land in Today");
  assert.equal(rows[1].qty, 0, "should not land in Yesterday");
});
test("a 21:30 SAST sale on the previous day counts as yesterday", () => {
  // 19:30 UTC on the 14th = 21:30 SAST on the 14th, i.e. yesterday
  // relative to NOW (15 Aug, 12:00 SAST).
  const s = prepareSales([sale("2026-08-14T19:30:00Z")]);
  const rows = buildRows(s, NOW);
  assert.equal(rows[1].qty, 1, "should land in Yesterday");
  assert.equal(rows[0].qty, 0, "should not land in Today");
});

console.log("\nbuildRows");
test("value sums line_total, and does NOT multiply by quantity again", () => {
  // Takealot's selling_price is the whole line: 3 units at R250 reports
  // R750, not R250. Multiplying by quantity here inflated 30-day sales
  // by 36% against the seller portal.
  const s = prepareSales([sale("2026-08-15T08:00:00Z", {
    quantity: 3, unit_price: 250, line_total: 750,
  })]);
  const row = buildRows(s, NOW)[0];
  assert.equal(row.value, 750, "not 2250");
  assert.equal(row.qty, 3);
});
test("line_total wins over unit_price when both are present", () => {
  const s = prepareSales([sale("2026-08-15T08:00:00Z", {
    quantity: 2, unit_price: 311, line_total: 622,
  })]);
  assert.equal(buildRows(s, NOW)[0].value, 622);
});
test("a row with no line_total falls back to unit_price * quantity", () => {
  // Guards a real mistake: a caller that forgets to SELECT line_total
  // used to silently under-count every multi-unit order rather than fail.
  const s = prepareSales([{
    order_item_id: "no-total", order_date: "2026-08-15T08:00:00Z", sku: "S",
    quantity: 2, unit_price: 311, line_total: null,
    counts_toward_velocity: true,
  }]);
  assert.equal(buildRows(s, NOW)[0].value, 622, "not 311");
});
test("a missing quantity does not zero out the fallback", () => {
  const s = prepareSales([{
    order_item_id: "noqty", order_date: "2026-08-15T08:00:00Z", sku: "S",
    quantity: null, unit_price: 250, line_total: null,
    counts_toward_velocity: true,
  }]);
  assert.equal(buildRows(s, NOW)[0].value, 250, "treats missing qty as 1");
});
test("the headline counts only units that actually sold", () => {
  // Deliberate divergence from the Takealot portal, which counts every
  // order placed. The dashboard shows what sold, so cancellations and
  // returns are excluded — and the excluded amount is kept alongside so
  // the two can still be reconciled.
  const s = prepareSales([
    sale("2026-08-15T08:00:00Z", { id: "ok" }),
    sale("2026-08-15T08:00:00Z", { id: "no", counts: false }),
  ]);
  const r = buildRows(s, NOW)[0];
  assert.equal(r.qty, 1, "one unit sold, not two");
  assert.equal(r.value, 100);
  assert.equal(r.placedQty, 2, "portal-comparable figure retained");
  assert.equal(r.placedValue, 200);
  assert.equal(r.returnedQty, 1);
  assert.equal(r.returnedValue, 100);
  assert.equal(r.placedValue - r.returnedValue, r.value, "the three tie");
});
test("rows are calendar periods, not rolling windows", () => {
  // NOW is Sat 15 Aug 2026. This week began Mon 10 Aug; last week was
  // 3-9 Aug; last month is July.
  const s = prepareSales([
    sale("2026-08-15T08:00:00Z", { id: "today" }),
    sale("2026-08-11T08:00:00Z", { id: "thisweek" }),
    sale("2026-08-05T08:00:00Z", { id: "lastweek" }),
    sale("2026-07-20T08:00:00Z", { id: "lastmonth" }),
  ]);
  const [today, yesterday, lastWeek, lastMonth] = buildRows(s, NOW);
  assert.equal(today.qty, 1, "only the 15th");
  assert.equal(yesterday.qty, 0, "nothing on the 14th");
  assert.equal(lastWeek.qty, 1, "only the 5th");
  assert.equal(lastMonth.qty, 1, "only the July sale");
  assert.equal(lastWeek.companion.qty, 2, "this week so far: 11th and 15th");
  assert.equal(lastMonth.companion.qty, 3, "this month so far: all three August sales");
});
test("prep and ship are disjoint and add up to qty", () => {
  // The table shows them side by side as separate groups, so they must
  // never double-count: reading them as two groups has to give the total.
  const s = prepareSales([
    sale("2026-08-15T08:00:00Z", { id: "a", status: "Preparing for Customer", quantity: 3, unit_price: 100, line_total: 300 }),
    sale("2026-08-15T09:00:00Z", { id: "b", status: "Shipped to Customer", quantity: 2, unit_price: 100, line_total: 200 }),
    sale("2026-08-15T10:00:00Z", { id: "c", status: "Cancelled by Customer", quantity: 5, counts: false }),
  ]);
  const r = buildRows(s, NOW)[0];
  assert.equal(r.preparingQty, 3);
  assert.equal(r.shippedQty, 2);
  assert.equal(r.preparingQty + r.shippedQty, r.qty, "the two columns tie to the total");
  assert.equal(r.qty, 5, "the cancelled 5 are excluded entirely");
  assert.equal(r.preparingValue + r.shippedValue, r.value, "values tie too");
});
test("an unrecognised status is treated as not-yet-shipped", () => {
  // Anything that isn't clearly shipped counts as preparing, so the two
  // columns still sum to qty rather than quietly losing units.
  const s = prepareSales([
    sale("2026-08-15T08:00:00Z", { id: "a", status: "Some New Takealot Status" }),
  ]);
  const r = buildRows(s, NOW)[0];
  assert.equal(r.preparingQty + r.shippedQty, r.qty);
  assert.equal(r.shippedQty, 0);
});
test("a cancelled order is not counted as awaiting dispatch", () => {
  const s = prepareSales([
    sale("2026-08-15T08:00:00Z", { status: "Cancelled by Customer", counts: false }),
  ]);
  const r = buildRows(s, NOW)[0];
  assert.equal(r.preparingQty, 0);
});
test("a fully shipped period reports nothing preparing", () => {
  const s = prepareSales([sale("2026-08-05T08:00:00Z", { status: "Shipped to Customer" })]);
  const r = buildRows(s, NOW)[2];
  assert.equal(r.preparingQty, 0);
  assert.equal(r.shippedQty, r.qty);
});
test("a Monday sale belongs to the week it starts, not the one before", () => {
  // Mon 10 Aug 06:00 SAST = 04:00 UTC. The boundary case most likely to
  // land in the wrong bucket.
  const s = prepareSales([sale("2026-08-10T04:00:00Z")]);
  const [, , lastWeek] = buildRows(s, NOW);
  assert.equal(lastWeek.qty, 0, "not last week");
  assert.equal(lastWeek.companion.qty, 1, "this week");
});
test("a 1st-of-month sale belongs to that month", () => {
  // 1 Aug 00:30 SAST = 31 Jul 22:30 UTC.
  const s = prepareSales([sale("2026-07-31T22:30:00Z")]);
  const [, , , lastMonth] = buildRows(s, NOW);
  assert.equal(lastMonth.qty, 0, "not July");
  assert.equal(lastMonth.companion.qty, 1, "August");
});
// How data.js derives coverage: midnight SAST, N days before the sync,
// matching Python's `date.today() - timedelta(days=N)` cutoff exactly.
const coverageFor = (days, at = NOW) => sastDayStart(days, at);

test("partial marks periods the synced data doesn't reach", () => {
  // Takealot exposes a rolling 30 days, so on 15 Aug the data starts
  // ~16 July — enough for last week, not enough for all of July.
  const coverage = new Date(Date.parse("2026-07-16T00:00:00Z"));
  const rows = buildRows(prepareSales([sale("2026-08-15T08:00:00Z")]), NOW, coverage);
  assert.equal(rows[0].partial, false, "today covered");
  assert.equal(rows[1].partial, false, "yesterday covered");
  assert.equal(rows[2].partial, false, "last week covered");
  assert.equal(rows[3].partial, true, "July starts before the data does");
  assert.equal(rows[3].companion.partial, false, "August itself is covered");
});
test("a full month is not flagged partial once data reaches it", () => {
  const coverage = new Date(Date.parse("2026-06-01T00:00:00Z"));
  const rows = buildRows([], NOW, coverage);
  assert.equal(rows[3].partial, false, "July fully within coverage");
});
test("a quiet period is not mistaken for missing data", () => {
  // The bug this guards against: with coverage derived from the earliest
  // sale, a store with one sale today would flag its 7-day bucket as
  // partial even though the sync holds a full 30 days.
  const rows = buildRows(
    prepareSales([sale("2026-08-15T08:00:00Z")]), NOW, coverageFor(30)
  );
  assert.equal(rows[2].partial, false);
  assert.equal(rows[1].qty, 0, "yesterday genuinely had no sales");
});
test("nothing synced at all -> every period partial", () => {
  const rows = buildRows([], NOW, null);
  assert.ok(rows.every((r) => r.partial));
});
test("nothing synced yet -> every bucket is partial", () => {
  const rows = buildRows([], NOW, null);
  assert.ok(rows.every((r) => r.partial), "unverified until a sync happens");
});
test("no sales -> four zeroed rows", () => {
  const rows = buildRows([], NOW);
  assert.equal(rows.length, 4, "Today, Yesterday, Last week, Last month");
  assert.deepEqual(rows.map((r) => r.qty), [0, 0, 0, 0]);
  // Last month is labelled by name — shorter than "Last month" on a
  // phone, and unambiguous. NOW is August, so the previous month is July.
  assert.deepEqual(rows.map((r) => r.short), ["Today", "Yesterday", "Last week", "July"]);
  assert.equal(rows[3].label, "Last month · July", "the expanded view spells it out");
  assert.equal(rows[3].companion.short, "August");
});
test("malformed dates are ignored, not counted as epoch", () => {
  const s = prepareSales([sale("total nonsense"), sale("2026-08-15T08:00:00Z", { id: "ok" })]);
  assert.equal(buildRows(s, NOW)[0].qty, 1);
});
test("a sale with no price at all does not produce NaN", () => {
  const s = prepareSales([sale("2026-08-15T08:00:00Z", {
    unit_price: null, line_total: null,
  })]);
  const v = buildRows(s, NOW)[0].value;
  assert.equal(v, 0);
  assert.ok(!Number.isNaN(v));
});

console.log("\nbuildRows — money in the bank");
const withFees = (iso, over = {}) => sale(iso, {
  success_fee: 20, fulfilment_fee: 30, courier_fee: 5, stock_transfer_fee: 0, ...over,
});

test("payout counts SHIPPED units only, at actual fees", () => {
  // Takealot pays out on dispatch, so undispatched stock is not banked.
  // Sales Value still covers everything sold, so the two deliberately
  // do not tie.
  const s = prepareSales([
    withFees("2026-08-15T08:00:00Z", { id: "shipped", unit_price: 300, status: "Shipped to Customer" }),
    sale("2026-08-15T09:00:00Z", { id: "packing", unit_price: 500, status: "Preparing for Customer" }),
    withFees("2026-08-15T10:00:00Z", { id: "gone", unit_price: 200, counts: false }),
  ]);
  const r = buildRows(s, NOW)[0];
  assert.equal(r.value, 800, "Sales Value = shipped + preparing");
  assert.equal(r.shippedValue, 300, "only the dispatched line is banked");
  assert.equal(r.fees, 55, "actual fees on the shipped line");
  assert.equal(r.payout, 245, "300 - 55, nothing estimated");
  assert.equal(r.pendingFeeValue, 500, "the preparing line, not yet banked");
});
test("a returned order contributes no fees, cost or payout", () => {
  const s = prepareSales([withFees("2026-08-15T08:00:00Z", { counts: false })]);
  const costs = new Map([["SKU1", { cost_incl_vat: 50 }]]);
  const r = buildRows(s, NOW, null, costs)[0];
  assert.equal(r.fees, 0);
  assert.equal(r.cost, 0);
  assert.equal(r.payout, 0);
  assert.equal(r.shippedValue, 0);
});
test("product cost multiplies by quantity", () => {
  const s = prepareSales([withFees("2026-08-15T08:00:00Z", {
    quantity: 3, unit_price: 300, line_total: 900, status: "Shipped to Customer",
  })]);
  const costs = new Map([["SKU1", { cost_incl_vat: 100 }]]);
  const r = buildRows(s, NOW, null, costs)[0];
  assert.equal(r.cost, 300);
  assert.equal(r.profit, 900 - 55 - 300);
});
test("shipping to the Takealot DC comes off profit, per unit", () => {
  // "Cost to Ship to Takealot DC" — R20 on a heater, R2 on a vape. It is
  // in neither /offers nor /sales; the sync reads it from
  // /offers/offer_charges. Left out, profit ran ~R8,600/month optimistic.
  const s = prepareSales([withFees("2026-08-15T08:00:00Z", {
    quantity: 2, unit_price: 300, line_total: 600, status: "Shipped to Customer",
  })]);
  const costs = new Map([["SKU1", { cost_incl_vat: 100, shipping_cost: 20 }]]);
  const r = buildRows(s, NOW, null, costs)[0];
  assert.equal(r.cost, 240, "2 x (100 product + 20 shipping)");
  assert.equal(r.profit, 600 - 55 - 240);
});
test("a SKU with no shipping cost is unchanged, not NaN", () => {
  const s = prepareSales([withFees("2026-08-15T08:00:00Z", {
    unit_price: 300, line_total: 300, status: "Shipped to Customer",
  })]);
  const costs = new Map([["SKU1", { cost_incl_vat: 100 }]]);
  const r = buildRows(s, NOW, null, costs)[0];
  assert.equal(r.cost, 100, "missing shipping is zero, and never poisons the sum");
});
test("the not-yet-banked hint is estimated at the observed rate", () => {
  const s = prepareSales([
    sale("2026-08-15T08:00:00Z", { id: "shipped", unit_price: 1000, success_fee: 200, status: "Shipped to Customer" }),
    sale("2026-08-15T09:00:00Z", { id: "packing", unit_price: 500, status: "Preparing for Customer" }),
  ]);
  const r = buildRows(s, NOW)[0];
  assert.equal(r.feesPending, true);
  assert.equal(r.pendingFeeValue, 500);
  assert.equal(r.estimatedPendingFees, 100, "500 at the observed 20% rate");
});
test("profit uses shipped cost, not the cost of everything sold", () => {
  const s = prepareSales([
    sale("2026-08-15T08:00:00Z", { id: "shipped", unit_price: 1000, success_fee: 200, status: "Shipped to Customer" }),
    sale("2026-08-15T09:00:00Z", { id: "packing", unit_price: 500, status: "Preparing for Customer" }),
  ]);
  const costs = new Map([["SKU1", { cost_incl_vat: 300 }]]);
  const r = buildRows(s, NOW, null, costs)[0];
  assert.equal(r.cost, 300, "one shipped unit, not both");
  assert.equal(r.preparingCost, 300, "the undispatched unit's cost, tracked apart");
  assert.equal(r.payout, 800, "1000 - 200");
  assert.equal(r.profit, 500, "800 - 300");
});
test("a day where nothing has shipped banks nothing", () => {
  // The morning case: orders are in, none dispatched. Sales Value is
  // real; the bank is genuinely still empty.
  const s = prepareSales([
    sale("2026-08-15T09:00:00Z", { unit_price: 400, status: "Preparing for Customer" }),
  ]);
  const r = buildRows(s, NOW)[0];
  assert.equal(r.value, 400, "it did sell");
  assert.equal(r.shippedValue, 0);
  assert.equal(r.payout, 0, "nothing banked yet");
  assert.equal(r.profit, 0);
  assert.equal(r.feesPending, true);
});
test("banked figures contain no estimate", () => {
  // payout/profit must derive only from fees actually charged, so a rate
  // estimate can never move them.
  const s = prepareSales([
    sale("2026-08-15T08:00:00Z", { id: "a", unit_price: 733, success_fee: 191.29, status: "Shipped to Customer" }),
    sale("2026-08-15T09:00:00Z", { id: "b", unit_price: 417, status: "Preparing for Customer" }),
  ]);
  const r = buildRows(s, NOW)[0];
  assert.equal(r.fees, r.feesCharged, "no estimated component");
  assert.equal(r.payout, r.shippedValue - r.feesCharged);
  assert.ok(r.feesExpected > 0, "the estimate still exists as context");
  assert.equal(r.value, 1150, "but Sales Value covers both lines");
});
test("no pending flag once everything has shipped", () => {
  const s = prepareSales([withFees("2026-08-15T08:00:00Z")]);
  assert.equal(buildRows(s, NOW)[0].feesPending, false);
});
test("a SKU with no cost row leaves profit reporting cost 0, not NaN", () => {
  const s = prepareSales([withFees("2026-08-15T08:00:00Z")]);
  const r = buildRows(s, NOW, null, new Map())[0];
  assert.equal(r.cost, 0);
  assert.ok(Number.isFinite(r.profit));
});
test("the displayed waterfall always ties exactly", () => {
  // Fractional values that don't round cleanly. Rounding each line
  // independently made the 30-day column miss by a rand against real data.
  const s = prepareSales([
    sale("2026-08-15T08:00:00Z", { id: "a", unit_price: 311.37, success_fee: 20.44, fulfilment_fee: 30.51 }),
    sale("2026-08-15T09:00:00Z", { id: "b", unit_price: 246.83, success_fee: 18.29, courier_fee: 5.61 }),
    sale("2026-08-15T10:00:00Z", { id: "c", unit_price: 199.49, counts: false }),
  ]);
  const costs = new Map([["SKU1", { cost_incl_vat: 87.33 }]]);
  const r = buildRows(s, NOW, null, costs)[0];
  assert.equal(r.payout, r.shippedValue - r.fees, "payout line");
  assert.equal(r.profit, r.payout - r.cost, "profit line");
  assert.equal(r.placedValue - r.returnedValue, r.value, "reconciles to the portal figure");
});
test("an empty window produces zeros, not NaN, across the waterfall", () => {
  const r = buildRows([], NOW)[0];
  for (const k of ["value", "returnedValue", "netSales", "fees", "payout", "cost", "profit", "shippedValue"]) {
    assert.equal(r[k], 0, k);
  }
  assert.equal(r.feesPending, false);
});

console.log("\nbuildSeries");
test("today has 24 hourly buckets", () => {
  assert.equal(buildSeries([], NOW).today.length, 24);
});
test("a sale lands in its SAST hour bucket", () => {
  // 08:00 UTC = 10:00 SAST -> index 10.
  const s = prepareSales([sale("2026-08-15T08:00:00Z", { unit_price: 500 })]);
  const series = buildSeries(s, NOW);
  assert.equal(series.today[10], 500);
  assert.equal(series.today.reduce((a, b) => a + b, 0), 500);
});
test("the week series matches this-week-so-far in the table", () => {
  const s = prepareSales([
    sale("2026-08-11T08:00:00Z", { id: "a", unit_price: 100 }),
    sale("2026-08-15T08:00:00Z", { id: "b", unit_price: 250 }),
    sale("2026-08-15T09:00:00Z", { id: "c", unit_price: 100, counts: false }),
  ]);
  const series = buildSeries(s, NOW);
  assert.equal(series.week.length, 7);
  // The hero chart and the table must never disagree.
  assert.equal(
    series.week.reduce((a, b) => a + b, 0),
    buildRows(s, NOW)[2].companion.value
  );
});
test("the month series matches this-month-so-far and spans the month", () => {
  const s = prepareSales([
    sale("2026-08-02T08:00:00Z", { id: "a", unit_price: 400 }),
    sale("2026-08-15T08:00:00Z", { id: "b", unit_price: 150 }),
  ]);
  const series = buildSeries(s, NOW);
  assert.equal(series.month.length, 31, "August has 31 days");
  assert.equal(
    series.month.reduce((a, b) => a + b, 0),
    buildRows(s, NOW)[3].companion.value
  );
});
test("the hero chart total equals the Today row", () => {
  const s = prepareSales([
    sale("2026-08-15T08:00:00Z", { id: "a", quantity: 2, unit_price: 311, line_total: 622 }),
    sale("2026-08-15T09:00:00Z", { id: "b", unit_price: 246 }),
  ]);
  assert.equal(
    buildSeries(s, NOW).today.reduce((a, b) => a + b, 0),
    buildRows(s, NOW)[0].value
  );
});

console.log("\nstatus mapping");
test("order statuses map onto UI keys", () => {
  assert.equal(orderStatusKey("Shipped to Customer"), "shipped");
  assert.equal(orderStatusKey("Cancelled by Customer"), "cancelled");
  assert.equal(orderStatusKey("Returned"), "cancelled");
  assert.equal(orderStatusKey("Lead time order"), "leadtime");
  assert.equal(orderStatusKey("Preparing for Customer"), "preparing");
  assert.equal(orderStatusKey(null), "preparing", "must never return undefined");
});
test("offer statuses map onto UI keys", () => {
  assert.equal(offerStatusKey("Buyable"), "buyable");
  assert.equal(offerStatusKey("Not Buyable"), "notbuyable");
  assert.equal(offerStatusKey("Disabled"), "disabled");
  assert.equal(offerStatusKey(undefined), "buyable");
});

console.log("\nbuildOrders");
test("newest first, with SAST-formatted date and time", () => {
  const s = prepareSales([
    sale("2026-08-10T08:00:00Z", { id: "old" }),
    sale("2026-08-15T08:00:00Z", { id: "new" }),
  ]);
  const orders = buildOrders(s, new Map());
  assert.equal(orders[0].id, "new");
  assert.equal(orders[0].date, "15 Aug");
  assert.equal(orders[0].time, "10:00", "08:00 UTC is 10:00 SAST");
});
test("real sale fields surface on the Orders screen", () => {
  const s = prepareSales([sale("2026-08-15T08:00:00Z", {
    order_item_id: "438295981", order_id: 221395787, tsin: 101654189,
    offer_id: 230252392, product_title: "Nasty Surge 55000 Puffs",
    customer_name: "Fatimah Davids Cox",
  })]);
  const o = buildOrders(s, new Map())[0];
  assert.equal(o.id, 221395787, "the order number, not the line-item id");
  assert.equal(o.orderItemId, "438295981");
  assert.equal(o.tsin, 101654189);
  assert.equal(o.offerId, 230252392);
  assert.equal(o.title, "Nasty Surge 55000 Puffs");
  assert.equal(o.customer, "Fatimah Davids Cox");
});
test("orderItemId is unique even when orders share an order number", () => {
  // One order, two line items. `id` is the order number and repeats, so
  // anything keyed on it collides — React drops or duplicates rows.
  const s = prepareSales([
    sale("2026-08-15T08:00:00Z", { order_item_id: "111", order_id: 999, sku: "A" }),
    sale("2026-08-15T08:00:00Z", { order_item_id: "222", order_id: 999, sku: "B" }),
  ]);
  const orders = buildOrders(s, new Map());
  assert.equal(orders[0].id, orders[1].id, "same order number, as expected");
  assert.notEqual(orders[0].orderItemId, orders[1].orderItemId, "but distinct line ids");
  assert.equal(new Set(orders.map((o) => o.orderItemId)).size, 2);
});
test("product_title wins over a sku_costs title", () => {
  const s = prepareSales([sale("2026-08-15T08:00:00Z", {
    sku: "ABC", product_title: "API name",
  })]);
  const costs = new Map([["ABC", { title: "Spreadsheet name", cost_incl_vat: 5 }]]);
  assert.equal(buildOrders(s, costs)[0].title, "API name");
});
test("product cost joins from sku_costs", () => {
  const s = prepareSales([sale("2026-08-15T08:00:00Z", { sku: "ABC" })]);
  const costs = new Map([["ABC", { title: "Elf Bar Grape", cost_incl_vat: 120 }]]);
  const o = buildOrders(s, costs)[0];
  assert.equal(o.title, "Elf Bar Grape");
  assert.equal(o.productCost, 120);
});
test("product cost covers the whole line, not one unit", () => {
  // The detail view compares cost against unit x qty, so a per-unit cost
  // here under-counted every multi-unit order. buildRows already
  // multiplied — the same sum written twice and disagreeing.
  const s = prepareSales([sale("2026-08-15T08:00:00Z", {
    sku: "ABC", quantity: 2, unit_price: 200, line_total: 400,
  })]);
  const costs = new Map([["ABC", { title: "T", cost_incl_vat: 115 }]]);
  const o = buildOrders(s, costs)[0];
  assert.equal(o.productCost, 230, "2 units at R115, not R115");
  assert.equal(o.unitCost, 115, "per-unit kept separately");
  assert.equal(o.unit * o.qty, 400, "and it lines up with the sale value");
});
test("delivery cost covers the whole line and shows in the detail view", () => {
  const s = prepareSales([sale("2026-08-15T08:00:00Z", {
    sku: "ABC", quantity: 2, unit_price: 200, line_total: 400,
  })]);
  const costs = new Map([["ABC", { title: "T", cost_incl_vat: 115, shipping_cost: 20 }]]);
  const o = buildOrders(s, costs)[0];
  assert.equal(o.deliveryCost, 40, "2 units at R20, matching productCost's line-total shape");
  assert.equal(o.productCost, 230, "and shipping is not folded into product cost");
});
test("a SKU with no cost row degrades instead of throwing", () => {
  const s = prepareSales([sale("2026-08-15T08:00:00Z", { sku: "UNKNOWN" })]);
  const o = buildOrders(s, new Map())[0];
  assert.equal(o.productCost, 0);
  assert.equal(o.deliveryCost, 0);
  assert.equal(o.title, "UNKNOWN");
});
test("missing fees become 0, never undefined", () => {
  const s = prepareSales([sale("2026-08-15T08:00:00Z")]);
  const o = buildOrders(s, new Map())[0];
  assert.deepEqual(o.fees, { success: 0, fulfillment: 0, courier: 0, stockTransfer: 0 });
});

console.log("\nbuildOffers");
test("maps DC columns into the [stock, sales30] tuples the UI expects", () => {
  const [o] = buildOffers([{
    sku: "S1", title: "T", status: "Buyable", price: 100, rrp: 150,
    stock_cpt: 1, stock_jhb: 2, stock_dbn: 3,
    sales_30d_cpt: 10, sales_30d_jhb: 20, sales_30d_dbn: 30,
    send_in_cpt: 4, send_in_jhb: 5, send_in_dbn: 6,
  }]);
  assert.deepEqual(o.dcs, { CPT: [1, 10], JHB: [2, 20], DBN: [3, 30] });
  assert.deepEqual(o.sendIn, { CPT: 4, JHB: 5, DBN: 6 });
});
test("an offer missing the 005/006 columns defaults to 0, not NaN", () => {
  const [o] = buildOffers([{ sku: "S1", title: "T", status: "Buyable" }]);
  assert.deepEqual(o.sendIn, { CPT: 0, JHB: 0, DBN: 0 });
  assert.equal(o.trendFactor, 1);
  assert.deepEqual(o.dcs.CPT, [0, 0]);
  assert.equal(o.tsin, "—", "renders a dash, never 'undefined'");
  assert.equal(o.leadTime, "Disabled");
  assert.equal(o.storageEligible, false);
});
test("target stock comes from Python, not a second formula in JS", () => {
  // The Offer Details screen used to derive its own target from 30-day
  // sales. That ignored lead time, the payday multiplier, the trend factor
  // and the cover cap, and disagreed with the Send In beside it on 173 of
  // 418 offers. Null until migration 010 has run — the screen shows "—".
  const [o] = buildOffers([{ sku: "ABC", target_stock: 12, send_in_jhb: 4 }]);
  assert.equal(o.targetStock, 12);
  assert.equal(o.sendIn.JHB, 4);
  assert.equal(buildOffers([{ sku: "ABC" }])[0].targetStock, null);
});
test("target stock of 0 stays 0 and does not become null", () => {
  assert.equal(buildOffers([{ sku: "ABC", target_stock: 0 }])[0].targetStock, 0);
});
test("cover images are upgraded to https", () => {
  // Takealot stores these as http://. The app is https on Vercel, which
  // blocks http subresources as mixed content — the tile just stays empty,
  // with no error to notice.
  const [o] = buildOffers([{
    sku: "ABC",
    image_url: "http://takealot.s3.amazonaws.com/covers_images/abc/s.file",
  }]);
  assert.equal(o.imageUrl, "https://takealot.s3.amazonaws.com/covers_images/abc/s.file");
});
test("an offer with no cover image gives null, not the string 'null'", () => {
  assert.equal(buildOffers([{ sku: "ABC" }])[0].imageUrl, null);
  assert.equal(buildOffers([{ sku: "ABC", image_url: "" }])[0].imageUrl, null);
});
test("an https cover image is left alone", () => {
  const [o] = buildOffers([{ sku: "ABC", image_url: "https://x.com/a/s.file" }]);
  assert.equal(o.imageUrl, "https://x.com/a/s.file");
});
test("real Takealot offer fields surface on the Offers screen", () => {
  const [o] = buildOffers([{
    sku: "S1", title: "T", status: "Buyable", tsin: 96560113,
    offer_id: 223464905, date_created: "2025-06-30T14:29:11+02:00",
    storage_fee_eligible: true, leadtime_days: 5,
  }]);
  assert.equal(o.tsin, 96560113);
  assert.equal(o.offerId, 223464905);
  assert.equal(o.created, "2025-06-30 14:29");
  assert.equal(o.storageEligible, true);
  assert.equal(o.leadTime, "5 days");
});
test("storage_fee_eligible false stays false, not truthy", () => {
  const [o] = buildOffers([{ sku: "S1", storage_fee_eligible: false }]);
  assert.equal(o.storageEligible, false);
});

console.log("\nbuildReportDefs");
test("replenishment lists only SKUs needing stock, largest first", () => {
  const offers = buildOffers([
    { sku: "A", title: "A", send_in_jhb: 5 },
    { sku: "B", title: "B", send_in_jhb: 50 },
    { sku: "C", title: "C", send_in_jhb: 0 },
  ]);
  const defs = buildReportDefs(
    { offers, rawSales: [], rows: buildRows([], NOW) }, NOW
  );
  const rows = defs["Stock Replenishment"].rows;
  assert.equal(rows.length, 2, "the zero-send SKU is excluded");
  assert.equal(rows[0][0], "B");
  assert.equal(rows[0][3], 50);
});
test("weekly report always has 7 day rows", () => {
  const defs = buildReportDefs({ offers: [], rawSales: [], rows: buildRows([], NOW) }, NOW);
  assert.equal(defs["Weekly Report"].rows.length, 7);
});
test("empty data produces valid reports, not crashes", () => {
  const defs = buildReportDefs({ offers: [], rawSales: [], rows: buildRows([], NOW) }, NOW);
  for (const key of ["Stock Replenishment", "Weekly Report", "Monthly Report"]) {
    assert.ok(Array.isArray(defs[key].rows), `${key} rows`);
    assert.ok(defs[key].summary.every((l) => !String(l).includes("NaN")), `${key} has NaN`);
  }
});
test("weekly totals match the sales that went in", () => {
  const rawSales = prepareSales([
    sale("2026-08-15T08:00:00Z", { id: "a", quantity: 2, unit_price: 100 }),
    sale("2026-08-14T08:00:00Z", { id: "b", quantity: 1, unit_price: 300 }),
    sale("2026-08-14T09:00:00Z", { id: "c", quantity: 1, unit_price: 100, counts: false }),
  ]);
  const defs = buildReportDefs(
    { offers: [], rawSales, rows: buildRows(rawSales, NOW) }, NOW
  );
  const total = defs["Weekly Report"].rows.reduce((a, r) => a + r[3], 0);
  assert.equal(total, 500, "200 + 300; the cancelled 100 never sold");
});

const RET = (over = {}) => ({
  seller_return_id: 1, order_id: 900, rrn: "RRN-AAA", sku: "SKU1",
  tsin: 111, title: "Thing", qty: 1, warehouse_id: 3,
  return_date: "2026-08-15T08:00:00+02:00",
  reason: "Customer Cancellation", outcome: "Sellable stock",
  outcome_status: "sellable_stock",
  cover_image_url: "http://takealot.s3.amazonaws.com/covers_images/a/s.file",
  sale_reversed: 200, fees_credited: 50, net_value: -150,
  details_synced_at: "2026-09-09T00:00:00+02:00",
  ...over,
});
const SHIPPED = (over = {}) =>
  sale("2026-08-15T10:00:00Z", { status: "Shipped to Customer", ...over });

test("a cancellation is not a defect", () => {
  // The whole reason returns_cache exists. Counting cancellations as
  // returns made Elf Bar 9000 look like a quality problem when 135 of its
  // 145 returns were customers changing their minds.
  const rows = [
    RET({ seller_return_id: 1, qty: 3, reason: "Customer Cancellation" }),
    RET({ seller_return_id: 2, qty: 1, reason: "Defective or damaged" }),
    RET({ seller_return_id: 3, qty: 1, reason: "Failed delivery" }),
  ];
  const sales = prepareSales([SHIPPED({ sku: "SKU1", quantity: 95, unit_price: 10, line_total: 950 })]);
  const r = buildReturns(rows, sales);
  assert.equal(r.units, 5, "every returned unit");
  assert.equal(r.cancelUnits, 3);
  assert.equal(r.defectUnits, 1, "only the faulty one");
  assert.equal(r.otherUnits, 1, "failed delivery is neither");
  assert.equal(r.defectRate, 1.1, "1 faulty of 95 out — the SLA number");
  assert.ok(r.defectRate < r.rate, "the defect rate is the smaller, honest one");
});
test("returns rank by defects first, not by volume", () => {
  const rows = [
    RET({ seller_return_id: 1, sku: "POPULAR", qty: 20, reason: "Customer Cancellation" }),
    RET({ seller_return_id: 2, sku: "BROKEN", qty: 2, reason: "Defective or damaged" }),
  ];
  const sales = prepareSales([
    SHIPPED({ id: "a", sku: "POPULAR", quantity: 200, unit_price: 10, line_total: 2000 }),
    SHIPPED({ id: "b", sku: "BROKEN", quantity: 20, unit_price: 10, line_total: 200 }),
  ]);
  const r = buildReturns(rows, sales);
  assert.equal(r.products[0].sku, "BROKEN", "2 faults outrank 20 cancellations");
  assert.equal(r.products[0].defectRate, 10);
  assert.equal(r.products[1].defectUnits, 0);
  assert.equal(r.products[1].defectRate, 0, "cancellations do not raise a defect rate");
});
test("the money is the margin, not the sale", () => {
  const r = buildReturns([RET({ sale_reversed: 299, fees_credited: 76, net_value: -223 })], []);
  const [i] = r.items;
  assert.equal(i.saleReversed, 299);
  assert.equal(i.feesCredited, 76);
  assert.equal(i.netValue, -223, "both fees really do come back");
  assert.equal(r.value, 299);
  assert.equal(r.netValue, -223);
});
test("a removal order is flagged; sellable stock is not", () => {
  const r = buildReturns([
    RET({ seller_return_id: 1, outcome: "Sellable stock", outcome_status: "sellable_stock" }),
    RET({ seller_return_id: 2, outcome: "Removal Order", outcome_status: "removal_order" }),
    RET({ seller_return_id: 3, outcome: "Removal Order - Incorrect Product", outcome_status: "pending_removal_order" }),
  ], []);
  assert.equal(r.removals, 2, "only the removal orders are stock you must collect");
  assert.equal(r.items.find((x) => x.sellerReturnId === 1).removal, false);
});
test("warehouse ids become DC names", () => {
  const names = [3, 1, 6, 99].map((id) => buildReturns([RET({ warehouse_id: id })], []).items[0].warehouse);
  assert.deepEqual(names, ["JHB", "CPT", "DBN", "DC 99"], "1/3/6 per the API's own list");
});
test("cover images are upgraded to https here too", () => {
  const [i] = buildReturns([RET()], []).items;
  assert.ok(i.imageUrl.startsWith("https://"), "or the tile is blocked as mixed content");
  assert.equal(buildReturns([RET({ cover_image_url: null })], []).items[0].imageUrl, null);
});
test("a return whose details have not synced degrades instead of lying", () => {
  const [i] = buildReturns([RET({
    details_synced_at: null, comment: null, sale_reversed: null,
    fees_credited: null, net_value: null, sales_units_6m: null,
  })], []).items;
  assert.equal(i.hasDetails, false, "so the screen can say so rather than show zeros");
  assert.equal(i.saleReversed, 0);
  assert.equal(i.defectRate6m, null, "no six-month base means no rate, not 0%");
  assert.equal(i.comment, null);
});
test("no returns at all produces a valid shape, not a crash", () => {
  const r = buildReturns([], prepareSales([SHIPPED({ quantity: 5, unit_price: 10, line_total: 50 })]));
  assert.equal(r.lines, 0);
  assert.equal(r.defectRate, 0);
  assert.equal(r.sold, 5);
  assert.deepEqual(r.products, []);
  assert.deepEqual(r.byReason, []);
  assert.ok(Number.isFinite(r.rate));
});
test("a period with nothing shipped gives 0%, not Infinity or NaN", () => {
  const r = buildReturns([RET()], prepareSales([
    sale("2026-08-15T08:00:00Z", { quantity: 3, unit_price: 10, line_total: 30, status: "Preparing for Customer" }),
  ]));
  assert.equal(r.sold, 0, "nothing left the warehouse");
  assert.equal(r.defectRate, 0);
  assert.ok(Number.isFinite(r.rate));
  assert.equal(r.products[0].rate, null, "and the per-product rate says N/A rather than 0%");
});
test("isQualityReturn only counts the two product faults", () => {
  assert.equal(isQualityReturn("Defective or damaged"), true);
  assert.equal(isQualityReturn("Not what I ordered"), true);
  for (const r of ["Customer Cancellation", "Failed delivery", "Exception", "Changed my mind", null]) {
    assert.equal(isQualityReturn(r), false, r + " is not a product fault");
  }
});

const HIST = () => buildCostHistory([
  { sku: "A", valid_from: "2026-07-01", cost_incl_vat: 162 },
  { sku: "A", valid_from: "2026-09-01", cost_incl_vat: 159 },
  { sku: "B", valid_from: "2026-08-01", cost_incl_vat: 50 },
]);

test("a sale is priced at the cost in force on its own date", () => {
  // The whole point. Importing September's spreadsheet moved August's
  // gross profit from R125,702 to R139,240 on identical sales, because
  // every sale was priced at whatever sat in sku_costs right now.
  const h = HIST();
  const at = (d) => costAt(h, { cost_incl_vat: 999 }, "A", new Date(d)).cost_incl_vat;
  assert.equal(at("2026-07-15T10:00:00+02:00"), 162, "July");
  assert.equal(at("2026-08-31T23:59:00+02:00"), 162, "still August, still the old cost");
  assert.equal(at("2026-09-01T00:30:00+02:00"), 159, "the change applies from the 1st");
  assert.equal(at("2026-09-09T10:00:00+02:00"), 159, "September");
});
test("history is skipped when a SKU has none", () => {
  assert.equal(costAt(HIST(), { cost_incl_vat: 77 }, "UNKNOWN", new Date("2026-08-15")).cost_incl_vat, 77);
  assert.equal(costAt(new Map(), { cost_incl_vat: 77 }, "A", new Date("2026-08-15")).cost_incl_vat, 77);
});
test("a sale older than every change point uses the earliest known cost", () => {
  // The archive only reaches July 2026; February sales have no record of
  // what they actually cost. The oldest point beats today's price.
  const got = costAt(HIST(), { cost_incl_vat: 999 }, "A", new Date("2026-02-15T10:00:00+02:00"));
  assert.equal(got.cost_incl_vat, 162, "July's cost, not the current one");
});
test("valid_from is read as SAST midnight, not UTC", () => {
  // 01:30 SAST on the 1st is 23:30 UTC on the previous day. Parsed as UTC
  // this priced the first ninety minutes of every month at the old cost.
  const at = costAt(HIST(), null, "A", new Date("2026-09-01T01:30:00+02:00"));
  assert.equal(at.cost_incl_vat, 159);
});
test("a sale with no date falls back to the latest point", () => {
  assert.equal(costAt(HIST(), null, "A", null).cost_incl_vat, 159);
});
test("buildCostHistory sorts change points oldest first", () => {
  const h = buildCostHistory([
    { sku: "A", valid_from: "2026-09-01", cost_incl_vat: 159 },
    { sku: "A", valid_from: "2026-07-01", cost_incl_vat: 162 },
  ]);
  assert.deepEqual(h.get("A").map((p) => p.cost_incl_vat), [162, 159]);
});
test("rows missing a sku or date are dropped, not stored as undefined", () => {
  const h = buildCostHistory([
    { sku: "A", valid_from: null, cost_incl_vat: 1 },
    { sku: null, valid_from: "2026-07-01", cost_incl_vat: 2 },
  ]);
  assert.equal(h.size, 0);
});
test("the dashboard prices August at August's cost, not today's", () => {
  const sales = prepareSales([
    withFees("2026-08-15T08:00:00Z", { quantity: 1, unit_price: 300, line_total: 300, status: "Shipped to Customer" }),
  ]);
  const costs = new Map([["SKU1", { cost_incl_vat: 159, shipping_cost: 0 }]]);
  const hist = buildCostHistory([
    { sku: "SKU1", valid_from: "2026-07-01", cost_incl_vat: 162 },
    { sku: "SKU1", valid_from: "2026-09-01", cost_incl_vat: 159 },
  ]);
  const withHistory = buildRows(sales, NOW, null, costs, hist)[0];
  const withoutHistory = buildRows(sales, NOW, null, costs)[0];
  assert.equal(withHistory.cost, 162, "the cost in force in August");
  assert.equal(withoutHistory.cost, 159, "the old behaviour, for contrast");
  assert.equal(withHistory.profit, 300 - 55 - 162);
});
test("shipping cost stays current — it has no history", () => {
  const sales = prepareSales([
    withFees("2026-08-15T08:00:00Z", { quantity: 2, unit_price: 300, line_total: 600, status: "Shipped to Customer" }),
  ]);
  const costs = new Map([["SKU1", { cost_incl_vat: 100, shipping_cost: 20 }]]);
  const hist = buildCostHistory([{ sku: "SKU1", valid_from: "2026-07-01", cost_incl_vat: 90 }]);
  const r = buildRows(sales, NOW, null, costs, hist)[0];
  assert.equal(r.cost, 2 * (90 + 20), "July's product cost, today's shipping");
});
test("an order opened months later shows what it cost then", () => {
  const sales = prepareSales([sale("2026-08-15T08:00:00Z", { sku: "A", quantity: 2, unit_price: 200, line_total: 400 })]);
  const costs = new Map([["A", { title: "T", cost_incl_vat: 159, shipping_cost: 20 }]]);
  const hist = buildCostHistory([
    { sku: "A", valid_from: "2026-07-01", cost_incl_vat: 162 },
    { sku: "A", valid_from: "2026-09-01", cost_incl_vat: 159 },
  ]);
  const o = buildOrders(sales, costs, hist)[0];
  assert.equal(o.unitCost, 162, "August's cost");
  assert.equal(o.productCost, 324, "2 units at August's cost");
  assert.equal(o.deliveryCost, 40, "shipping still current, and still per line");
  assert.equal(o.title, "T", "fields with no history still come from sku_costs");
});

test("either spelling of a SKU resolves to one product", () => {
  assert.equal(canonicalSku("BLVK55K0022"), "BLVK55K002");
  assert.equal(canonicalSku("BLVK55K002"), "BLVK55K002", "the correct one is already canonical");
  assert.equal(canonicalSku("NSTY9K001"), "NSTY9K001", "everything else is untouched");
  assert.equal(canonicalSku(undefined), undefined);
});
test("a sale under the listing's misspelt SKU still finds its cost", () => {
  // The cost sheet only knows BLVK55K002. Before this, the sale's profit
  // read as pure revenue: R390 sold, no cost found, nothing on screen to
  // say so.
  const s = prepareSales([withFees("2026-08-15T08:00:00Z", {
    sku: "BLVK55K0022", quantity: 1, unit_price: 390, line_total: 390,
    status: "Shipped to Customer",
  })]);
  const costs = new Map([["BLVK55K002", { cost_incl_vat: 225, shipping_cost: 2 }]]);
  const r = buildRows(s, NOW, null, costs)[0];
  assert.equal(r.cost, 227, "225 product + 2 shipping, found under the other spelling");
  assert.equal(r.profit, 390 - 55 - 227);
});
test("cost history is found under either spelling too", () => {
  const hist = buildCostHistory([{ sku: "BLVK55K002", valid_from: "2026-07-01", cost_incl_vat: 225 }]);
  const got = costAt(hist, { cost_incl_vat: 999 }, "BLVK55K0022", new Date("2026-08-15T10:00:00+02:00"));
  assert.equal(got.cost_incl_vat, 225);
});
test("an order under either spelling prices the same", () => {
  const s = prepareSales([sale("2026-08-15T08:00:00Z", {
    sku: "BLVK55K0022", quantity: 2, unit_price: 390, line_total: 780,
  })]);
  const costs = new Map([["BLVK55K002", { title: "Peach Mango", cost_incl_vat: 225, shipping_cost: 2 }]]);
  const o = buildOrders(s, costs)[0];
  assert.equal(o.unitCost, 225);
  assert.equal(o.productCost, 450);
  assert.equal(o.deliveryCost, 4);
  assert.equal(o.sku, "BLVK55K0022", "the listing's own SKU is still what is displayed");
});
test("a rename does not split one product into two", () => {
  // The case this exists for. Sales before the listing is corrected carry
  // BLVK55K0022; sales after carry BLVK55K002. Grouped naively that is two
  // products, each with half the history.
  const rows = [
    { seller_return_id: 1, sku: "BLVK55K0022", qty: 1, title: "Peach Mango",
      reason: "Defective or damaged", outcome: "Removal Order", return_date: "2026-08-20T10:00:00+02:00", sale_reversed: 390 },
    { seller_return_id: 2, sku: "BLVK55K002", qty: 1, title: "Peach Mango",
      reason: "Defective or damaged", outcome: "Removal Order", return_date: "2026-09-20T10:00:00+02:00", sale_reversed: 390 },
  ];
  // A returned sale keeps a row in sales_cache with status "Returned", so
  // the fixture carries those too — they are part of what went out.
  const sales = prepareSales([
    sale("2026-08-10T08:00:00Z", { id: "a", sku: "BLVK55K0022", quantity: 5, unit_price: 390, line_total: 1950, status: "Shipped to Customer" }),
    sale("2026-09-10T08:00:00Z", { id: "b", sku: "BLVK55K002", quantity: 5, unit_price: 390, line_total: 1950, status: "Shipped to Customer" }),
    sale("2026-08-20T08:00:00Z", { id: "c", sku: "BLVK55K0022", quantity: 1, unit_price: 390, line_total: 390, status: "Returned" }),
    sale("2026-09-20T08:00:00Z", { id: "d", sku: "BLVK55K002", quantity: 1, unit_price: 390, line_total: 390, status: "Returned" }),
  ]);
  const r = buildReturns(rows, sales);
  assert.equal(r.products.length, 1, "one product, not two");
  assert.equal(r.products[0].sku, "BLVK55K002", "under the canonical name");
  assert.equal(r.products[0].defectUnits, 2, "both returns counted together");
  assert.equal(r.products[0].sold, 12, "10 shipped + the 2 that shipped and came back");
  assert.equal(r.products[0].defectRate, 16.7, "2 of 12, not 1 of 6 twice over");
});

console.log(
  `\n${failures.length ? `${failures.length} FAILURE(S): ${failures.join(", ")}` : `ALL ${passed} PASS`}\n`
);
process.exit(failures.length ? 1 : 0);
