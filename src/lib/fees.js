/**
 * What Takealot takes on a vape sale.
 *
 * The rates here are NOT copied from Takealot's published rate card. They
 * were read off what Takealot actually charged this store: across 25,681
 * single-unit vape lines shipped since April 2026, the success fee was
 * 12.65% of the selling price on 99.98% of them, and the fulfilment fee
 * was R37.95 on all but six. Both agree exactly with the portal's own Fee
 * Estimator on a R269 vape (R34.03 and R37.95).
 *
 * **The fulfilment fee moves.** It was R48.30 through February 2026 and
 * R37.95 from April, with March a transition month. So this is a rate in
 * force now, not a constant of nature — if this screen ever disagrees
 * with the portal, re-derive it from `sales_cache` before assuming the
 * screen is broken. The query is a counter over `fulfilment_fee` for
 * single-unit shipped vape lines, grouped by month.
 *
 * Rates are stored EXCL VAT because that is the form Takealot quotes and
 * the form the VAT toggle needs; every incl-VAT figure is derived. Fees
 * from the API arrive incl VAT, matching the invoice.
 *
 * Vapes only, deliberately. The same query puts heaters and kettles at
 * R69.00 and gas cylinders at R51.75 — the fulfilment fee is a parcel
 * size tier, and this screen does not ask for dimensions. Pointing it at
 * a non-vape would quietly return the wrong number, which is worse than
 * not answering.
 *
 * Imports nothing, so Node can run the tests directly.
 */

export const VAT_RATE = 0.15;

/** 11% excl VAT -> 12.65% incl, on the full selling price. */
export const SUCCESS_FEE_RATE = 0.11;

/** R33.00 excl VAT -> R37.95 incl, flat per unit regardless of price. */
export const FULFILMENT_FEE_EXCL = 33.0;

/** When the rates above were last confirmed against charged fees. */
export const RATES_VERIFIED = "2026-10-09";

const num = (v) => {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return typeof n === "number" && isFinite(n) ? n : 0;
};

/** Two decimals, and never "-0.00". */
const money = (v) => {
  const r = Math.round(num(v) * 100) / 100;
  return r === 0 ? 0 : r;
};

export const inclVat = (exclAmount) => money(num(exclAmount) * (1 + VAT_RATE));
export const exclVat = (inclAmount) => money(num(inclAmount) / (1 + VAT_RATE));

/**
 * Takealot's cut and what is left, for one vape at one price.
 *
 * `sellingPrice` is the customer-facing price, which is VAT-inclusive —
 * the same number that goes in the portal's Selling Price box. Costs are
 * taken as VAT-inclusive too, because that is how `sku_costs` stores them
 * and how the spreadsheet is kept.
 *
 * Every component is rounded before the totals are derived, so the
 * displayed lines actually add up to the displayed total. Rounding each
 * line independently and then summing the unrounded values once made a
 * waterfall on the dashboard miss by a rand.
 */
export function estimateVapeFees({
  sellingPrice = 0,
  productCost = 0,
  dcShipping = 0,
  otherCosts = 0,
} = {}) {
  const price = money(Math.max(0, num(sellingPrice)));
  const successFee = money(price * SUCCESS_FEE_RATE * (1 + VAT_RATE));
  // Flat per unit: a R100 vape and a R600 vape are charged the same.
  const fulfilmentFee = price > 0 ? inclVat(FULFILMENT_FEE_EXCL) : 0;
  const fees = money(successFee + fulfilmentFee);
  const netSales = money(price - fees);

  const costs = money(
    Math.max(0, num(productCost)) +
      Math.max(0, num(dcShipping)) +
      Math.max(0, num(otherCosts))
  );
  const netProfit = money(netSales - costs);

  return {
    price,
    successFee,
    fulfilmentFee,
    fees,
    netSales,
    productCost: money(Math.max(0, num(productCost))),
    dcShipping: money(Math.max(0, num(dcShipping))),
    otherCosts: money(Math.max(0, num(otherCosts))),
    costs,
    netProfit,
    // Guarded: a blank price is the screen's opening state, and an
    // unguarded divide here renders "NaN%" across the whole panel.
    netMargin: price > 0 ? Math.round((netProfit / price) * 1000) / 10 : 0,
    // The share of the customer's money Takealot keeps. The number most
    // worth knowing and the one the portal never shows.
    feeShare: price > 0 ? Math.round((fees / price) * 1000) / 10 : 0,
  };
}

/**
 * The price at which this vape breaks even, given its costs.
 *
 * Solving price - 12.65%·price - R37.95 - costs = 0, because the
 * fulfilment fee is flat and does not scale with the price:
 *
 *     price = (costs + fulfilment) / (1 - successRate·(1 + VAT))
 */
export function breakEvenPrice({ productCost = 0, dcShipping = 0, otherCosts = 0 } = {}) {
  const costs =
    Math.max(0, num(productCost)) + Math.max(0, num(dcShipping)) + Math.max(0, num(otherCosts));
  const fulfilment = inclVat(FULFILMENT_FEE_EXCL);
  const retained = 1 - SUCCESS_FEE_RATE * (1 + VAT_RATE);
  if (retained <= 0) return 0;
  return money((costs + fulfilment) / retained);
}

/**
 * The price needed to clear a given margin, for "what should I charge?".
 *
 * Same solve with the target margin moved to the left:
 * price·(1 - successRate·(1+VAT) - margin) = costs + fulfilment.
 * Returns null when the margin is unreachable at any price — above about
 * 87% the success fee alone has eaten it, and a huge meaningless number
 * is worse than an honest blank.
 */
export function priceForMargin(targetMarginPct, costs = {}) {
  const margin = num(targetMarginPct) / 100;
  const total =
    Math.max(0, num(costs.productCost)) +
    Math.max(0, num(costs.dcShipping)) +
    Math.max(0, num(costs.otherCosts));
  const fulfilment = inclVat(FULFILMENT_FEE_EXCL);
  const retained = 1 - SUCCESS_FEE_RATE * (1 + VAT_RATE) - margin;
  if (retained <= 0.0001) return null;
  return money((total + fulfilment) / retained);
}
