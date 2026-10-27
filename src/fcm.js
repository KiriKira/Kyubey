// FCM HTTP v1 with a service-account key, using WebCrypto for the RS256
// assertion. The access token is reused for most of its hour.
import { base64Decode, base64UrlEncode } from "./seal.js";

const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const DEFAULT_TOKEN_URL = "https://oauth2.googleapis.com/token";
const SEND_BASE = "https://fcm.googleapis.com/v1/projects/";

/** FCM cannot deliver to this token: it is gone or belongs to another project. */
export class TokenGone extends Error {}
/** The relay's own credentials are refused. */
export class Misconfigured extends Error {}
/** A failure worth retrying later. */
export class Transient extends Error {}
/** The message's TTL ran out before FCM was asked to deliver it. */
export class Expired extends Error {}

const cache = { account: null, key: null, accessToken: null, until: 0 };

function account(env) {
  if (cache.account?.raw !== env.FCM_SERVICE_ACCOUNT) {
    let parsed;
    try {
      parsed = JSON.parse(env.FCM_SERVICE_ACCOUNT ?? "");
    } catch {
      throw new Misconfigured("FCM_SERVICE_ACCOUNT is not JSON");
    }
    if (parsed.type !== "service_account" || !parsed.project_id || !parsed.client_email || !parsed.private_key) {
      throw new Misconfigured("FCM_SERVICE_ACCOUNT is not a service-account key");
    }
    cache.account = { raw: env.FCM_SERVICE_ACCOUNT, ...parsed, token_uri: parsed.token_uri || DEFAULT_TOKEN_URL };
    cache.key = null;
    cache.accessToken = null;
  }
  return cache.account;
}

async function signingKey(sa) {
  if (!cache.key) {
    const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
    cache.key = crypto.subtle.importKey("pkcs8", base64Decode(pem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  }
  return cache.key;
}

async function accessToken(env, fetchImpl, now) {
  const sa = account(env);
  if (cache.accessToken && now() < cache.until) return cache.accessToken;
  const issued = Math.floor(now() / 1000);
  const encode = (value) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
  const input = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iss: sa.client_email, scope: SCOPE, aud: sa.token_uri, iat: issued, exp: issued + 3600,
  })}`;
  let signature;
  try {
    signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await signingKey(sa), new TextEncoder().encode(input)));
  } catch {
    cache.key = null;
    throw new Misconfigured("FCM private_key cannot sign");
  }
  const response = await fetchImpl(sa.token_uri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${input}.${base64UrlEncode(signature)}`,
    }),
  });
  if ([400, 401, 403].includes(response.status)) throw new Misconfigured("FCM key refused");
  if (!response.ok) throw new Transient(`token endpoint HTTP ${response.status}`);
  const granted = await response.json();
  if (!granted.access_token) throw new Transient("token endpoint returned no access token");
  const lifetime = Math.min(Math.max(Number(granted.expires_in) || 3600, 600), 3600);
  cache.accessToken = granted.access_token;
  cache.until = now() + (lifetime - 300) * 1000;
  return cache.accessToken;
}

/**
 * Sends a content-free data message. A TTL counts from `started`: time the
 * relay spends, signing in included, comes off it, and a message whose TTL
 * ran out is not sent. A TTL of 0 asks FCM to deliver now or drop it.
 */
export async function send(env, token, data, {
  validateOnly = false, fetchImpl = fetch, now = Date.now, priority = "HIGH", ttlMs = 60_000, started = now(),
} = {}) {
  const sa = account(env);
  const access = await accessToken(env, fetchImpl, now);
  const left = ttlMs === 0 ? 0 : ttlMs - (now() - started);
  if (ttlMs > 0 && left <= 0) throw new Expired();
  const response = await fetchImpl(`${SEND_BASE}${encodeURIComponent(sa.project_id)}/messages:send`, {
    method: "POST",
    headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
    body: JSON.stringify({
      validate_only: validateOnly,
      message: { token, data, android: { priority, ttl: `${left / 1000}s` } },
    }),
  });
  if (response.ok) return;
  let code = "";
  try {
    const body = await response.json();
    code = body?.error?.status ?? "";
    for (const detail of body?.error?.details ?? []) if (detail?.errorCode) code = detail.errorCode;
  } catch {
    // An error without a JSON body is classified by status alone.
  }
  if (code === "UNREGISTERED" || code === "SENDER_ID_MISMATCH" || (code === "INVALID_ARGUMENT" && response.status === 400) ||
      (response.status === 404 && code === "NOT_FOUND")) {
    throw new TokenGone(code);
  }
  if (response.status === 401 || response.status === 403 || code === "THIRD_PARTY_AUTH_ERROR") {
    cache.accessToken = null;
    throw new Misconfigured(code || `HTTP ${response.status}`);
  }
  throw new Transient(code || `HTTP ${response.status}`);
}

/** For tests: forget cached credentials. */
export function resetCache() {
  cache.account = null;
  cache.key = null;
  cache.accessToken = null;
  cache.until = 0;
}
