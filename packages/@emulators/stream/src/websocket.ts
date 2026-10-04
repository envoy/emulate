import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type { Store } from "@emulators/core";
import { WebSocketServer, type WebSocket } from "ws";
import { getStreamHub, type StreamSocketSession } from "./realtime.js";

/** The path stream-chat dials: `${wsBaseURL}/connect?...`. */
export const STREAM_CONNECT_PATH = "/connect";

function isConnectRequest(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false;
  return new URL(rawUrl, "http://localhost").pathname === STREAM_CONNECT_PATH;
}

/**
 * Serve Stream's WebSocket on a Node HTTP server (the one `serve()` from
 * `@emulators/core` returns). Upgrades to any other path are refused.
 * Returns a function that detaches the handler and closes open sockets.
 */
export function attachStreamWebSocket(server: Server, store: Store): () => void {
  const wss = new WebSocketServer({ noServer: true });
  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!isConnectRequest(request.url)) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      const session = getStreamHub(store).open(url, {
        send: (data) => ws.send(data),
        close: (code, reason) => ws.close(code, reason),
      });
      ws.on("message", (data) => session.message(data.toString()));
      ws.on("close", () => session.close());
      ws.on("error", () => session.close());
    });
  };
  server.on("upgrade", onUpgrade);
  return () => {
    server.off("upgrade", onUpgrade);
    for (const client of wss.clients) client.terminate();
    wss.close();
  };
}

/** The subset of Bun's `ServerWebSocket` the Bun adapter uses. */
export interface BunServerWebSocketLike {
  data: { url: string; session?: StreamSocketSession };
  send(data: string): unknown;
  close(code?: number, reason?: string): void;
}

/** The subset of Bun's `Server` the Bun adapter uses. */
export interface BunServerLike {
  upgrade(request: Request, options: { data: { url: string } }): boolean;
}

/**
 * Serve Stream's WebSocket from `Bun.serve`. Call `upgrade(request, server)` first in
 * `fetch`; when it returns true, return `undefined` from `fetch`. Pass `websocket` as
 * `Bun.serve({ websocket })`.
 */
export function createStreamBunWebSocket(store: Store) {
  return {
    upgrade(request: Request, server: BunServerLike): boolean {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return false;
      if (!isConnectRequest(request.url)) return false;
      return server.upgrade(request, { data: { url: request.url } });
    },
    websocket: {
      open(ws: BunServerWebSocketLike) {
        ws.data.session = getStreamHub(store).open(new URL(ws.data.url), {
          send: (data) => {
            ws.send(data);
          },
          close: (code, reason) => ws.close(code, reason),
        });
      },
      message(ws: BunServerWebSocketLike, message: string | Uint8Array) {
        ws.data.session?.message(typeof message === "string" ? message : new TextDecoder().decode(message));
      },
      close(ws: BunServerWebSocketLike) {
        ws.data.session?.close();
      },
    },
  };
}
