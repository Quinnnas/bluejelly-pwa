/**
 * Ask Tim's endpoint guards.
 *
 * Two of these matter more than the rest: the endpoint must refuse anyone
 * who is not signed in, and it must never answer without a key. It is a
 * public URL that spends money on request — a crawler finding an open one
 * would be an expensive afternoon.
 *
 * The model call itself is not exercised here; that needs a real key and
 * is verified against the live endpoint instead.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import handler from "../api/ask-tim.js";

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  FAIL  ${name}\n        ${e.message}\n`);
  }
}

async function atest(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  FAIL  ${name}\n        ${e.message}\n`);
  }
}

/** Minimal stand-ins for what Vercel hands the handler. */
function mockRes() {
  const res = {
    statusCode: 200, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
  };
  return res;
}
const mockReq = (over = {}) => ({
  method: "POST", headers: {}, body: { messages: [{ role: "user", content: "hi" }] }, ...over,
});

const ORIGINAL = { ...process.env };
function withEnv(env, fn) {
  process.env = { ...ORIGINAL, ...env };
  return Promise.resolve(fn()).finally(() => { process.env = { ...ORIGINAL }; });
}

console.log("\nask-tim endpoint");

await atest("GET is refused — this endpoint only accepts POST", async () => {
  const res = mockRes();
  await handler(mockReq({ method: "GET" }), res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.Allow, "POST");
});

await atest("no API key means a clear 503, not a crash", async () => {
  await withEnv({ ANTHROPIC_API_KEY: "" }, async () => {
    const res = mockRes();
    await handler(mockReq(), res);
    assert.equal(res.statusCode, 503);
    assert.match(res.body.error, /ANTHROPIC_API_KEY/, "and it names the missing variable");
  });
});

await atest("a signed-out caller is refused before anything is spent", async () => {
  // No Authorization header, and Supabase config pointed nowhere: the
  // sign-in check must fail closed, not open.
  await withEnv({
    ANTHROPIC_API_KEY: "sk-test", SUPABASE_URL: "", SUPABASE_ANON_KEY: "",
    VITE_SUPABASE_URL: "", VITE_SUPABASE_ANON_KEY: "",
  }, async () => {
    const res = mockRes();
    await handler(mockReq(), res);
    assert.equal(res.statusCode, 401);
  });
});

await atest("a bad token is refused too", async () => {
  await withEnv({
    ANTHROPIC_API_KEY: "sk-test",
    SUPABASE_URL: "https://example.invalid", SUPABASE_ANON_KEY: "anon",
  }, async () => {
    const res = mockRes();
    await handler(mockReq({ headers: { authorization: "Bearer nonsense" } }), res);
    assert.equal(res.statusCode, 401, "an unreachable or rejecting auth server must fail closed");
  });
});

test("the key is never sent to the browser", () => {
  // The handler runs server-side; nothing in the client bundle may name it.
  const client = ["src/lib/askTim.js", "src/App.jsx"];
  for (const f of client) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    assert.ok(!src.includes("ANTHROPIC_API_KEY"), `${f} must not reference the API key`);
    assert.ok(!src.includes("api.anthropic.com"), `${f} must not call Anthropic directly`);
  }
});

console.log(
  `\n${failures.length ? `${failures.length} FAILURE(S): ${failures.join(", ")}` : `ALL ${passed} PASS`}\n`
);
process.exit(failures.length ? 1 : 0);
