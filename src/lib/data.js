/**
 * The Supabase query layer. All aggregation lives in aggregate.js (pure,
 * unit-tested); this file only fetches and hands rows over.
 *
 * The app never talks to Takealot directly — it reads caches that the
 * Python sync job fills:
 *
 *   offers_cache  <- sync_takealot.py   (one row per SKU)
 *   sales_cache   <- sync_takealot.py   (one row per order item)
 *   sku_costs     <- sync_sku_costs.py  (from the dashboard spreadsheet)
 *   targets       <- set by the owner
 */
import { supabase } from "./supabaseClient";
import {
  buildRecommendations,
  buildOffers,
  buildOrders,
  buildRows,
  buildSeries,
  prepareSales,
  sastMonthStart,
} from "./aggregate";

export { buildReportDefs } from "./aggregate";

// The widest bucket the dashboard shows is the previous calendar month,
// so that is as far back as it needs to read. sales_cache accumulates
// across runs — Takealot's own API only exposes a rolling 30 days, so
// older months exist only because earlier syncs saved them.
function historyStart(now) {
  return sastMonthStart(1, now);
}

// A guard against pulling an unbounded result set onto a phone. At ~5,000
// sales per 30 days this covers roughly a month; older buckets then
// under-report, which `partial` on each row already signals. Raise it
// only alongside a check that the phone can still hold the result.
const MAX_SALES_ROWS = 12000;

/**
 * Where the synced data actually begins — the oldest row in sales_cache.
 *
 * Not a fixed lookback: Takealot's API only exposes a rolling 30 days,
 * but sales_cache never deletes, so coverage grows every time the sync
 * runs. Asking the table is the only way to know the real boundary, and
 * it is what makes the "partial" flag on older periods truthful.
 */
async function fetchCoverageStart() {
  const { data, error } = await supabase
    .from("sales_cache")
    .select("order_date")
    .order("order_date", { ascending: true })
    .limit(1);
  if (error || !data || !data.length) return null;
  const d = new Date(data[0].order_date);
  return isNaN(d.getTime()) ? null : d;
}

const SALES_COLUMNS = [
  "order_item_id", "order_id", "order_date", "sku", "tsin", "offer_id",
  "product_title", "customer_dc", "order_dc", "quantity", "status",
  "counts_toward_velocity", "line_total", "unit_price", "customer_name",
  "success_fee", "fulfilment_fee", "courier_fee", "stock_transfer_fee",
  "total_fee",
].join(", ");

/**
 * Loads everything the app needs in four parallel queries.
 *
 * Never throws. A failure on any one table degrades that section to empty
 * rather than blanking the whole app, and the reason comes back in
 * `errors` so the UI can say something honest instead of showing zeros as
 * though they were real.
 */
/**
 * Every sale since `since`, paged past Supabase's row cap.
 *
 * PostgREST enforces a server-side maximum rows per response (1000 on
 * this project) and silently truncates — `.limit(5000)` still returns
 * 1000, with no error and no indication anything is missing. With ~5,000
 * sales in 30 days that made "Last 30 days" show about a week of trade
 * while looking entirely plausible.
 *
 * Steps by however many rows actually came back rather than by a assumed
 * page size, so a different server cap can't cause it to stop early.
 */
async function fetchAllSales(since) {
  const PAGE = 1000;
  const all = [];

  for (let guard = 0; guard < 25; guard++) {
    const { data, error } = await supabase
      .from("sales_cache")
      .select(SALES_COLUMNS)
      .gte("order_date", since)
      .order("order_date", { ascending: false })
      .range(all.length, all.length + PAGE - 1);

    if (error) return { data: all, error };
    if (!data || data.length === 0) break;

    all.push(...data);
    if (all.length >= MAX_SALES_ROWS) break;
  }

  return { data: all, error: null };
}

export async function loadStoreData(now = Date.now()) {
  const since = historyStart(now).toISOString();

  const [salesRes, offersRes, costsRes, targetsRes, coverageStart, recsRes] = await Promise.all([
    fetchAllSales(since),
    supabase.from("offers_cache").select("*").order("sku"),
    supabase.from("sku_costs").select("sku, title, cost_incl_vat, cost_excl_vat, min_price, max_price"),
    supabase.from("targets").select("period, sales_value"),
    fetchCoverageStart(),
    // Sales Ops. Only what the generator still considers true, worst
    // first. Undecided items lead; actioned ones stay visible below.
    supabase
      .from("sales_ops_recommendations")
      .select("*")
      .eq("is_current", true)
      .order("value_rand", { ascending: false })
      .limit(200),
  ]);

  const errors = {};
  if (salesRes.error) errors.sales = salesRes.error.message;
  if (offersRes.error) errors.offers = offersRes.error.message;
  if (costsRes.error) errors.costs = costsRes.error.message;
  // `targets` is the newest table — an error here usually just means
  // migration 005 hasn't been applied yet. The caller treats it as
  // non-fatal and falls back to the previously hardcoded targets.
  if (targetsRes.error) errors.targets = targetsRes.error.message;
  // Sales Ops is newest of all — a missing table just means migration 008
  // hasn't run. Non-fatal, same as targets.
  if (recsRes.error) errors.recommendations = recsRes.error.message;

  const rawSales = prepareSales(salesRes.data || []);
  const costsBySku = new Map((costsRes.data || []).map((c) => [c.sku, c]));

  const targets = {};
  for (const t of targetsRes.data || []) {
    targets[t.period] = typeof t.sales_value === "number" ? t.sales_value : 0;
  }

  const offers = buildOffers(offersRes.data || []);
  const lastSync = offers.reduce(
    (acc, o) => (o.syncedAt && (!acc || o.syncedAt > acc) ? o.syncedAt : acc),
    null
  );

  return {
    rows: buildRows(rawSales, now, coverageStart, costsBySku),
    series: buildSeries(rawSales, now),
    orders: buildOrders(rawSales, costsBySku),
    offers,
    // Kept so the report builders can re-bucket by real dates rather than
    // the display-formatted ones on `orders`.
    rawSales,
    targets,
    lastSync: lastSync ? new Date(lastSync).getTime() : null,
    recommendations: buildRecommendations(recsRes.data || []),
    counts: { sales: rawSales.length, offers: offers.length, costs: costsBySku.size },
    // True when the sync has genuinely never populated anything — the
    // difference between "no data yet" and "a quiet trading day".
    empty: rawSales.length === 0 && offers.length === 0,
    errors,
  };
}
