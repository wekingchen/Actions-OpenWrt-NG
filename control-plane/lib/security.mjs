import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes
} from "node:crypto";

function encryptionKey(secret) {
  const text = String(secret || "");
  if (text.length < 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must contain at least 32 characters");
  }
  return createHash("sha256").update(text).digest();
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function hashOpaque(value) {
  return createHash("sha256").update(String(value)).digest("base64url");
}

export function sha256Base64Url(value) {
  return createHash("sha256").update(String(value)).digest("base64url");
}

export function encryptString(value, secret) {
  if (value == null || value === "") return "";
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(secret), iv);
  const encrypted = Buffer.concat([
    cipher.update(String(value), "utf8"),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();
  return [
    "v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    encrypted.toString("base64url")
  ].join(".");
}

export function decryptString(payload, secret) {
  if (!payload) return "";
  const parts = String(payload).split(".");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("Unsupported encrypted payload");
  }

  const iv = Buffer.from(parts[1], "base64url");
  const tag = Buffer.from(parts[2], "base64url");
  const encrypted = Buffer.from(parts[3], "base64url");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(secret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(encrypted),
    decipher.final()
  ]).toString("utf8");
}

export function safeReturnTo(value) {
  const candidate = String(value || "/").trim();
  if (
    !candidate.startsWith("/") ||
    candidate.startsWith("//") ||
    candidate.includes("\\") ||
    /[\r\n]/.test(candidate)
  ) {
    return "/";
  }

  const parsed = new URL(candidate, "https://control-plane.invalid");
  if (parsed.origin !== "https://control-plane.invalid") return "/";
  return parsed.pathname + parsed.search + parsed.hash;
}

export function parseCookies(header = "") {
  const result = {};
  for (const pair of String(header).split(";")) {
    const index = pair.indexOf("=");
    if (index <= 0) continue;
    const key = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (!key) continue;
    try {
      result[key] = decodeURIComponent(value);
    } catch {
      result[key] = value;
    }
  }
  return result;
}

export function sessionCookie(value, options = {}) {
  const parts = [
    "ong_session=" + encodeURIComponent(value),
    "Path=/",
    "HttpOnly",
    "SameSite=Lax"
  ];
  if (options.secure !== false) parts.push("Secure");
  if (Number.isFinite(options.maxAge)) {
    parts.push("Max-Age=" + Math.max(0, Math.floor(options.maxAge)));
  }
  return parts.join("; ");
}
