import type { Collection, Store } from "@emulators/core";
import type {
  StreamChannel,
  StreamMember,
  StreamMessage,
  StreamRead,
  StreamUser,
  StreamWebhookDelivery,
} from "./entities.js";

export interface StreamAppConfig {
  apiKey: string;
  apiSecret: string;
  webhookUrl: string | null;
}

export const DEFAULT_API_KEY = "emulate_stream_key";
/**
 * 48 bytes, like a real Stream secret. stream-chat-java signs with jjwt, which refuses an
 * HS256 key shorter than 256 bits (WeakKeyException), so a short secret breaks Java servers.
 */
export const DEFAULT_API_SECRET = "emulate_stream_secret_0123456789abcdefghijklmnop";
export const MIN_API_SECRET_BYTES = 32;

const APP_KEY = "stream.app";

export interface StreamStore {
  users: Collection<StreamUser>;
  channels: Collection<StreamChannel>;
  members: Collection<StreamMember>;
  messages: Collection<StreamMessage>;
  reads: Collection<StreamRead>;
  webhookDeliveries: Collection<StreamWebhookDelivery>;
}

export function getStreamStore(store: Store): StreamStore {
  return {
    users: store.collection<StreamUser>("stream.users", ["user_id"]),
    channels: store.collection<StreamChannel>("stream.channels", ["cid", "type"]),
    members: store.collection<StreamMember>("stream.members", ["cid", "user_id"]),
    messages: store.collection<StreamMessage>("stream.messages", ["message_id", "cid"]),
    reads: store.collection<StreamRead>("stream.reads", ["cid", "user_id"]),
    webhookDeliveries: store.collection<StreamWebhookDelivery>("stream.webhook_deliveries", ["event_type"]),
  };
}

export function getAppConfig(store: Store): StreamAppConfig {
  return (
    store.getData<StreamAppConfig>(APP_KEY) ?? {
      apiKey: DEFAULT_API_KEY,
      apiSecret: DEFAULT_API_SECRET,
      webhookUrl: null,
    }
  );
}

export function setAppConfig(store: Store, config: Partial<StreamAppConfig>): StreamAppConfig {
  const next = { ...getAppConfig(store), ...config };
  store.setData(APP_KEY, next);
  return next;
}
