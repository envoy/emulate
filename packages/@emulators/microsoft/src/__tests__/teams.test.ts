import { beforeEach, describe, expect, it } from "vitest";
import { Hono, Store, WebhookDispatcher, type TokenMap, type AppEnv } from "@emulators/core";
import { microsoftPlugin, seedFromConfig, getMicrosoftStore } from "../index.js";
import { ConnectorClient, MicrosoftAppCredentials } from "botframework-connector";

const base = "http://localhost:4005";
let app: Hono<AppEnv>;
let store: Store;
let botToken: string;
let graphToken: string;
const card = {
  type: "message",
  attachments: [
    {
      contentType: "application/vnd.microsoft.card.adaptive",
      content: {
        type: "AdaptiveCard",
        version: "1.4",
        body: [{ type: "TextBlock", text: "Hello" }],
        actions: [{ type: "Action.OpenUrl", title: "View", url: "https://example.com" }],
      },
    },
  ],
  channelData: { notification: { alert: true } },
};
async function request(path: string, method = "GET", body?: unknown, token = botToken) {
  return app.request(base + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function token(scope: string, secret = "secret") {
  return app.request(base + "/botframework.com/oauth2/v2.0/token", {
    method: "POST",
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: "bot", client_secret: secret, scope }),
  });
}
beforeEach(async () => {
  store = new Store();
  app = new Hono<AppEnv>();
  const tokens: TokenMap = new Map();
  microsoftPlugin.register(app, store, new WebhookDispatcher(), base, tokens);
  seedFromConfig(store, base, {
    users: [{ email: "reader@example.com", oid: "user" }],
    oauth_clients: [{ client_id: "bot", client_secret: "secret", name: "Bot", redirect_uris: [] }],
    teams_conversations: [
      { conversation_id: "chat", bot_id: "bot", tenant_id: "tenant", members: [{ id: "user" }], is_group: false },
    ],
    teams_installations: [
      { installation_id: "install", user_id: "user", app_id: "app", external_id: "external", conversation_id: "chat" },
    ],
  });
  botToken = ((await (await token("https://api.botframework.com/.default")).json()) as { access_token: string })
    .access_token;
  graphToken = ((await (await token("https://graph.microsoft.com/.default")).json()) as { access_token: string })
    .access_token;
});
describe("Teams provider boundaries", () => {
  it("discovers a user, installed app and chat before sending a rich card", async () => {
    const users: any = await (
      await request(
        "/v1.0/users?$filter=mail%20eq%20'reader@example.com'&$select=id,mail",
        "GET",
        undefined,
        graphToken,
      )
    ).json();
    expect(users.value).toEqual([{ id: "user", mail: "reader@example.com" }]);
    for (const filter of ["teamsApp/id eq 'app'", "teamsApp/externalId eq 'external'"]) {
      const installs: any = await (
        await request(
          `/v1.0/users/user/teamwork/installedApps?$filter=${encodeURIComponent(filter)}`,
          "GET",
          undefined,
          graphToken,
        )
      ).json();
      expect(installs.value[0].id).toBe("install");
    }
    const chat: any = await (
      await request("/v1.0/users/user/teamwork/installedApps/install/chat", "GET", undefined, graphToken)
    ).json();
    expect(chat).toMatchObject({ id: "chat", tenantId: "tenant" });
    const sent: any = await (await request(`/v3/conversations/${chat.id}/activities`, "POST", card)).json();
    expect(sent.id).toEqual(expect.any(String));
    const read: any = await (await request("/_emulator/teams/conversations/chat/activities")).json();
    expect(read.activities).toEqual([{ ...card, id: sent.id }]);
  });
  it("supports the official Connector SDK create, send, reply, update and delete wire contracts", async () => {
    const credentials = new MicrosoftAppCredentials("bot", "secret");
    // Keep authentication real at the HTTP boundary while avoiding external token discovery.
    credentials.getToken = async () => botToken;
    const client = new ConnectorClient(credentials, {
      baseUri: base,
      httpClient: {
        async sendRequest(req) {
          const response = await app.request(req.url, {
            method: req.method,
            headers: req.headers.rawHeaders(),
            body: req.body,
          });
          const bodyAsText = await response.text();
          return {
            request: req,
            status: response.status,
            headers: req.headers,
            bodyAsText,
            parsedBody: bodyAsText ? JSON.parse(bodyAsText) : undefined,
          };
        },
      },
    });
    const conversation = await client.conversations.createConversation({
      bot: { id: "bot", name: "Bot" },
      members: [{ id: "user", name: "Reader" }],
      isGroup: false,
      tenantId: "tenant",
    } as any);
    const sent = await client.conversations.sendToConversation(conversation.id!, card as any);
    await client.conversations.replyToActivity(conversation.id!, sent.id!, { type: "message", text: "Reply" } as any);
    await client.conversations.updateActivity(conversation.id!, sent.id!, { ...card, text: "Updated" } as any);
    const read: any = await (await request(`/_emulator/teams/conversations/${conversation.id}/activities`)).json();
    expect(read.activities).toHaveLength(2);
    expect(read.activities[0]).toMatchObject({ id: sent.id, text: "Updated", attachments: card.attachments });
    expect(read.activities[1].replyToId).toBe(sent.id);
    await client.conversations.deleteActivity(conversation.id!, sent.id!);
    expect(getMicrosoftStore(store).activities.findBy("conversation_id", conversation.id!)).toHaveLength(1);
    await expect(
      client.conversations.sendToConversation("missing", { type: "message", text: "Hello" } as any),
    ).rejects.toMatchObject({ statusCode: 404, code: "ConversationNotFound" });
  });
  it("rejects credentials, missing or wrong-audience tokens without writing", async () => {
    expect(
      (await app.request(base + "/v3/conversations/chat/activities", { method: "POST", body: JSON.stringify(card) }))
        .status,
    ).toBe(401);
    expect((await token("https://api.botframework.com/.default", "wrong")).status).toBe(401);
    expect((await request("/v3/conversations/chat/activities", "POST", card, "invalid")).status).toBe(401);
    expect((await request("/v3/conversations/chat/activities", "POST", card, graphToken)).status).toBe(403);
    expect((await request("/v1.0/users", "GET", undefined, botToken)).status).toBe(403);
    expect(getMicrosoftStore(store).activities.all()).toEqual([]);
  });
  it("rejects missing conversations, blocked bots, malformed cards and unknown updates", async () => {
    expect((await request("/v3/conversations/missing/activities", "POST", card)).status).toBe(404);
    for (const body of [null, [], {}, { type: "message" }, { type: "message", attachments: [{}] }]) {
      expect((await request("/v3/conversations/chat/activities", "POST", body)).status).toBe(400);
    }
    expect((await request("/v3/conversations/chat/activities/missing", "PUT", card)).status).toBe(404);
    const ms = getMicrosoftStore(store);
    ms.conversations.update(ms.conversations.all()[0].id, { blocked: true });
    expect((await request("/v3/conversations/chat/activities", "POST", card)).status).toBe(403);
    expect(ms.activities.all()).toHaveLength(0);
  });
  it("returns empty discovery only for absent installations and rejects unsupported filters", async () => {
    expect((await request("/v1.0/users?$filter=invalid", "GET", undefined, graphToken)).status).toBe(400);
    const response = await request(
      "/v1.0/users/user/teamwork/installedApps?$filter=teamsApp/id%20eq%20'other'",
      "GET",
      undefined,
      graphToken,
    );
    expect(await response.json()).toEqual({ value: [] });
    expect(
      (await request("/v1.0/users/user/teamwork/installedApps/missing/chat", "GET", undefined, graphToken)).status,
    ).toBe(404);
  });
  it("preserves rich message state across snapshots and clears it on reset", async () => {
    const response = await request("/v3/conversations/chat/activities", "POST", card);
    expect(response.status).toBe(200);
    const snapshot = JSON.parse(JSON.stringify(store.snapshot()));
    store.reset();
    expect((await request("/_emulator/teams/conversations/chat/activities")).status).toBe(404);
    store.restore(snapshot);
    const read = (await (await request("/_emulator/teams/conversations/chat/activities")).json()) as {
      activities: unknown[];
    };
    expect(read.activities).toEqual([expect.objectContaining(card)]);
  });
  it("isolates bots and conversation activity IDs and rejects malformed JSON atomically", async () => {
    const sent = (await (await request("/v3/conversations/chat/activities", "POST", card)).json()) as { id: string };
    const ms = getMicrosoftStore(store);
    ms.conversations.insert({
      conversation_id: "other",
      bot_id: "other-bot",
      tenant_id: "tenant",
      members: [],
      is_group: true,
    });
    expect((await request("/_emulator/teams/conversations/other/activities")).status).toBe(403);
    expect((await request("/v3/conversations/other/activities", "POST", card)).status).toBe(403);
    ms.conversations.update(ms.conversations.findOneBy("conversation_id", "other")!.id, { bot_id: "bot" });
    for (const method of ["PUT", "DELETE", "POST"]) {
      expect(
        (await request(`/v3/conversations/other/activities/${sent.id}`, method, method === "DELETE" ? undefined : card))
          .status,
      ).toBe(404);
    }
    const malformed = await app.request(base + `/v3/conversations/chat/activities/${sent.id}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${botToken}`, "Content-Type": "application/json" },
      body: "{",
    });
    expect(malformed.status).toBe(400);
    expect(ms.activities.all()).toHaveLength(1);
    expect(ms.activities.all()[0].payload).toEqual({ ...card, id: sent.id });
    expect(
      (await request("/v3/conversations", "POST", { bot: { id: "other-bot" }, members: [{ id: "user" }] })).status,
    ).toBe(403);
    expect(ms.conversations.all()).toHaveLength(2);
  });
  it("recovers from a missing conversation and stores an initial hero card", async () => {
    const missing = await request("/v3/conversations/expired/activities", "POST", card);
    expect(await missing.json()).toMatchObject({ error: { code: "ConversationNotFound" } });
    const activity = {
      type: "message",
      attachments: [
        {
          contentType: "application/vnd.microsoft.card.hero",
          content: { title: "Hello", buttons: [{ type: "openUrl", title: "Open", value: "https://example.com" }] },
        },
        { contentType: "image/png", contentUrl: "https://example.com/image.png", name: "Image" },
      ],
    };
    const response = await request("/v3/conversations", "POST", {
      bot: { id: "bot" },
      members: [{ id: "user" }],
      channelData: { tenant: { id: "tenant" } },
      activity,
    });
    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: string; activityId: string };
    const read = (await (await request(`/_emulator/teams/conversations/${created.id}/activities`)).json()) as {
      activities: unknown[];
    };
    expect(read.activities).toEqual([{ ...activity, id: created.activityId }]);
    expect(
      (await request(`/v3/conversations/${created.id}/activities`, "POST", { type: "message", text: "Follow-up" }))
        .status,
    ).toBe(200);
  });
});
