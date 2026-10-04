import type { AppEnv, Context, Store } from "@emulators/core";
import { StreamAuthError, verifyStreamToken, type StreamPrincipal } from "./auth.js";
import { StreamChatApp } from "./chat.js";
import { errorBody, inputError, StreamApiError } from "./errors.js";
import { getStreamHub, type StreamHub } from "./realtime.js";
import { getAppConfig } from "./store.js";

export interface StreamRequest {
  chat: StreamChatApp;
  hub: StreamHub;
  principal: StreamPrincipal;
  /** The user a client-side request acts as; null for a server-side request. */
  userId: string | null;
  connectionId: string | undefined;
  body: Record<string, unknown>;
}

type Handler = (
  request: StreamRequest,
  c: Context<AppEnv>,
) => Promise<Record<string, unknown>> | Record<string, unknown>;

/**
 * Wrap a Stream API handler: check `api_key` and the JWT, parse the JSON body, and
 * turn failures into Stream's error body. Successful responses carry `duration`,
 * which every Stream response has.
 */
export function streamHandler(store: Store, handler: Handler) {
  return async (c: Context<AppEnv>): Promise<Response> => {
    const started = performance.now();
    try {
      const app = getAppConfig(store);
      if (c.req.query("api_key") !== app.apiKey) {
        throw new StreamApiError(401, 2, `api_key not found: "${c.req.query("api_key") ?? ""}"`);
      }
      const token = c.req.header("Authorization");
      if (!token || c.req.header("stream-auth-type") !== "jwt") {
        throw new StreamApiError(401, 5, "a JWT in the Authorization header with stream-auth-type: jwt is required");
      }
      const principal = verifyStreamToken(app.apiSecret, token.replace(/^Bearer\s+/i, ""));
      const chat = new StreamChatApp(store);
      const userId = principal.kind === "user" ? principal.userId : null;
      if (userId) chat.ensureUser(userId);
      const body = await readBody(c);
      const result = await handler(
        { chat, hub: getStreamHub(store), principal, userId, connectionId: c.req.query("connection_id"), body },
        c,
      );
      return c.json({ ...result, duration: `${(performance.now() - started).toFixed(2)}ms` });
    } catch (error) {
      if (error instanceof StreamApiError) {
        return c.json(errorBody(error.status, error.code, error.message), error.status);
      }
      if (error instanceof StreamAuthError) {
        return c.json(errorBody(401, error.code, error.message), 401);
      }
      throw error;
    }
  };
}

async function readBody(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  if (c.req.method === "GET" || c.req.method === "DELETE") return {};
  const text = await c.req.text();
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw inputError("request body is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw inputError("request body must be a JSON object");
  return parsed as Record<string, unknown>;
}

/**
 * The user a request acts as: the token's user, or for a server-side request the
 * `user_id` (or `user.id`) the body names.
 */
export function actingUser(request: StreamRequest, ...sources: unknown[]): string | null {
  if (request.userId) return request.userId;
  for (const source of [request.body, ...sources]) {
    if (!source || typeof source !== "object") continue;
    const record = source as { user_id?: unknown; user?: { id?: unknown } };
    if (typeof record.user_id === "string" && record.user_id.length > 0) return record.user_id;
    if (typeof record.user?.id === "string" && record.user.id.length > 0) return record.user.id;
  }
  return null;
}

export function objectField(body: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw inputError(`${key} must be an object`);
  return value as Record<string, unknown>;
}

export function stringArrayField(body: Record<string, unknown>, key: string): string[] {
  const value = body[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw inputError(`${key} must be an array of strings`);
  }
  return value;
}
