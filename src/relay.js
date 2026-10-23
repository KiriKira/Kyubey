// Kyubey: a stateless push relay between mahogsm server nodes and phones.
//
//   POST /v1/register   {"token": "<FCM token>"}  -> {"endpoint": "https://.../v1/w/<sealed>"}
//   POST /v1/w/<sealed> {"kind": "sms"|"call"|"check", "device_id": "<uuid>"}
//
// A node only ever sees the endpoint URL; the FCM token inside is sealed
// with SEAL_KEY. Messages are fixed: no number, text or call ID can be sent
// through the relay, and "check" asks FCM to validate without delivering.
import { open, seal } from "./seal.js";
import { Misconfigured, TokenGone, send } from "./fcm.js";

const MAX_TOKEN = 4096;
const MAX_REGISTER_BODY = 8 * 1024;
const MAX_WAKE_BODY = 1024;
const KINDS = new Set(["sms", "call", "check"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  if (env.RATE_LIMITER) {
    const { success } = await env.RATE_LIMITER.limit({ key: sealed.slice(-32) });
    if (!success) return text(429, "too many wake-ups for this endpoint");
  }
  const body = await readJSON(request, MAX_WAKE_BODY);
  const kind = body?.kind;
  const deviceId = body?.device_id;
  if (!KINDS.has(kind) || (deviceId !== undefined && !(typeof deviceId === "string" && UUID.test(deviceId)))) {
    return text(400, "kind must be sms, call or check");
  }
  const token = await open(env.SEAL_KEY, sealed);
  if (token === null) return text(404, "unknown endpoint");
  const data = { type: "sync", v: "1", kind };
  if (deviceId) data.device_id = deviceId;
  try {
    await send(env, token, data, { validateOnly: kind === "check", fetchImpl: deps.fetch ?? fetch, now: deps.now ?? Date.now });
  } catch (error) {
    // 410 tells the node to forget the endpoint; 5xx asks it to retry later.
    if (error instanceof TokenGone) return text(410, "the device is no longer reachable");
    if (error instanceof Misconfigured) return text(502, "relay credentials are refused");
    return text(503, "push service temporarily unavailable", { "retry-after": "30" });
  }
  return new Response(null, { status: 201 });
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
