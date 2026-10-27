// Kyubey: a stateless push relay between mahogsm server nodes and phones.
//
//   POST /v1/register   {"token": "<FCM token>"}  -> {"endpoint": "https://.../v1/w/<sealed>"}
//   POST /v1/w/<sealed> {"kind": "sms"|"call"|"check", "device_id": "<uuid>"}
//                       wire 2 adds "v": 2, "wake_id", "call_id", "revision"
//                       and "endpoint_generation"; TTL and Urgency headers
//                       set how long FCM keeps the message and its priority.
//
// A node only ever sees the endpoint URL; the FCM token inside is sealed
// with SEAL_KEY. Messages carry identifiers only: no number, text or URL can
// be sent through the relay, and "check" asks FCM to validate without
// delivering.
import { open, seal } from "./seal.js";
import { Expired, Misconfigured, TokenGone, send } from "./fcm.js";

const MAX_TOKEN = 4096;
const MAX_REGISTER_BODY = 8 * 1024;
const MAX_WAKE_BODY = 1024;
const KINDS = new Set(["sms", "call", "check"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WAKE_ID = /^[A-Za-z0-9._:-]{1,64}$/;
// FCM keeps a message at most 28 days.
const MAX_TTL = 28 * 24 * 3600;
const URGENCIES = new Set(["very-low", "low", "normal", "high"]);
// Wire versions this relay forwards, for nodes and phones diagnosing a relay.
const WIRE_HEADER = { "kyubey-wire": "1,2" };

export async function handle(request, env, deps = {}) {
  const url = new URL(request.url);
  if (!env.SEAL_KEY || !env.FCM_SERVICE_ACCOUNT) return text(503, "relay is not configured");
  if (url.pathname === "/" && request.method === "GET") return text(200, "kyubey: mahogsm push relay\n");
  if (url.pathname === "/v1/register") {
    if (request.method !== "POST") return text(405, "use POST");
    return register(request, env, url);
  }
  const match = url.pathname.match(/^\/v1\/w\/([A-Za-z0-9_-]{40,8192})$/);
  if (match) {
    if (request.method !== "POST") return text(405, "use POST");
    return wake(request, env, match[1], deps);
  }
  return text(404, "not found");
}

async function register(request, env, url) {
  const body = await readJSON(request, MAX_REGISTER_BODY);
  const token = typeof body?.token === "string" ? body.token : "";
  if (!token || token.length > MAX_TOKEN || /\s/.test(token)) return text(400, "token is required");
  const sealed = await seal(env.SEAL_KEY, token);
  return json(200, { endpoint: `${url.origin}/v1/w/${sealed}` });
}

async function wake(request, env, sealed, deps) {
  const now = deps.now ?? Date.now;
  const started = now();
  const delivery = deliveryHeaders(request.headers);
  if (!delivery) return text(400, "TTL must be whole seconds and Urgency very-low, low, normal or high");
  const body = await readJSON(request, MAX_WAKE_BODY);
  const data = wakeData(body);
  if (!data) return text(400, "kind must be sms, call or check, with valid wire fields");
  if (env.RATE_LIMITER) {
    // Separate budgets, so a burst of SMS hints cannot use up a call's.
    const { success } = await env.RATE_LIMITER.limit({ key: `${data.kind}:${sealed.slice(-32)}` });
    if (!success) return text(429, "too many wake-ups for this endpoint");
  }
  const token = await open(env.SEAL_KEY, sealed);
  if (token === null) return text(404, "unknown endpoint");
  try {
    await send(env, token, data, {
      validateOnly: data.kind === "check", fetchImpl: deps.fetch ?? fetch, now,
      priority: delivery.urgency === "high" ? "HIGH" : "NORMAL",
      ttlMs: delivery.ttl * 1000, started,
    });
  } catch (error) {
    // 410 tells the node to forget the endpoint; 5xx asks it to retry later.
    if (error instanceof TokenGone) return text(410, "the device is no longer reachable");
    if (error instanceof Misconfigured) return text(502, "relay credentials are refused");
    if (error instanceof Expired) return text(504, "the message expired before it could be sent", WIRE_HEADER);
    return text(503, "push service temporarily unavailable", { "retry-after": "30" });
  }
  return new Response(null, { status: 201, headers: WIRE_HEADER });
}

/** The TTL and Urgency headers; a request without them keeps wire 1's 60 s, high. */
function deliveryHeaders(headers) {
  const ttl = headers.get("ttl") ?? "60";
  const urgency = (headers.get("urgency") ?? "high").toLowerCase();
  if (!/^[0-9]{1,8}$/.test(ttl) || Number(ttl) > MAX_TTL || !URGENCIES.has(urgency)) return null;
  return { ttl: Number(ttl), urgency };
}

/** The FCM data for a valid wake-up, or null. FCM data values are strings. */
function wakeData(body) {
  if (body === null || typeof body !== "object") return null;
  const { kind, device_id: deviceId } = body;
  if (!KINDS.has(kind) || (deviceId !== undefined && !(typeof deviceId === "string" && UUID.test(deviceId)))) return null;
  const version = body.v ?? 1;
  if (version !== 1 && version !== 2) return null;
  const data = { type: "sync", v: String(version), kind };
  if (deviceId) data.device_id = deviceId;
  if (version === 1) return data;
  const { wake_id: wakeId, call_id: callId, revision, endpoint_generation: generation } = body;
  if (wakeId !== undefined) {
    if (typeof wakeId !== "string" || !WAKE_ID.test(wakeId)) return null;
    data.wake_id = wakeId;
  }
  if (callId !== undefined) {
    if (kind !== "call" || typeof callId !== "string" || !UUID.test(callId)) return null;
    data.call_id = callId;
  }
  for (const [name, value, min] of [["revision", revision, 0], ["endpoint_generation", generation, 1]]) {
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < min) return null;
    data[name] = String(value);
  }
  return data;
}

async function readJSON(request, limit) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > limit) return null;
  const raw = await request.text();
  if (raw.length > limit) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function text(status, message, headers = {}) {
  return new Response(message, { status, headers: { "content-type": "text/plain; charset=utf-8", ...headers } });
}

function json(status, value) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
