/**
 * "Ask Tim" — the app's own Takealot expert.
 *
 * Runs as a Vercel serverless function, NOT in the browser, for one
 * non-negotiable reason: the Anthropic API key. Anything shipped to the
 * client is readable by anyone who opens devtools, and a leaked key is
 * someone else's bill. It lives only in Vercel's environment variables.
 *
 * The endpoint is also behind the app's existing login. Without that check
 * this is a public URL that spends money on request — a crawler finding it
 * would be an expensive afternoon.
 *
 * Env vars needed (Vercel -> Settings -> Environment Variables):
 *   ANTHROPIC_API_KEY   secret, server-side only
 *   SUPABASE_URL        may be the same value as VITE_SUPABASE_URL
 *   SUPABASE_ANON_KEY   may be the same value as VITE_SUPABASE_ANON_KEY
 */

const MODEL = "claude-sonnet-5";

// Cost and abuse guards. A long back-and-forth resends its whole history
// on every turn, so an uncapped thread gets expensive quietly.
const MAX_TOKENS = 1024;
const MAX_HISTORY = 12;      // messages, oldest dropped first
const MAX_CHARS = 4000;      // per message

// Attachments. Whitelisted rather than "whatever the client sent": this
// body is forwarded to a paid API, and an unbounded passthrough is an
// invitation to send something enormous or unexpected.
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
const DOC_TYPES = ["application/pdf"];
const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_BYTES = 3_750_000;   // ~5MB of base64
// Images are re-read on every turn, so an old screenshot keeps costing
// long after the conversation moved on. Keep them on the newest few
// messages and leave a note behind on the rest.
const KEEP_IMAGES_ON_LAST = 3;

const SYSTEM = `You are Tim, the Takealot expert built into the BlueJelly app.

BlueJelly is a seller dashboard for Blaas Baas / House of Hubbly, a South
African Takealot seller (mostly disposable vapes, pods and small
appliances). You answer questions about this app and about selling on
Takealot. Nothing else.

## Scope

If asked about anything unrelated — general coding, world affairs, personal
advice — say briefly that you only cover the BlueJelly app and Takealot
selling, and offer to help with that instead. Do not be preachy about it;
one sentence, then move on.

## How this app's numbers are defined

These are decisions, not accidents. Explain them as such.

- **Sales Value** counts every unit sold in the period, dispatched or not.
- **Money in the bank** and **Gross Profit** count SHIPPED units only, at
  fees Takealot has actually charged. They deliberately do not tie to Sales
  Value; the gap is shown on screen.
- **Prep** and **Ship** are disjoint: Prep + Ship = units sold. Prep is
  ordered but not yet dispatched. An order moves from Prep to Ship by
  itself when Takealot dispatches it.
- The dashboard EXCLUDES cancelled and returned orders. The Takealot seller
  portal includes them, so this app reads lower than the portal by design.
- **Landed cost** = the cost spreadsheet's cost incl VAT + the offer's
  "Cost to Ship to Takealot DC". Both per unit.
- A sale is priced at the cost **in force on its own order date**, not
  today's cost. Updating the spreadsheet no longer rewrites last month's
  profit. Cost history goes back to July 2026; older sales use July's cost.
- Fees from the Takealot API are VAT-inclusive.
- Not modelled: roughly R6,800/month of account-level Takealot charges
  (storage, subscription, stock loss, removal fees) that never appear in
  the sales API. "Money in the bank" is optimistic by about 0.4% for that
  reason. Say so if profit accuracy comes up.

## Returns

- Most returns are NOT quality problems. Across the archive, about 933 of
  1,110 are "Customer Cancellation" and about 988 come back as sellable
  stock that goes straight back on sale.
- The headline on the Returns screen is the **defect rate** — "Defective or
  damaged" plus "Not what I ordered", over units that went out. That is
  what Takealot's **7.5% SLA** measures. Cancellations do not count toward
  it.
- A return credits the sale back AND both fees (success and fulfilment), so
  a return costs the margin, not the sale.
- **Sellable stock** goes back on sale. A **Removal Order** means the stock
  must be collected — that is the outcome that is an actual loss.
- The return rate's denominator is everything that left the warehouse,
  which includes the returned units themselves.

## Offers

- The Offers tab defaults to **Active**, which excludes disabled listings.
  Active = Buyable + Not Buyable. The Disabled chip still reaches them.
- **Send In** and **Target Stock** come from the sync's payday-aware
  replenishment formula, which accounts for lead time, a payday multiplier,
  a trend factor, a cover cap and stock already on the way. It is not
  simply "30 days of sales minus stock".
- Distribution centres are CPT (Cape Town), JHB (Johannesburg) and DBN
  (Durban).

## How data gets in

- A sync runs every 15 minutes: sales, offers, returns, and a check of the
  cost spreadsheet on the Desktop.
- A deeper job runs nightly at 03:30: six months of sales re-read, per-offer
  shipping costs, and per-return details.
- It runs on the office PC, not in the cloud, because Takealot's API refuses
  requests from cloud IP addresses.
- So figures can be up to 15 minutes behind. "Sync now" forces a refresh.

## Attachments

The user can send screenshots, photos and PDFs. Expect app screenshots,
seller-portal screenshots, Takealot invoices and remittances, product
photos, and packaging or stock photos.

Read them and answer the question asked. Where a screenshot shows figures
that ought to match this app, say plainly whether they do and why they
might not — the dashboard excludes cancellations and returns, so it reads
lower than the seller portal by design.

If an attachment has nothing to do with Takealot or this app, say so in a
sentence and ask what they wanted to know. Do not describe it at length.
Never guess at a number that is illegible; ask for a clearer shot.

## Style

Be direct and concrete. Use the user's actual numbers when they are in the
context provided. Short paragraphs, plain English, rands as "R1,234".
If you genuinely do not know something about their account or the app, say
so rather than guessing — a confident wrong answer about money is worse
than "I'm not sure".
You are talking to the person who owns the store, so assume commercial
literacy but not technical knowledge of the app's internals.`;

/**
 * Accepts either a plain string or Anthropic's content blocks, keeping
 * only blocks we recognise. Anything else is dropped rather than
 * forwarded — the client is trusted to be our own app, but this endpoint
 * is reachable by anyone with a session.
 */
function sanitiseContent(content) {
  if (typeof content === "string") return content.slice(0, MAX_CHARS);
  if (!Array.isArray(content)) return null;

  const blocks = [];
  let attachments = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;

    if (block.type === "text" && typeof block.text === "string") {
      blocks.push({ type: "text", text: block.text.slice(0, MAX_CHARS) });
      continue;
    }

    const isImage = block.type === "image";
    const isDoc = block.type === "document";
    if (!isImage && !isDoc) continue;
    if (attachments >= MAX_ATTACHMENTS) continue;

    const src = block.source || {};
    const allowed = isImage ? IMAGE_TYPES : DOC_TYPES;
    if (src.type !== "base64" || !allowed.includes(src.media_type)) continue;
    if (typeof src.data !== "string" || src.data.length > MAX_ATTACHMENT_BYTES) continue;

    attachments += 1;
    blocks.push({
      type: block.type,
      source: { type: "base64", media_type: src.media_type, data: src.data },
    });
  }
  return blocks.length ? blocks : null;
}

/** Replace attachments on older turns with a note, to stop paying for them. */
function stripOldAttachments(messages) {
  const cutoff = messages.length - KEEP_IMAGES_ON_LAST;
  return messages.map((m, i) => {
    if (i >= cutoff || typeof m.content === "string") return m;
    const kept = m.content.filter((c) => c.type === "text");
    const dropped = m.content.length - kept.length;
    if (!dropped) return { ...m, content: kept.length ? kept : "" };
    return {
      ...m,
      content: [
        ...kept,
        { type: "text", text: `[${dropped} earlier attachment${dropped > 1 ? "s" : ""} not re-sent]` },
      ],
    };
  });
}

function readBody(req) {
  if (req.body && typeof req.body === "object") return Promise.resolve(req.body);
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

/** Confirms the caller is signed into the app before spending anything. */
async function isSignedIn(token) {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anon || !token) return false;
  try {
    const r = await fetch(`${url.replace(/\/$/, "")}/auth/v1/user`, {
      headers: { apikey: anon, Authorization: `Bearer ${token}` },
    });
    return r.ok;
  } catch {
    return false;
  }
}

/** A compact snapshot of what the user is looking at, so answers are concrete. */
function describeContext(ctx) {
  if (!ctx || typeof ctx !== "object") return "";
  const lines = [];
  if (Array.isArray(ctx.rows)) {
    lines.push("Dashboard right now:");
    for (const r of ctx.rows.slice(0, 6)) {
      lines.push(
        `  ${r.label}: ${r.qty} units sold, R${r.value} sales value, ` +
        `R${r.profit} gross profit, ${r.prep} preparing, ${r.ship} shipped`
      );
    }
  }
  if (ctx.returns) {
    const r = ctx.returns;
    lines.push(
      `Returns this period: ${r.lines} returns, ${r.units} units ` +
      `(${r.defectUnits} faulty, ${r.cancelUnits} cancelled), ` +
      `defect rate ${r.defectRate}% against a 7.5% SLA, ${r.removals} removal orders.`
    );
  }
  if (ctx.offers) {
    lines.push(
      `Offers: ${ctx.offers.total} total, ${ctx.offers.buyable} buyable, ` +
      `${ctx.offers.disabled} disabled.`
    );
  }
  if (ctx.lastSync) lines.push(`Last sync: ${ctx.lastSync}.`);
  if (!lines.length) return "";
  return `\n\nHere is the user's live data, for reference. Use it when relevant; do not recite it back wholesale.\n${lines.join("\n")}`;
}

// Exported for tests only. These two decide what reaches a paid API, so
// they are worth pinning directly rather than through the whole handler.
export const __test = { sanitiseContent, stripOldAttachments };

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST." });
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    // "It's missing" is not much help when the variable has been set but
    // is not arriving. Report which Anthropic-ish NAMES the function can
    // actually see — names only, never values — which distinguishes a
    // typo from a variable saved to the wrong Vercel environment.
    const names = Object.keys(process.env);
    const seen = names.filter((k) => /anthropic|claude/i.test(k)).sort();
    // The discriminator. Vercel hands functions every project variable,
    // VITE_-prefixed ones included. If the Supabase vars ARE visible then
    // project variables do reach this function and only the Anthropic one
    // is absent — a wrong name, or never saved. If they are NOT visible,
    // no project variables are reaching it at all, which means the key was
    // added to a different Vercel project than the one serving this domain.
    const projectVarsVisible = names.filter((k) => /^VITE_SUPABASE/.test(k)).sort();
    return res.status(503).json({
      error: "Tim isn't configured yet — ANTHROPIC_API_KEY is missing from the server's environment variables.",
      diagnostic: seen.length
        ? `Close: the function can see ${seen.join(", ")}, but not the exact name ANTHROPIC_API_KEY.`
        : projectVarsVisible.length
          ? `This project's own variables DO reach the function (${projectVarsVisible.join(", ")}), but there is no Anthropic one. So the name is wrong, or it was never saved — it is not a Production-tick problem.`
          : "No project variables reach this function at all — not even the Supabase ones. The key was almost certainly added to a different Vercel project than the one serving bluejelly-pwa.vercel.app.",
    });
  }

  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!(await isSignedIn(token))) {
    return res.status(401).json({ error: "Sign in to ask Tim." });
  }

  let body;
  try {
    body = await readBody(req);
  } catch {
    return res.status(400).json({ error: "Malformed request." });
  }

  const incoming = Array.isArray(body.messages) ? body.messages : [];
  const messages = stripOldAttachments(
    incoming
      .filter((m) => m && (m.role === "user" || m.role === "assistant"))
      .map((m) => ({ role: m.role, content: sanitiseContent(m.content) }))
      .filter((m) => m.content !== null && m.content !== "")
      .slice(-MAX_HISTORY)
  );

  if (!messages.length || messages[messages.length - 1].role !== "user") {
    return res.status(400).json({ error: "Nothing to answer." });
  }

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM + describeContext(body.context),
        messages,
      }),
    });

    if (!r.ok) {
      const detail = await r.text();
      console.error("Anthropic error", r.status, detail.slice(0, 500));
      // Don't leak the upstream body to the client; it can echo the request.
      const friendly =
        r.status === 401 ? "Tim's API key was rejected. Check ANTHROPIC_API_KEY."
        : r.status === 429 ? "Tim is rate limited right now. Try again in a moment."
        : "Tim couldn't answer just then. Try again.";
      return res.status(502).json({ error: friendly });
    }

    const data = await r.json();
    const reply = (data.content || [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();

    return res.status(200).json({
      reply: reply || "I didn't get that — try asking another way.",
      usage: data.usage || null,
    });
  } catch (e) {
    console.error("ask-tim failed", e);
    return res.status(502).json({ error: "Tim couldn't be reached. Try again." });
  }
}
