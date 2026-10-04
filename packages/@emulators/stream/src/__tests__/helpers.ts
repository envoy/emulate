import type { AddressInfo } from "node:net";
import { createServer, serve, type Store } from "@emulators/core";
import { createServerToken, createUserToken } from "../auth.js";
import { attachStreamWebSocket } from "../websocket.js";
import { seedFromConfig, streamPlugin, type StreamSeedConfig } from "../index.js";

export const TEST_API_KEY = "test_stream_key";
export const TEST_API_SECRET = "test_stream_secret_with_at_least_thirty_two_bytes";

export interface RunningStream {
  baseUrl: string;
  store: Store;
  serverToken: string;
  userToken(userId: string): string;
  /** A Stream REST call with the server token, as the server SDKs make it. */
  server(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }>;
  close(): Promise<void>;
}

/** Serve the emulator on an ephemeral port with its WebSocket attached, as the CLI does. */
export async function startStream(seed: StreamSeedConfig = {}): Promise<RunningStream> {
  const { app, store } = createServer(streamPlugin, { port: 0 });
  streamPlugin.seed?.(store, "");
  seedFromConfig(store, "", { api_key: TEST_API_KEY, api_secret: TEST_API_SECRET, ...seed });
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  const detach = attachStreamWebSocket(server, store);
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", () => resolve())));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  const serverToken = createServerToken(TEST_API_SECRET);

  return {
    baseUrl,
    store,
    serverToken,
    userToken: (userId) => createUserToken(TEST_API_SECRET, userId),
    async server(method, path, body) {
      const separator = path.includes("?") ? "&" : "?";
      const response = await fetch(`${baseUrl}${path}${separator}api_key=${TEST_API_KEY}`, {
        method,
        headers: {
          Authorization: serverToken,
          "stream-auth-type": "jwt",
          "Content-Type": "application/json",
          "X-Stream-Client": "stream-java-client-1.32.0",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    },
    async close() {
      detach();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export async function eventually<T>(read: () => T | undefined, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
