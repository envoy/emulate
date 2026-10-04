import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Stream authenticates every request with an HS256 JWT signed with the app secret.
 *
 * A server token (stream-chat-java, stream-chat with a secret) carries `server: true`.
 * A user token carries `user_id`. Both arrive in the `Authorization` header with no
 * scheme prefix, beside `stream-auth-type: jwt` and the `api_key` query parameter.
 */
export type StreamPrincipal = { kind: "server" } | { kind: "user"; userId: string };

export class StreamAuthError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

/** Stream error code for an expired token; stream-chat reloads its token on this code. */
export const TOKEN_EXPIRED_CODE = 40;
/** Stream error code for any other authentication failure. */
export const AUTH_FAILED_CODE = 5;

/** Clock skew tolerated on `iat`. stream-chat-java issues user tokens with `iat` = now. */
const IAT_SKEW_SECONDS = 300;

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export function signStreamToken(secret: string, payload: Record<string, unknown>): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  const signature = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${signature}`;
}

/** A user token, as `client.createToken(userId)` or `User.createToken(userId, ...)` would make it. */
export function createUserToken(secret: string, userId: string, expiresInSeconds?: number): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = { user_id: userId };
  if (expiresInSeconds !== undefined) payload.exp = now + expiresInSeconds;
  return signStreamToken(secret, payload);
}

/** A server token, as the server SDKs make it. */
export function createServerToken(secret: string): string {
  return signStreamToken(secret, { server: true });
}

export function verifyStreamToken(secret: string, token: string, nowMs: number = Date.now()): StreamPrincipal {
  const parts = token.split(".");
  if (parts.length !== 3) throw new StreamAuthError("token is not a JWT", AUTH_FAILED_CODE);
  const [headerPart, payloadPart, signaturePart] = parts;

  let header: { alg?: unknown };
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
  } catch {
    throw new StreamAuthError("token is not valid JSON", AUTH_FAILED_CODE);
  }
  if (header.alg !== "HS256") throw new StreamAuthError("token must be signed with HS256", AUTH_FAILED_CODE);

  const expected = createHmac("sha256", secret).update(`${headerPart}.${payloadPart}`).digest();
  const actual = Buffer.from(signaturePart, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new StreamAuthError("token signature is invalid", AUTH_FAILED_CODE);
  }

  const now = Math.floor(nowMs / 1000);
  if (typeof payload.exp === "number" && payload.exp < now) {
    throw new StreamAuthError("token has expired", TOKEN_EXPIRED_CODE);
  }
  if (typeof payload.iat === "number" && payload.iat > now + IAT_SKEW_SECONDS) {
    throw new StreamAuthError("token used before issue at (iat)", AUTH_FAILED_CODE);
  }

  if (payload.server === true) return { kind: "server" };
  if (typeof payload.user_id === "string" && payload.user_id.length > 0) {
    return { kind: "user", userId: payload.user_id };
  }
  throw new StreamAuthError("token carries neither server nor user_id", AUTH_FAILED_CODE);
}
