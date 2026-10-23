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

function wake(endpoint, body, deps) {
  return handle(new Request(endpoint, { method: "POST", body: JSON.stringify(body) }), env, deps);
}

beforeEach(() => resetCache());

test("an endpoint wakes its device with a fixed, content-free message", async () => {
  const endpoint = await register();
  assert.match(endpoint, /^https:\/\/kyubey\.test\/v1\/w\/[A-Za-z0-9_-]+$/);
  assert.ok(!endpoint.includes("fcm-device-token"), "the token is sealed");
  const g = google();
  const deviceId = "6020d447-2e24-476c-90ad-6cbb07ed8914";
  const response = await wake(endpoint, { kind: "call", device_id: deviceId, number: "+1555", text: "hi" }, { fetch: g.fetch });
  assert.equal(response.status, 201);
  const [sent] = g.calls.sends;
  assert.equal(sent.validate_only, false);
  assert.equal(sent.message.token, "fcm-device-token");
  assert.deepEqual(sent.message.data, { type: "sync", v: "1", kind: "call", device_id: deviceId });
  assert.equal(sent.message.android.priority, "HIGH");
  assert.equal(sent.message.notification, undefined);
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

test("an unconfigured relay says so", async () => {
  const response = await handle(new Request("https://kyubey.test/v1/register", { method: "POST", body: '{"token":"t"}' }), {});
  assert.equal(response.status, 503);
});
