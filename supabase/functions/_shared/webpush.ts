// Web Push with WebCrypto only (runs in Deno Edge Functions and in Node tests):
//   * VAPID (RFC 8292): ES256 JWT, "Authorization: vapid t=…, k=…"
//   * payload encryption "aes128gcm" (RFC 8291 + RFC 8188), verified in tests
//     against the RFC 8291 Appendix A test vector.
// Only well-known push services are contacted (no SSRF through a crafted endpoint).

const te = new TextEncoder();

export const b64u = {
  enc(bytes: Uint8Array): string {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  dec(s: string): Uint8Array {
    const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
    return Uint8Array.from(atob(pad), (c) => c.charCodeAt(0));
  },
};

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: info as BufferSource }, key, len * 8);
  return new Uint8Array(bits);
}

export interface PushSubscriptionKeys { endpoint: string; p256dh: string; auth: string }

/** Imports a P-256 private key given as raw d + the raw uncompressed public key. */
export async function importP256(dB64u: string, publicRaw: Uint8Array, alg: "ECDH" | "ECDSA"): Promise<CryptoKey> {
  const jwk = { kty: "EC", crv: "P-256", d: dB64u, x: b64u.enc(publicRaw.slice(1, 33)), y: b64u.enc(publicRaw.slice(33, 65)), ext: true };
  return crypto.subtle.importKey("jwk", jwk, { name: alg, namedCurve: "P-256" }, false, alg === "ECDH" ? ["deriveBits"] : ["sign"]);
}

/**
 * RFC 8291 aes128gcm body. `fixed` lets tests supply the sender key pair and
 * salt from the RFC test vector; production always uses fresh random ones.
 */
export async function encryptPayload(
  payload: Uint8Array, sub: Pick<PushSubscriptionKeys, "p256dh" | "auth">,
  fixed?: { asPrivate: CryptoKey; asPublic: Uint8Array; salt: Uint8Array },
): Promise<Uint8Array> {
  const uaPublic = b64u.dec(sub.p256dh);
  const authSecret = b64u.dec(sub.auth);
  let asPrivate: CryptoKey, asPublic: Uint8Array;
  if (fixed) {
    asPrivate = fixed.asPrivate;
    asPublic = fixed.asPublic;
  } else {
    const kp = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
    asPrivate = kp.privateKey;
    asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  }
  const uaKey = await crypto.subtle.importKey("raw", uaPublic as BufferSource, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asPrivate, 256));
  const ikm = await hkdf(authSecret, ecdh, concat(te.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek as BufferSource, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce as BufferSource }, key, concat(payload, new Uint8Array([2])) as BufferSource));
  const header = new Uint8Array(21 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ct);
}

/** VAPID Authorization header value for one push service. */
export async function vapidAuthorization(endpoint: string, subject: string, publicKey: string, privateKey: string, now = Date.now()): Promise<string> {
  const header = b64u.enc(te.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u.enc(te.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const key = await importP256(privateKey, b64u.dec(publicKey), "ECDSA");
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, te.encode(`${header}.${claims}`) as BufferSource));
  return `vapid t=${header}.${claims}.${b64u.enc(sig)}, k=${publicKey}`;
}

const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/,        // Chrome / Android
  /^web\.push\.apple\.com$/,                                    // Safari / iOS home-screen apps
  /^updates\.push\.services\.mozilla\.com$/,                    // Firefox
  /\.notify\.windows\.com$/,                                    // Edge on Windows
];
export function isPushEndpoint(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && PUSH_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

export interface PushMessage { title: string; body: string; url?: string; tag?: string }

export async function sendPush(
  fetchFn: typeof fetch, sub: PushSubscriptionKeys, msg: PushMessage,
  vapid: { publicKey: string; privateKey: string; subject: string },
): Promise<number> {
  if (!isPushEndpoint(sub.endpoint)) return 410; // treat as dead: never call arbitrary URLs
  const body = await encryptPayload(te.encode(JSON.stringify(msg)), sub);
  const res = await fetchFn(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidAuthorization(sub.endpoint, vapid.subject, vapid.publicKey, vapid.privateKey),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "86400",
      Urgency: "normal",
    },
    body: body as BodyInit,
  });
  return res.status;
}

/** New VAPID key pair (base64url: raw public point, private scalar d). */
export async function generateVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  return { publicKey: b64u.enc(pub), privateKey: jwk.d! };
}
