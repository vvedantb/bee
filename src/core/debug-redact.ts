// Redaction for Bee's local debug log (core/debug-log.ts, main/debug-log.ts). Every event passes through redactDebugData in
// main before it is written, whichever process it came from, so this is the one place secrets are kept out of the log.
// Pure: no Electron, no Node.
//
// Two checks. By key: a field named like a secret (token, apiKey, authorization, password, secret, cookie, cipher…) has its
// text replaced, at any depth. Numbers and booleans under such a key stay, so token counts and "signed in: true" are kept.
// By value: any text that looks like a key (vck_…, sk-…, a JWT, "Bearer …", a secret in a URL's query) is replaced wherever it
// appears, prompts and notes included. Bulky values (base64 images, audio bytes) become a short placeholder.

export const REDACTED = "[redacted]";

// Matched against the key with "-", "_" and spaces removed, lower case: "x-api-key" → "xapikey", "refresh_token" → "refreshtoken".
const SECRET_KEY = /token|apikey|authorization|password|passwd|passphrase|secret|cookie|cipher|credential|privatekey|bearer|jwt|signature/;
// Fields whose text is always a secret, at any depth: an MCP server's stdio env values, HTTP headers, and its auth (the bearer
// token or header value; for a server record, also the auth kind, which is no loss).
const SECRET_TREE = new Set(["env", "headers", "auth"]);
// Named like a secret but never one: which secure storage Settings uses ("os", "weak", "memory").
const NOT_SECRET = new Set(["secretstorage"]);

// Values that are keys wherever they appear. Each keeps a short, readable marker.
const VALUE_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  // "Bearer <token>" in a header, an error or a note.
  [/\bBearer\s+[\w.~+/=-]{8,}/g, `Bearer ${REDACTED}`],
  // JSON Web Tokens: Clerk session tokens, OAuth id tokens.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, "[redacted-jwt]"],
  // Vercel AI Gateway keys.
  [/\bvck_[A-Za-z0-9_-]{8,}/g, "[redacted-key]"],
  // Provider and platform keys: sk-…, sk-ant-…, sk_live_…, rk_…, GitHub, Slack, AWS, Google.
  [/\b(?:sk|rk)[-_](?:live_|test_|ant-|proj-)?[A-Za-z0-9_-]{16,}/g, "[redacted-key]"],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[redacted-key]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[redacted-key]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted-key]"],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, "[redacted-key]"],
  // Secrets in a URL's query or fragment: OAuth codes and state, tokens, keys, signatures.
  [
    /([?&#](?:code|state|token|access_token|refresh_token|id_token|client_secret|api_key|apikey|key|password|secret|sig|signature|session|session_token|__clerk_db_jwt)=)[^&#\s"'<>]+/gi,
    `$1${REDACTED}`,
  ],
];

/** Longest text kept in one value. Prompts, replies and snapshots fit well under it; a runaway buffer does not. */
export const MAX_STRING_CHARS = 100_000;
// Text this long with only base64 characters is an image or audio, not something to read.
const BASE64_MIN_CHARS = 1000;
// No spaces: prose always has them, a base64 image never does.
const BASE64 = /^[A-Za-z0-9+/=_-]+$/;
const MAX_DEPTH = 12;
const MAX_ITEMS = 500;

const normalizeKey = (key: string) => key.toLowerCase().replace(/[-_\s]/g, "");

/** Whether a field with this name holds a secret. */
export function isSecretKey(key: string): boolean {
  const normal = normalizeKey(key);
  return !NOT_SECRET.has(normal) && SECRET_KEY.test(normal);
}

/** One text value with keys taken out, a data URL or base64 blob shortened, and anything huge cut. */
export function redactString(text: string): string {
  if (text.startsWith("data:")) return `[data-url ${text.length} chars]`;
  if (text.length >= BASE64_MIN_CHARS && BASE64.test(text.slice(0, 4000))) return `[base64 ${text.length} chars]`;
  let out = text.length > MAX_STRING_CHARS ? `${text.slice(0, MAX_STRING_CHARS)}… [${text.length - MAX_STRING_CHARS} more chars]` : text;
  for (const [pattern, replacement] of VALUE_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/**
 * Any value as plain JSON-safe data with secrets taken out. Never throws and never returns the input object itself, so a caller
 * that changes its object later does not change what was logged.
 */
export function redactDebugData(value: unknown): unknown {
  return walk(value, false, 0, new WeakSet());
}

function walk(value: unknown, secret: boolean, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  switch (typeof value) {
    case "string":
      return secret ? REDACTED : redactString(value);
    case "number":
      return Number.isFinite(value) ? value : String(value);
    case "boolean":
      return value;
    case "bigint":
      return value.toString();
    case "function":
    case "symbol":
      return undefined;
  }
  const object = value as object;
  if (depth >= MAX_DEPTH) return "[too deep]";
  if (seen.has(object)) return "[circular]";
  if (object instanceof Error) return walk(errorFields(object), secret, depth, seen);
  if (object instanceof Date) return Number.isNaN(object.getTime()) ? null : object.toISOString();
  if (ArrayBuffer.isView(object)) return `[bytes ${object.byteLength}]`;
  if (object instanceof ArrayBuffer) return `[bytes ${object.byteLength}]`;
  if (object instanceof URL) return secret ? REDACTED : redactString(object.href);
  seen.add(object);
  try {
    if (object instanceof Map) return walk(Object.fromEntries(object), secret, depth, seen);
    if (object instanceof Set) return walk([...object], secret, depth, seen);
    if (Array.isArray(object)) {
      const items = object.slice(0, MAX_ITEMS).map((item) => walk(item, secret, depth + 1, seen) ?? null);
      return object.length > MAX_ITEMS ? [...items, `[${object.length - MAX_ITEMS} more items]`] : items;
    }
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [key, item] of Object.entries(object)) {
      if (count++ >= MAX_ITEMS) {
        out["[more keys]"] = Object.keys(object).length - MAX_ITEMS;
        break;
      }
      // Under a secret key every text value goes, however deep; numbers and booleans stay.
      const next = walk(item, secret || SECRET_TREE.has(normalizeKey(key)) || isSecretKey(key), depth + 1, seen);
      if (next !== undefined) out[key] = next;
    }
    return out;
  } catch {
    return "[unreadable]";
  } finally {
    seen.delete(object);
  }
}

function errorFields(error: Error): Record<string, unknown> {
  const cause = (error as { cause?: unknown }).cause;
  return {
    name: error.name,
    message: error.message,
    ...(error.stack ? { stack: error.stack } : {}),
    ...(cause !== undefined ? { cause: cause instanceof Error ? cause.message : String(cause) } : {}),
  };
}
