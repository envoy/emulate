import type { AppEnv, Hono, RouteContext, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import { StreamChatApp, type MessageInput, type UserInput } from "./chat.js";
import { channelRoutes } from "./routes/channels.js";
import { inspectorRoutes } from "./routes/inspector.js";
import { userRoutes } from "./routes/users.js";
import { getStreamHub } from "./realtime.js";
import { DEFAULT_API_KEY, DEFAULT_API_SECRET, MIN_API_SECRET_BYTES, setAppConfig } from "./store.js";

export {
  DEFAULT_API_KEY,
  DEFAULT_API_SECRET,
  MIN_API_SECRET_BYTES,
  getAppConfig,
  getStreamStore,
  type StreamStore,
} from "./store.js";
export { StreamChatApp, channelConfig } from "./chat.js";
export { getStreamHub, StreamHub, type StreamSocket, type StreamSocketSession } from "./realtime.js";
export {
  attachStreamWebSocket,
  createStreamBunWebSocket,
  STREAM_CONNECT_PATH,
  type BunServerLike,
  type BunServerWebSocketLike,
} from "./websocket.js";
export {
  createServerToken,
  createUserToken,
  signStreamToken,
  verifyStreamToken,
  type StreamPrincipal,
} from "./auth.js";
export { matchesFilter } from "./filters.js";
export * from "./entities.js";

export interface StreamSeedConfig {
  port?: number;
  /** The app's API key. Clients send it as the `api_key` query parameter. */
  api_key?: string;
  /** The app's API secret. Every JWT must be HS256-signed with it. */
  api_secret?: string;
  /** Where `message.new` webhooks are POSTed, signed with `X-Signature`. */
  webhook_url?: string;
  users?: Array<{ id: string; name?: string; role?: string; teams?: string[]; [key: string]: unknown }>;
  channels?: Array<{
    type: string;
    id: string;
    created_by_id: string;
    team?: string;
    members?: string[];
    frozen?: boolean;
    data?: Record<string, unknown>;
    messages?: Array<{ user_id: string; text: string; type?: "regular" | "system"; [key: string]: unknown }>;
  }>;
}

export function seedFromConfig(store: Store, _baseUrl: string, config: StreamSeedConfig): void {
  if (config.api_secret !== undefined && Buffer.byteLength(config.api_secret, "utf8") < MIN_API_SECRET_BYTES) {
    throw new Error(
      `stream.api_secret must be at least ${MIN_API_SECRET_BYTES} bytes: stream-chat-java refuses a shorter HS256 key`,
    );
  }
  setAppConfig(store, {
    ...(config.api_key ? { apiKey: config.api_key } : {}),
    ...(config.api_secret ? { apiSecret: config.api_secret } : {}),
    ...(config.webhook_url !== undefined ? { webhookUrl: config.webhook_url || null } : {}),
  });
  const chat = new StreamChatApp(store);
  for (const user of config.users ?? []) chat.upsertUser(user as UserInput);
  for (const seed of config.channels ?? []) {
    const { channel } = chat.getOrCreateChannel(
      seed.type,
      seed.id,
      {
        ...seed.data,
        ...(seed.team ? { team: seed.team } : {}),
        ...(seed.frozen ? { frozen: true } : {}),
        created_by_id: seed.created_by_id,
        members: seed.members ?? [],
      },
      seed.created_by_id,
    );
    for (const message of seed.messages ?? []) {
      chat.sendMessage(
        chat.requireChannel(channel.type, channel.channel_id),
        message.user_id,
        message as MessageInput,
        {
          server: true,
        },
      );
    }
  }
}

export const streamPlugin: ServicePlugin = {
  name: "stream",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void {
    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    userRoutes(ctx);
    channelRoutes(ctx);
    inspectorRoutes(ctx);
  },
  seed(store: Store): void {
    setAppConfig(store, { apiKey: DEFAULT_API_KEY, apiSecret: DEFAULT_API_SECRET, webhookUrl: null });
    // A reset drops every record, so the realtime connections that referenced them go too.
    getStreamHub(store).closeAll();
  },
};

export default streamPlugin;
