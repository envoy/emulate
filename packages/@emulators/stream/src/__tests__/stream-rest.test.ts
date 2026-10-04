import { createHmac, randomUUID } from "node:crypto";
import { createServer as createHttpServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { Hono, Store, WebhookDispatcher, type AppEnv } from "@emulators/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServerToken, signStreamToken } from "../auth.js";
import { matchesFilter } from "../filters.js";
import {
  createStreamBunWebSocket,
  DEFAULT_API_KEY,
  DEFAULT_API_SECRET,
  seedFromConfig,
  streamPlugin,
} from "../index.js";
import { eventually, startStream, TEST_API_KEY, TEST_API_SECRET, type RunningStream } from "./helpers.js";

async function readJson(response: Response): Promise<any> {
  return response.json();
}

/**
 * The server API at the wire, shaped as stream-chat-java 1.32.0 sends it: the API key as a
 * query parameter, a server JWT in `Authorization` with no scheme, members as
 * `[{ user_id }]`, custom fields flattened into `data`, and `add_members` as strings.
 */
describe("server API", () => {
  let stream: RunningStream;
  const channelId = randomUUID();

  beforeEach(async () => {
    stream = await startStream();
  });

  afterEach(async () => {
    await stream.close();
  });

  async function createChannel() {
    await stream.server("POST", "/users", {
      users: {
        "101": { id: "101", teams: ["7"], name: "Ada Admin" },
        "202": { id: "202", teams: ["7"], name: "Rene Recipient" },
      },
    });
    return stream.server("POST", `/channels/emno/${channelId}/query`, {
      data: {
        team: "7",
        created_by: { id: "101" },
        members: [{ user_id: "101" }, { user_id: "202" }],
        name: "Rene Recipient",
        recipient_user_id: "202",
      },
    });
  }

  it("upserts users keyed by id", async () => {
    const response = await stream.server("POST", "/users", {
      users: { "101": { id: "101", teams: ["7"], name: "Ada Admin", email: "ada@example.com" } },
    });
    expect(response.status).toBe(200);
    expect(response.body.users["101"]).toMatchObject({
      id: "101",
      name: "Ada Admin",
      teams: ["7"],
      role: "user",
      email: "ada@example.com",
    });
    expect(response.body.duration).toMatch(/ms$/);
  });

  it("creates a channel once and returns it with flattened custom data", async () => {
    const created = await createChannel();
    expect(created.status).toBe(200);
    expect(created.body.channel).toMatchObject({
      id: channelId,
      type: "emno",
      cid: `emno:${channelId}`,
      team: "7",
      name: "Rene Recipient",
      recipient_user_id: "202",
      created_by: { id: "101", name: "Ada Admin" },
      member_count: 2,
      frozen: false,
    });
    expect(
      created.body.members.map((member: { user: { id: string }; role: string }) => [member.user.id, member.role]),
    ).toEqual([
      ["101", "owner"],
      ["202", "member"],
    ]);

    // getOrCreate is idempotent: a second call with different data changes nothing.
    const again = await stream.server("POST", `/channels/emno/${channelId}/query`, {
      data: { team: "7", created_by: { id: "101" }, name: "Changed" },
    });
    expect(again.body.channel.name).toBe("Rene Recipient");
  });

  it("requires a creator for a server-side channel", async () => {
    const response = await stream.server("POST", `/channels/emno/${randomUUID()}/query`, { data: { team: "7" } });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 4, StatusCode: 400 });
  });

  it("sends a system message as an implicit system user, keeping extra data", async () => {
    await createChannel();
    const sent = await stream.server("POST", `/channels/emno/${channelId}/message`, {
      message: { text: "Fire drill", user_id: "system", type: "system", message_subtype: "announcement_content" },
    });
    expect(sent.status).toBe(200);
    expect(sent.body.message).toMatchObject({
      text: "Fire drill",
      type: "system",
      user: { id: "system" },
      message_subtype: "announcement_content",
      cid: `emno:${channelId}`,
    });
    const listed = await stream.server("POST", "/channels", {
      filter_conditions: { cid: `emno:${channelId}` },
      limit: 1,
    });
    expect(listed.body.channels[0].channel.last_message_at).toBe(sent.body.message.created_at);
  });

  it("adds members given as strings and freezes with a partial update", async () => {
    await createChannel();
    const updated = await stream.server("POST", `/channels/emno/${channelId}`, { add_members: ["303"] });
    expect(updated.body.members.map((member: { user_id: string }) => member.user_id)).toEqual(["101", "202", "303"]);

    const frozen = await stream.server("PATCH", `/channels/emno/${channelId}`, { set: { frozen: true } });
    expect(frozen.body.channel.frozen).toBe(true);
    expect(frozen.body.channel.own_capabilities).not.toContain("send-message");

    // A server can still post to a frozen channel; communication-service never needs to,
    // but Stream allows it.
    const notice = await stream.server("POST", `/channels/emno/${channelId}/message`, {
      message: { text: "Chat is now closed.", user_id: "system", type: "system" },
    });
    expect(notice.status).toBe(200);
  });

  it("answers a missing channel with Stream's error body", async () => {
    const response = await stream.server("PATCH", `/channels/emno/${randomUUID()}`, { set: { frozen: true } });
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: 16, StatusCode: 404, more_info: expect.any(String) });
  });

  it("rejects a wrong api_key and a missing token", async () => {
    const wrongKey = await fetch(`${stream.baseUrl}/channels?api_key=nope`, {
      method: "POST",
      headers: { Authorization: stream.serverToken, "stream-auth-type": "jwt" },
      body: "{}",
    });
    expect(wrongKey.status).toBe(401);
    expect(await readJson(wrongKey)).toMatchObject({ code: 2 });

    const noToken = await fetch(`${stream.baseUrl}/channels?api_key=${TEST_API_KEY}`, { method: "POST", body: "{}" });
    expect(noToken.status).toBe(401);
  });

  it("accepts a user token minted the way stream-chat-java mints it", async () => {
    await createChannel();
    const now = Math.floor(Date.now() / 1000);
    const token = signStreamToken(TEST_API_SECRET, {
      user_id: "101",
      exp: now + 43200,
      iat: now,
      iss: "Stream Chat Java SDK",
      sub: "Stream Chat Java SDK",
    });
    const response = await fetch(`${stream.baseUrl}/channels?api_key=${TEST_API_KEY}`, {
      method: "POST",
      headers: { Authorization: token, "stream-auth-type": "jwt", "Content-Type": "application/json" },
      body: JSON.stringify({ filter_conditions: { type: "emno" } }),
    });
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.channels[0].membership.user.id).toBe("101");
  });

  it("answers CORS preflight for the browser client", async () => {
    const response = await fetch(`${stream.baseUrl}/channels?api_key=${TEST_API_KEY}`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://dashboard.envoy.dev",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers":
          "authorization,content-type,stream-auth-type,x-stream-client,x-client-request-id",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-headers")).toContain("stream-auth-type");
  });

  it("serves the inspector and the read-back routes", async () => {
    await createChannel();
    await stream.server("POST", `/channels/emno/${channelId}/message`, { message: { text: "Hello", user_id: "202" } });

    const page = await fetch(`${stream.baseUrl}/`);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("Stream Chat Inspector");

    const channels = await readJson(await fetch(`${stream.baseUrl}/_emulate/stream/channels`));
    expect(channels.channels[0]).toMatchObject({ cid: `emno:${channelId}`, members: ["101", "202"], message_count: 1 });

    const messages = await readJson(
      await fetch(`${stream.baseUrl}/_emulate/stream/channels/emno/${channelId}/messages`),
    );
    expect(messages.messages.map((message: { text: string }) => message.text)).toEqual(["Hello"]);

    const minted = await readJson(
      await fetch(`${stream.baseUrl}/_emulate/stream/tokens`, {
        method: "POST",
        body: JSON.stringify({ user_id: "202" }),
      }),
    );
    const asRecipient = await fetch(`${stream.baseUrl}/channels/emno/${channelId}/message?api_key=${TEST_API_KEY}`, {
      method: "POST",
      headers: { Authorization: minted.token, "stream-auth-type": "jwt", "Content-Type": "application/json" },
      body: JSON.stringify({ message: { text: "I am safe" } }),
    });
    expect(asRecipient.status).toBe(200);
    expect((await readJson(asRecipient)).message.user.id).toBe("202");
  });
});

describe("webhooks", () => {
  it("POSTs a signed message.new to the configured URL", async () => {
    const received: Array<{ headers: IncomingHttpHeaders; body: string }> = [];
    const receiver = createHttpServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        received.push({ headers: request.headers, body });
        response.statusCode = 200;
        response.end();
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", () => resolve()));
    const url = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/a/communication/api/v1/webhooks/stream`;
    const stream = await startStream({ webhook_url: url });
    try {
      const channelId = randomUUID();
      await stream.server("POST", `/channels/emno/${channelId}/query`, {
        data: { team: "7", created_by: { id: "101" }, members: [{ user_id: "101" }, { user_id: "202" }] },
      });
      const sent = await stream.server("POST", `/channels/emno/${channelId}/message`, {
        message: { text: "Help is on the way", user_id: "101" },
      });

      const delivery = await eventually(() => received[0]);
      const expected = createHmac("sha256", TEST_API_SECRET).update(delivery.body).digest("hex");
      expect(delivery.headers["x-signature"]).toBe(expected);
      expect(delivery.headers["x-api-key"]).toBe(TEST_API_KEY);
      // The fields communication-service's StreamWebhookPayload requires.
      expect(JSON.parse(delivery.body)).toMatchObject({
        type: "message.new",
        cid: `emno:${channelId}`,
        channel_id: channelId,
        channel_type: "emno",
        message: { id: sent.body.message.id, text: "Help is on the way", type: "regular", user: { id: "101" } },
        user: { id: "101" },
        members: [{ user_id: "101" }, { user_id: "202" }],
        created_at: expect.any(String),
      });

      const deliveries = await readJson(await fetch(`${stream.baseUrl}/_emulate/stream/webhooks`));
      expect(deliveries.deliveries[0]).toMatchObject({ event_type: "message.new", url });
    } finally {
      await stream.close();
      await new Promise<void>((resolve) => receiver.close(() => resolve()));
    }
  });
});

describe("seed and reset", () => {
  function plainApp() {
    const store = new Store();
    const app = new Hono<AppEnv>();
    streamPlugin.register(app, store, new WebhookDispatcher(), "http://localhost:4000");
    streamPlugin.seed?.(store, "http://localhost:4000");
    return { app, store };
  }

  it("seeds users, channels and messages from config", async () => {
    const { app, store } = plainApp();
    seedFromConfig(store, "", {
      users: [{ id: "101", name: "Ada Admin", teams: ["7"] }],
      channels: [
        {
          type: "emno",
          id: "seeded",
          team: "7",
          created_by_id: "202",
          members: ["202"],
          data: { announcement_id: "1" },
          messages: [{ user_id: "202", text: "Is anyone there?" }],
        },
      ],
    });
    const response = await app.request(`http://localhost/channels?api_key=${DEFAULT_API_KEY}`, {
      method: "POST",
      headers: { Authorization: createServerToken(DEFAULT_API_SECRET), "stream-auth-type": "jwt" },
      body: JSON.stringify({ filter_conditions: { announcement_id: "1", last_message_at: { $exists: true } } }),
    });
    const body = await readJson(response);
    expect(body.channels).toHaveLength(1);
    expect(body.channels[0].messages[0].text).toBe("Is anyone there?");

    store.reset();
    streamPlugin.seed?.(store, "");
    const after = await app.request(`http://localhost/_emulate/stream/channels`);
    expect((await readJson(after)).channels).toEqual([]);
  });

  it("refuses a secret stream-chat-java could not sign with", () => {
    const { store } = plainApp();
    expect(() => seedFromConfig(store, "", { api_secret: "short" })).toThrow(/at least 32 bytes/);
  });
});

describe("Bun WebSocket adapter", () => {
  it("upgrades /connect and runs the handshake", () => {
    const store = new Store();
    streamPlugin.seed?.(store, "");
    const adapter = createStreamBunWebSocket(store);
    const token = signStreamToken(DEFAULT_API_SECRET, { user_id: "101" });
    const url = `http://localhost/connect?api_key=${DEFAULT_API_KEY}&authorization=${token}&stream-auth-type=jwt&json=${encodeURIComponent(
      JSON.stringify({ user_id: "101", user_details: { id: "101" } }),
    )}`;

    let upgradedWith: { data: { url: string } } | undefined;
    const fakeServer = {
      upgrade(_request: Request, options: { data: { url: string } }) {
        upgradedWith = options;
        return true;
      },
    };
    expect(
      adapter.upgrade(new Request("http://localhost/other", { headers: { upgrade: "websocket" } }), fakeServer),
    ).toBe(false);
    expect(adapter.upgrade(new Request(url, { headers: { upgrade: "websocket" } }), fakeServer)).toBe(true);

    const sent: string[] = [];
    const ws = { data: upgradedWith!.data, send: (data: string) => sent.push(data), close: () => {} };
    adapter.websocket.open(ws);
    expect(JSON.parse(sent[0])).toMatchObject({ type: "health.check", me: { id: "101" } });
    adapter.websocket.message(ws, JSON.stringify([{ type: "health.check", client_id: "x" }]));
    expect(JSON.parse(sent[1])).toMatchObject({ type: "health.check", connection_id: expect.any(String) });
    adapter.websocket.close(ws);
  });
});

describe("filters", () => {
  const doc = {
    type: "emno",
    announcement_id: "42",
    members: ["101", "202"],
    last_message_at: null,
    name: "Rene Recipient",
  };

  it("matches equality, $in, $exists, $autocomplete and logical operators", () => {
    expect(matchesFilter(doc, { type: "emno", announcement_id: "42" })).toBe(true);
    expect(matchesFilter(doc, { announcement_id: 42 })).toBe(false);
    expect(matchesFilter(doc, { members: { $in: ["202", "999"] } })).toBe(true);
    expect(matchesFilter(doc, { members: "101" })).toBe(true);
    expect(matchesFilter(doc, { last_message_at: { $exists: true } })).toBe(false);
    expect(matchesFilter(doc, { name: { $autocomplete: "rec" } })).toBe(true);
    expect(matchesFilter(doc, { $or: [{ type: "messaging" }, { type: "emno" }] })).toBe(true);
    expect(matchesFilter(doc, { $and: [{ type: "emno" }, { announcement_id: "1" }] })).toBe(false);
  });

  it("rejects operators it does not emulate", () => {
    expect(() => matchesFilter(doc, { name: { $regex: "x" } })).toThrow(/unsupported/);
  });
});
