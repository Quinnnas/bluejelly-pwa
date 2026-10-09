/**
 * The vape fee estimator. Run from bluejelly-pwa:
 *
 *     node tests/fees.test.mjs
 *
 * The anchor case is the seller portal's own Fee Estimator on a R269
 * vape, screenshotted from the portal: success R34.03, fulfilment R37.95,
 * net sales R197.02, and with a R158 product cost a net profit of R39.02
 * at 14.5%, or R37.02 at 13.8% once R2 of DC shipping is added. If this
 * file goes red, the screen is lying about money.
 */
import assert from "node:assert/strict";
import {
  estimateVapeFees,
  breakEvenPrice,
  priceForMargin,
  inclVat,
  exclVat,
  SUCCESS_FEE_RATE,
  FULFILMENT_FEE_EXCL,
  VAT_RATE,
} from "../src/lib/fees.js";

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`  [PASS] ${label}`);
  } catch (e) {
    failures += 1;
    console.log(`  [FAIL] ${label}\n         ${e.message.split("\n")[0]}`);
  }
}

console.log("\n=== the portal's own worked example (R269 vape) ===");

const portal = estimateVapeFees({ sellingPrice: 269, productCost: 158 });

check("success fee matches the portal exactly", () =>
  assert.equal(portal.successFee, 34.03)
);
check("fulfilment fee matches the portal exactly", () =>
  assert.equal(portal.fulfilmentFee, 37.95)
);
check("net sales matches the portal exactly", () => assert.equal(portal.netSales, 197.02));
check("net profit matches the portal (leadtime column)", () =>
  assert.equal(portal.netProfit, 39.02)
);
check("net margin matches the portal (14.5%)", () => assert.equal(portal.netMargin, 14.5));

const inStock = estimateVapeFees({ sellingPrice: 269, productCost: 158, dcShipping: 2 });
check("in-stock column: R2 of DC shipping gives R37.02", () =>
  assert.equal(inStock.netProfit, 37.02)
);
check("in-stock column: 13.8% margin", () => assert.equal(inStock.netMargin, 13.8));

console.log("\n=== the rates themselves ===");

// Derived from 25,681 charged vape lines, not from a rate card.
check("success fee is 11% excl VAT", () => assert.equal(SUCCESS_FEE_RATE, 0.11));
check("...which is 12.65% incl VAT", () =>
  assert.equal(Math.round(SUCCESS_FEE_RATE * (1 + VAT_RATE) * 10000) / 100, 12.65)
);
check("fulfilment is R33 excl VAT", () => assert.equal(FULFILMENT_FEE_EXCL, 33));
check("...which is R37.95 incl VAT", () => assert.equal(inclVat(FULFILMENT_FEE_EXCL), 37.95));
check("exclVat reverses inclVat", () => assert.equal(exclVat(37.95), 33));

// The fulfilment fee is flat. This is the property that makes cheap vapes
// disproportionately bad and is the whole reason a floor price exists.
check("fulfilment fee does not scale with price", () => {
  const cheap = estimateVapeFees({ sellingPrice: 100 });
  const dear = estimateVapeFees({ sellingPrice: 600 });
  assert.equal(cheap.fulfilmentFee, dear.fulfilmentFee);
});
check("...so the fee share is far worse on a cheap vape", () => {
  const cheap = estimateVapeFees({ sellingPrice: 100 });
  const dear = estimateVapeFees({ sellingPrice: 600 });
  assert.ok(cheap.feeShare > dear.feeShare + 15, `${cheap.feeShare} vs ${dear.feeShare}`);
});

console.log("\n=== the lines add up ===");

// Rounding each line independently and summing the unrounded values made
// a dashboard waterfall miss by a rand. Components are rounded first.
check("fees = success + fulfilment", () => {
  const r = estimateVapeFees({ sellingPrice: 437.5 });
  assert.equal(r.fees, Math.round((r.successFee + r.fulfilmentFee) * 100) / 100);
});
check("net sales = price - fees, to the cent", () => {
  for (const p of [99.99, 123.45, 269, 333.33, 1234.56]) {
    const r = estimateVapeFees({ sellingPrice: p });
    assert.equal(r.netSales, Math.round((r.price - r.fees) * 100) / 100, `price ${p}`);
  }
});
check("net profit = net sales - every cost", () => {
  const r = estimateVapeFees({
    sellingPrice: 390,
    productCost: 158,
    dcShipping: 30,
    otherCosts: 12.5,
  });
  assert.equal(r.costs, 200.5);
  assert.equal(r.netProfit, Math.round((r.netSales - r.costs) * 100) / 100);
});

console.log("\n=== the states a real screen is actually in ===");

// A blank price is how the panel opens. An unguarded divide here renders
// "NaN%" across the whole thing, which has blanked this app before.
check("no input at all -> zeroes, not NaN", () => {
  const r = estimateVapeFees();
  for (const [k, v] of Object.entries(r)) assert.ok(Number.isFinite(v), `${k} is ${v}`);
  assert.equal(r.netMargin, 0);
  assert.equal(r.fulfilmentFee, 0);
});
check("empty strings from the inputs -> zeroes", () => {
  const r = estimateVapeFees({ sellingPrice: "", productCost: "", dcShipping: "" });
  assert.ok(Number.isFinite(r.netMargin));
  assert.equal(r.price, 0);
});
check("numeric strings are accepted, since inputs give strings", () => {
  assert.deepEqual(
    estimateVapeFees({ sellingPrice: "269", productCost: "158" }),
    estimateVapeFees({ sellingPrice: 269, productCost: 158 })
  );
});
check("garbage text -> zeroes rather than NaN", () => {
  const r = estimateVapeFees({ sellingPrice: "abc", productCost: "R158" });
  assert.ok(Number.isFinite(r.netProfit));
  assert.equal(r.price, 0);
});
check("negatives are floored at zero, not propagated", () => {
  const r = estimateVapeFees({ sellingPrice: -269, productCost: -158 });
  assert.equal(r.price, 0);
  assert.equal(r.productCost, 0);
});

// Selling below cost is a real case here: ARF001 was cleared at a loss on
// purpose, and the screen must show the loss rather than hide it.
check("a loss is reported as a negative profit and margin", () => {
  const r = estimateVapeFees({ sellingPrice: 200, productCost: 180 });
  assert.ok(r.netProfit < 0, `got ${r.netProfit}`);
  assert.ok(r.netMargin < 0, `got ${r.netMargin}`);
});
check("no -0.00 anywhere", () => {
  const r = estimateVapeFees({ sellingPrice: 0, productCost: 0 });
  assert.ok(!Object.is(r.netProfit, -0));
});

console.log("\n=== break-even and target pricing ===");

check("break-even price yields a profit of zero", () => {
  const costs = { productCost: 158, dcShipping: 2 };
  const p = breakEvenPrice(costs);
  const r = estimateVapeFees({ sellingPrice: p, ...costs });
  assert.ok(Math.abs(r.netProfit) <= 0.01, `profit ${r.netProfit} at price ${p}`);
});
check("break-even covers the flat fee even at zero cost", () => {
  const p = breakEvenPrice({});
  assert.ok(p > 37.95, `${p} must exceed the fulfilment fee alone`);
});
check("priceForMargin hits the margin it was asked for", () => {
  const costs = { productCost: 158, dcShipping: 2 };
  for (const target of [5, 10, 14.5, 25, 40]) {
    const p = priceForMargin(target, costs);
    const r = estimateVapeFees({ sellingPrice: p, ...costs });
    assert.ok(Math.abs(r.netMargin - target) <= 0.11, `asked ${target}, got ${r.netMargin}`);
  }
});
check("an unreachable margin returns null, not a vast number", () => {
  assert.equal(priceForMargin(95, { productCost: 158 }), null);
  assert.equal(priceForMargin(87.35, { productCost: 158 }), null);
});
check("a reachable margin just under the ceiling still works", () => {
  assert.ok(priceForMargin(80, { productCost: 158 }) > 0);
});

console.log(
  failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`
);
process.exit(failures === 0 ? 0 : 1);
