// Push endpoints carry the device's FCM token sealed with SEAL_KEY, so the
// relay stores nothing. Format: base64url(0x01 || 12-byte IV || AES-GCM).
const VERSION = 1;
const AAD = new TextEncoder().encode("kyubey-endpoint-v1");

const keys = new Map();

async function sealKey(secret) {
  if (!keys.has(secret)) {
    const raw = base64Decode(secret);
    if (raw.length !== 32) throw new Error("SEAL_KEY must be base64 of 32 bytes");
    keys.set(secret, crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]));
  }
  return keys.get(secret);
}

export async function seal(secret, token) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: AAD }, await sealKey(secret), new TextEncoder().encode(token)));
  const out = new Uint8Array(1 + iv.length + cipher.length);
  out[0] = VERSION;
  out.set(iv, 1);
  out.set(cipher, 1 + iv.length);
  return base64UrlEncode(out);
}

/** The sealed token, or null for anything this relay did not issue. */
export async function open(secret, sealed) {
  let bytes;
  try {
    bytes = base64UrlDecode(sealed);
  } catch {
    return null;
  }
  if (bytes.length < 1 + 12 + 16 + 1 || bytes[0] !== VERSION) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.subarray(1, 13), additionalData: AAD }, await sealKey(secret), bytes.subarray(13));
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

export function base64UrlEncode(bytes) {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function base64UrlDecode(text) {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("not base64url");
  return base64Decode(text.replaceAll("-", "+").replaceAll("_", "/"));
}

export function base64Decode(text) {
  const padded = text + "=".repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
