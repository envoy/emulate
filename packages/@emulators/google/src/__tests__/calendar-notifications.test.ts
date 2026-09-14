import { gzipSync } from "node:zlib";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { describe, expect, it } from "vitest";
import { Hono, Store, WebhookDispatcher, authMiddleware, type TokenMap } from "@emulators/core";
import { getGoogleStore, googlePlugin, seedFromConfig } from "../index.js";

describe("Calendar notifications", () => {
  it("delivers sync and mutation callbacks, isolates channels, and stops delivery", async () => {
    const received: IncomingHttpHeaders[] = [];
    const server = createServer((request, response) => {
      received.push(request.headers);
      response.writeHead(204).end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing callback address");
      const store = new Store();
      const tokens: TokenMap = new Map([
        ["owner", { login: "owner@example.com", id: 1, scopes: [] }],
        ["other", { login: "other@example.com", id: 2, scopes: [] }],
      ]);
      const app = new Hono();
      app.use("*", authMiddleware(tokens));
      googlePlugin.register(app, store, new WebhookDispatcher(), "http://localhost", tokens);
      seedFromConfig(store, "http://localhost", {
        users: [{ email: "owner@example.com" }],
        calendars: [{ id: "room", summary: "Room" }],
      });
      const path = "/calendar/v3/calendars/room/events";
      const request = (url: string, method: string, body?: unknown, token = "owner") =>
        app.request(url, {
          method,
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
      const watch = {
        id: "room-channel",
        type: "webhook",
        address: `http://127.0.0.1:${address.port}/callback/room`,
        token: "callback-token",
      };
      const response = await app.request(path + "/watch", {
        method: "POST",
        headers: { Authorization: "Bearer owner", "Content-Type": "application/json", "Content-Encoding": "gzip" },
        body: new Uint8Array(gzipSync(JSON.stringify(watch))),
      });
      expect(response.status).toBe(200);
      const channel = (await response.json()) as {
        id: string;
        resourceId: string;
        resourceUri: string;
        expiration: string;
      };
      expect(Number(channel.expiration)).toBeGreaterThan(Date.now());
      expect(received[0]).toMatchObject({
        "x-goog-resource-state": "sync",
        "x-goog-channel-id": channel.id,
        "x-goog-resource-id": channel.resourceId,
        "x-goog-channel-token": "callback-token",
        "x-goog-message-number": "1",
      });
      expect((await request(path + "/watch", "POST", watch)).status).toBe(400);
      expect((await request("/calendar/v3/channels/stop", "POST", channel, "other")).status).toBe(404);
      const eventResponse = await request(path, "POST", {
        summary: "Booking",
        start: { dateTime: "2026-09-05T10:00:00Z" },
        end: { dateTime: "2026-09-05T11:00:00Z" },
      });
      const event = (await eventResponse.json()) as { id: string };
      expect(received.at(-1)).toMatchObject({ "x-goog-resource-state": "exists", "x-goog-message-number": "2" });
      await request(path + "/" + event.id, "PATCH", { summary: "Updated booking" });
      await request(path + "/" + event.id, "DELETE");
      expect(received).toHaveLength(4);
      expect(getGoogleStore(store).calendarChannels.all()[0].last_delivery_status).toBe(204);
      expect((await request("/calendar/v3/channels/stop", "POST", channel)).status).toBe(204);
      await request(path, "POST", {
        summary: "After stop",
        start: { date: "2026-09-06" },
        end: { date: "2026-09-07" },
      });
      expect(received).toHaveLength(4);
      expect((await request("/calendar/v3/channels/stop", "POST", channel)).status).toBe(404);
      expect((await request(path + "/watch", "POST", { ...watch, address: "file:///tmp/callback" })).status).toBe(400);
      expect((await request(path + "/watch", "POST", { ...watch, expiration: "1" })).status).toBe(400);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
