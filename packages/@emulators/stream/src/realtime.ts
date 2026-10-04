import { randomUUID } from "node:crypto";
import type { Store } from "@emulators/core";
import { StreamAuthError, verifyStreamToken } from "./auth.js";
import { StreamChatApp, type UserInput } from "./chat.js";
import { errorBody } from "./errors.js";
import { getAppConfig } from "./store.js";

/**
 * Stream's realtime protocol, independent of any WebSocket library.
 *
 * A client dials `GET /connect?json=...&api_key=...&authorization=<jwt>&stream-auth-type=jwt`.
 * The server answers with one `health.check` event carrying `connection_id` and `me`;
 * stream-chat treats the first message as the handshake. Afterwards the client sends
 * `[{ "type": "health.check", "client_id": ... }]` every 25 seconds and expects a
 * `health.check` back. Events for watched channels and the user's notifications are
 * pushed as JSON text frames.
 */
export interface StreamSocket {
  send(data: string): void;
  close(code: number, reason: string): void;
}

export interface StreamSocketSession {
  readonly connectionId: string | null;
  message(data: string): void;
  close(): void;
}

interface Connection {
  id: string;
  userId: string;
  socket: StreamSocket;
  watching: Set<string>;
}

export type StreamEvent = Record<string, unknown> & { type: string };

/** Close code stream-chat treats as permanent: it rejects and does not reconnect. */
const CLOSE_PERMANENT = 1000;

export class StreamHub {
  private readonly connections = new Map<string, Connection>();

  constructor(private readonly store: Store) {}

  private get chat(): StreamChatApp {
    return new StreamChatApp(this.store);
  }

  /** Accept a `/connect` request. Authentication failures are reported and closed. */
  open(url: URL, socket: StreamSocket): StreamSocketSession {
    const reject = (status: number, code: number, message: string): StreamSocketSession => {
      socket.send(JSON.stringify({ error: errorBody(status, code, message) }));
      socket.close(CLOSE_PERMANENT, message);
      return { connectionId: null, message() {}, close() {} };
    };

    const app = getAppConfig(this.store);
    if (url.searchParams.get("api_key") !== app.apiKey) return reject(401, 2, "api_key not found");

    let payload: { user_id?: unknown; user_details?: Record<string, unknown> };
    try {
      payload = JSON.parse(url.searchParams.get("json") ?? "{}");
    } catch {
      return reject(400, 4, "json parameter is not valid JSON");
    }

    const authType = url.searchParams.get("stream-auth-type");
    if (authType !== "jwt") return reject(401, 5, "only stream-auth-type=jwt is emulated");
    let userId: string;
    try {
      const principal = verifyStreamToken(app.apiSecret, url.searchParams.get("authorization") ?? "");
      if (principal.kind !== "user") return reject(401, 5, "a WebSocket connection needs a user token");
      userId = principal.userId;
    } catch (error) {
      if (error instanceof StreamAuthError) return reject(401, error.code, error.message);
      throw error;
    }
    if (payload.user_id !== undefined && payload.user_id !== userId) {
      return reject(401, 5, `token user "${userId}" does not match user_id "${String(payload.user_id)}"`);
    }

    const chat = this.chat;
    const details = payload.user_details;
    if (details && typeof details === "object") {
      // connectUser upserts the user from user_details, keeping teams and role server-owned.
      const existing = chat.findUser(userId);
      const { teams: _teams, role: _role, ...rest } = details;
      chat.upsertUser({
        ...(existing ? { ...existing.custom, name: existing.name ?? undefined } : {}),
        ...rest,
        id: userId,
      } as UserInput);
    } else {
      chat.ensureUser(userId);
    }
    chat.touchUser(userId);

    const connection: Connection = { id: randomUUID(), userId, socket, watching: new Set() };
    this.connections.set(connection.id, connection);
    const user = chat.findUser(userId)!;
    this.send(connection, {
      type: "health.check",
      connection_id: connection.id,
      cid: "*",
      me: chat.formatOwnUser(user),
      created_at: new Date().toISOString(),
    });

    return {
      connectionId: connection.id,
      message: (data: string) => this.receive(connection, data),
      close: () => this.drop(connection.id),
    };
  }

  private receive(connection: Connection, data: string): void {
    let frames: unknown;
    try {
      frames = JSON.parse(data);
    } catch {
      return;
    }
    for (const frame of Array.isArray(frames) ? frames : [frames]) {
      if ((frame as { type?: unknown })?.type === "health.check") {
        this.send(connection, {
          type: "health.check",
          connection_id: connection.id,
          cid: "*",
          created_at: new Date().toISOString(),
        });
      }
    }
  }

  private drop(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    this.connections.delete(connectionId);
    this.chat.touchUser(connection.userId);
  }

  /** Close every connection, as a reset of the emulator does. */
  closeAll(reason = "emulator reset"): void {
    for (const connection of [...this.connections.values()]) {
      this.connections.delete(connection.id);
      try {
        connection.socket.close(CLOSE_PERMANENT, reason);
      } catch {
        // Already closed.
      }
    }
  }

  connection(connectionId: string | undefined): Connection | undefined {
    return connectionId ? this.connections.get(connectionId) : undefined;
  }

  isOnline = (userId: string): boolean => {
    for (const connection of this.connections.values()) {
      if (connection.userId === userId) return true;
    }
    return false;
  };

  watch(connectionId: string, cid: string): void {
    this.connections.get(connectionId)?.watching.add(cid);
  }

  unwatch(connectionId: string, cid: string): void {
    this.connections.get(connectionId)?.watching.delete(cid);
  }

  /** Distinct users watching a channel. */
  watcherCount(cid: string): number {
    const users = new Set<string>();
    for (const connection of this.connections.values()) {
      if (connection.watching.has(cid)) users.add(connection.userId);
    }
    return users.size;
  }

  /** Connections watching the channel. */
  watchers(cid: string): Connection[] {
    return [...this.connections.values()].filter((connection) => connection.watching.has(cid));
  }

  /** Connections of these users that are NOT watching the channel. */
  nonWatchingConnections(userIds: Iterable<string>, cid: string): Connection[] {
    const wanted = new Set(userIds);
    return [...this.connections.values()].filter(
      (connection) => wanted.has(connection.userId) && !connection.watching.has(cid),
    );
  }

  connectionsOf(userId: string): Connection[] {
    return [...this.connections.values()].filter((connection) => connection.userId === userId);
  }

  stats(): Array<{ connection_id: string; user_id: string; watching: string[] }> {
    return [...this.connections.values()].map((connection) => ({
      connection_id: connection.id,
      user_id: connection.userId,
      watching: [...connection.watching],
    }));
  }

  send(connection: Connection, event: StreamEvent): void {
    try {
      connection.socket.send(JSON.stringify(event));
    } catch {
      this.drop(connection.id);
    }
  }
}

const hubs = new WeakMap<Store, StreamHub>();

/** The realtime hub for one emulator store. REST handlers publish through it. */
export function getStreamHub(store: Store): StreamHub {
  let hub = hubs.get(store);
  if (!hub) {
    hub = new StreamHub(store);
    hubs.set(store, hub);
  }
  return hub;
}
