import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { handle } from "../src/relay.js";
import { resetCache } from "../src/fcm.js";
import { base64UrlEncode } from "../src/seal.js";

const { privateKey, publicKey } = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true, ["sign", "verify"]);
const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", privateKey));
const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(pkcs8).toString("base64")}\n-----END PRIVATE KEY-----\n`;

const env = {
  SEAL_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
  FCM_SERVICE_ACCOUNT: JSON.stringify({
    type: "service_account", project_id: "mahogsm-test", client_email: "relay@mahogsm-test.iam.gserviceaccount.com",
    private_key: pem, token_uri: "https://oauth.test/token",
  }),
};

/** A fake Google: checks the signed assertion and records FCM sends. */
function google({ sendStatus = 200, sendBody = {} } = {}) {
  const calls = { token: 0, sends: [] };
  const fetch = async (url, init) => {
    if (url === "https://oauth.test/token") {
      calls.token++;
      const assertion = new URLSearchParams(init.body.toString()).get("assertion");
      const [header, claims, signature] = assertion.split(".");
      const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey,
        Buffer.from(signature, "base64url"), new TextEncoder().encode(`${header}.${claims}`));
      const parsed = JSON.parse(Buffer.from(claims, "base64url"));
      if (!valid || parsed.scope !== "https://www.googleapis.com/auth/firebase.messaging") return new Response("{}", { status: 400 });
      return Response.json({ access_token: "access-1", expires_in: 3599 });
    }
    assert.equal(url, "https://fcm.googleapis.com/v1/projects/mahogsm-test/messages:send");
    assert.equal(init.headers.authorization, "Bearer access-1");
    calls.sends.push(JSON.parse(init.body));
    return Response.json(sendBody, { status: sendStatus });
  };
  return { calls, fetch };
}

async function register(token = "fcm-device-token") {
  const response = await handle(new Request("https://kyubey.test/v1/register", {
    method: "POST", body: JSON.stringify({ token }),
  }), env);
  assert.equal(response.status, 200);
  return (await response.json()).endpoint;
}

function wake(endpoint, body, deps, headers = {}) {
  return handle(new Request(endpoint, { method: "POST", body: JSON.stringify(body), headers }), env, deps);
}

beforeEach(() => resetCache());

test("an endpoint wakes its device with a fixed, content-free message", async () => {
  const endpoint = await register();
  assert.match(endpoint, /^https:\/\/kyubey\.test\/v1\/w\/[A-Za-z0-9_-]+$/);
  assert.ok(!endpoint.includes("fcm-device-token"), "the token is sealed");
  const g = google();
  const deviceId = "6020d447-2e24-476c-90ad-6cbb07ed8914";
  const response = await wake(endpoint, { kind: "call", device_id: deviceId, number: "+1555", text: "hi" }, { fetch: g.fetch, now: () => 0 });
  assert.equal(response.status, 201);
  const [sent] = g.calls.sends;
  assert.equal(sent.validate_only, false);
  assert.equal(sent.message.token, "fcm-device-token");
  assert.deepEqual(sent.message.data, { type: "sync", v: "1", kind: "call", device_id: deviceId });
  assert.equal(sent.message.android.priority, "HIGH");
  assert.equal(sent.message.android.ttl, "60s");
  assert.equal(sent.message.notification, undefined);
  assert.equal(response.headers.get("kyubey-wire"), "1,2");
});

test("wire 2 forwards identifiers as strings and drops everything else", async () => {
  const endpoint = await register();
  const g = google();
  const deviceId = "6020d447-2e24-476c-90ad-6cbb07ed8914";
  const callId = "0b7a3c2e-8f4d-4e1a-9c6b-2d5e8f1a3b7c";
  const response = await wake(endpoint, {
    v: 2, kind: "call", device_id: deviceId, wake_id: "call-event-187", call_id: callId,
    revision: 4, endpoint_generation: 2, number: "+1555", url: "https://elsewhere.test",
  }, { fetch: g.fetch });
  assert.equal(response.status, 201);
  assert.deepEqual(g.calls.sends[0].message.data, {
    type: "sync", v: "2", kind: "call", device_id: deviceId, wake_id: "call-event-187",
    call_id: callId, revision: "4", endpoint_generation: "2",
  });
});

test("wire 1 ignores wire 2 fields, so older phones keep getting what they understand", async () => {
  const endpoint = await register();
  const g = google();
  await wake(endpoint, { kind: "sms", wake_id: "sms-event-9", revision: 3 }, { fetch: g.fetch });
  assert.deepEqual(g.calls.sends[0].message.data, { type: "sync", v: "1", kind: "sms" });
});

test("TTL and Urgency headers set FCM's TTL, less the relay's own time, and priority", async () => {
  const endpoint = await register();
  const g = google();
  let clock = 1_000_000;
  const deps = { fetch: async (url, init) => { clock += 250; return g.fetch(url, init); }, now: () => clock };
  await wake(endpoint, { v: 2, kind: "call" }, deps, { TTL: "18", Urgency: "high" });
  await wake(endpoint, { v: 2, kind: "sms" }, deps, { ttl: "86400", urgency: "normal" });
  await wake(endpoint, { v: 2, kind: "sms" }, deps, { ttl: "0", urgency: "very-low" });
  const [call, sms, now] = g.calls.sends.map((sent) => sent.message.android);
  // The first wake-up also signs in: one more round trip comes off its TTL.
  assert.deepEqual(call, { priority: "HIGH", ttl: "17.75s" });
  assert.deepEqual(sms, { priority: "NORMAL", ttl: "86400s" });
  assert.deepEqual(now, { priority: "NORMAL", ttl: "0s" });
});

test("a message whose TTL runs out in the relay is not sent", async () => {
  const endpoint = await register();
  const g = google();
  let clock = 0;
  const deps = { fetch: async (url, init) => { clock += 2_000; return g.fetch(url, init); }, now: () => clock };
  const response = await wake(endpoint, { v: 2, kind: "call" }, deps, { ttl: "1" });
  assert.equal(response.status, 504);
  assert.equal(g.calls.sends.length, 0);
});

test("malformed wire 2 fields and delivery headers are refused before anything is sent", async () => {
  const endpoint = await register();
  const g = google();
  const callId = "0b7a3c2e-8f4d-4e1a-9c6b-2d5e8f1a3b7c";
  for (const body of [
    { v: 3, kind: "sms" },
    { v: "2", kind: "sms" },
    { v: 2, kind: "sms", call_id: callId },
    { v: 2, kind: "call", call_id: "not-a-uuid" },
    { v: 2, kind: "call", wake_id: "has space" },
    { v: 2, kind: "call", wake_id: "x".repeat(65) },
    { v: 2, kind: "call", revision: -1 },
    { v: 2, kind: "call", revision: 1.5 },
    { v: 2, kind: "call", endpoint_generation: 0 },
    { v: 2, kind: "call", endpoint_generation: "2" },
  ]) {
    assert.equal((await wake(endpoint, body, { fetch: g.fetch })).status, 400, JSON.stringify(body));
  }
  for (const headers of [{ ttl: "-1" }, { ttl: "1.5" }, { ttl: "99999999" }, { urgency: "urgent" }]) {
    assert.equal((await wake(endpoint, { v: 2, kind: "call" }, { fetch: g.fetch }, headers)).status, 400, JSON.stringify(headers));
  }
  assert.equal(g.calls.sends.length, 0);
});

test("check validates without delivering, and the access token is reused", async () => {
  const endpoint = await register();
  const g = google();
  assert.equal((await wake(endpoint, { kind: "check" }, { fetch: g.fetch })).status, 201);
  assert.equal((await wake(endpoint, { kind: "sms" }, { fetch: g.fetch })).status, 201);
  assert.equal(g.calls.sends[0].validate_only, true);
  assert.equal(g.calls.sends[1].validate_only, false);
  assert.equal(g.calls.token, 1);
});

test("a forgotten or foreign token answers 410 so the node drops the endpoint", async () => {
  const endpoint = await register();
  for (const errorCode of ["UNREGISTERED", "SENDER_ID_MISMATCH"]) {
    resetCache();
    const g = google({ sendStatus: errorCode === "UNREGISTERED" ? 404 : 403, sendBody: { error: { status: "X", details: [{ errorCode }] } } });
    assert.equal((await wake(endpoint, { kind: "sms" }, { fetch: g.fetch })).status, 410);
  }
});

test("refused relay credentials and outages are not blamed on the device", async () => {
  const endpoint = await register();
  const refused = google({ sendStatus: 403, sendBody: { error: { status: "PERMISSION_DENIED" } } });
  assert.equal((await wake(endpoint, { kind: "sms" }, { fetch: refused.fetch })).status, 502);
  resetCache();
  const down = google({ sendStatus: 503, sendBody: { error: { status: "UNAVAILABLE" } } });
  const response = await wake(endpoint, { kind: "sms" }, { fetch: down.fetch });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "30");
});

test("forged endpoints and bad requests are refused before anything is sent", async () => {
  const g = google();
  const forged = `https://kyubey.test/v1/w/${base64UrlEncode(crypto.getRandomValues(new Uint8Array(80)))}`;
  assert.equal((await wake(forged, { kind: "sms" }, { fetch: g.fetch })).status, 404);
  const endpoint = await register();
  assert.equal((await wake(endpoint, { kind: "notification" }, { fetch: g.fetch })).status, 400);
  assert.equal((await wake(endpoint, { kind: "sms", device_id: "not-a-uuid" }, { fetch: g.fetch })).status, 400);
  assert.equal(g.calls.sends.length, 0);
  const missing = await handle(new Request("https://kyubey.test/v1/register", { method: "POST", body: "{}" }), env);
  assert.equal(missing.status, 400);
  const get = await handle(new Request(endpoint), env);
  assert.equal(get.status, 405);
});

test("a rate-limited endpoint is told to slow down", async () => {
  const endpoint = await register();
  const limited = { ...env, RATE_LIMITER: { limit: async () => ({ success: false }) } };
  const response = await handle(new Request(endpoint, { method: "POST", body: '{"kind":"sms"}' }), limited, { fetch: google().fetch });
  assert.equal(response.status, 429);
});

test("SMS hints and calls draw on separate rate limits", async () => {
  const endpoint = await register();
  const used = new Map();
  const limiter = { limit: async ({ key }) => {
    used.set(key, (used.get(key) ?? 0) + 1);
    return { success: used.get(key) <= 2 };
  } };
  const limited = { ...env, RATE_LIMITER: limiter };
  const post = (kind) => handle(new Request(endpoint, { method: "POST", body: JSON.stringify({ kind }) }), limited, { fetch: google().fetch });
  for (let i = 0; i < 2; i++) assert.equal((await post("sms")).status, 201);
  assert.equal((await post("sms")).status, 429);
  assert.equal((await post("call")).status, 201);
  const keys = [...used.keys()];
  assert.deepEqual(keys.map((key) => key.split(":")[0]).sort(), ["call", "sms"]);
  assert.ok(keys.every((key) => key.endsWith(new URL(endpoint).pathname.slice(-32))));
});

test("an unconfigured relay says so", async () => {
  const response = await handle(new Request("https://kyubey.test/v1/register", { method: "POST", body: '{"token":"t"}' }), {});
  assert.equal(response.status, 503);
});
