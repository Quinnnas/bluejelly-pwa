import { supabase } from "./supabaseClient";

/**
 * Talks to the Ask Tim endpoint.
 *
 * The Anthropic key lives only on the server, so this posts to our own
 * /api/ask-tim rather than to Anthropic directly. The user's Supabase
 * access token goes along so the function can confirm they are signed in
 * before it spends anything.
 */
export async function askTim(messages, context) {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  if (!token) {
    return { error: "You've been signed out. Sign in again to ask Tim." };
  }

  let res;
  try {
    res = await fetch("/api/ask-tim", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ messages, context }),
    });
  } catch {
    return { error: "No connection. Tim needs the network — unlike the rest of the app, he can't work offline." };
  }

  // A 404 here almost always means `npm run dev` without the dev API
  // bridge, or a deploy where the function didn't build.
  if (res.status === 404) {
    return { error: "Tim's endpoint isn't there. If this is the live site, check that the api/ folder deployed." };
  }

  let body = {};
  try {
    body = await res.json();
  } catch {
    return { error: "Tim sent something unreadable. Try again." };
  }

  if (!res.ok) return { error: body.error || "Tim couldn't answer just then." };
  return { reply: body.reply };
}

/**
 * The slice of live data Tim gets with each question.
 *
 * Deliberately small: a handful of totals rather than thousands of rows.
 * It costs tokens on every message, and Tim needs the shape of the
 * business, not its entire ledger.
 */
export function timContext(data) {
  if (!data) return {};
  const offers = data.offers || [];
  const r = data.returns || {};
  return {
    rows: (data.rows || []).map((row) => ({
      label: row.label,
      qty: row.qty,
      value: row.value,
      profit: row.profit,
      prep: row.preparingQty,
      ship: row.shippedQty,
    })),
    returns: {
      lines: r.lines, units: r.units, defectUnits: r.defectUnits,
      cancelUnits: r.cancelUnits, defectRate: r.defectRate, removals: r.removals,
    },
    offers: {
      total: offers.length,
      buyable: offers.filter((o) => o.status === "buyable").length,
      disabled: offers.filter((o) => o.status === "disabled").length,
    },
    lastSync: data.lastSync ? new Date(data.lastSync).toISOString() : null,
  };
}

/** Openers, so the first screen isn't an empty box. */
export const TIM_SUGGESTIONS = [
  "Why is Gross Profit lower than Sales Value?",
  "What counts as a defect return?",
  "How is Send In calculated?",
  "Why don't my numbers match the seller portal?",
];
