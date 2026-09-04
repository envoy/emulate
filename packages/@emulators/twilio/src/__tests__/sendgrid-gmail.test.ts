import { describe, expect, it } from "vitest";
import { Hono, Store, WebhookDispatcher, authMiddleware, type AppEnv, type TokenMap } from "@emulators/core";
import { googlePlugin, seedFromConfig } from "@emulators/google";
import { createTwilioPlugin, seedFromConfig as seedTwilio } from "../index.js";

describe("SendGrid delivery to Gmail", () => {
  it.each(["http", "network"])("does not report acceptance when Gmail delivery fails (%s)", async (failure) => {
    const app = new Hono<AppEnv>();
    const store = new Store();
    const plugin = createTwilioPlugin({
      sendgrid: {
        gmail: { baseUrl: "http://gmail.local", accessToken: "inbox-token" },
        fetch: async () => {
          if (failure === "network") throw new Error("connection closed");
          return new Response(null, { status: 503 });
        },
      },
    });
    plugin.register(app, store, new WebhookDispatcher(), "http://twilio.local");
    const response = await app.request("http://twilio.local/v3/mail/send", {
      method: "POST",
      headers: { Authorization: "Bearer SG.emulate-test-key", "Content-Type": "application/json" },
      body: JSON.stringify({
        from: { email: "from@example.com" },
        personalizations: [{ to: [{ email: "to@example.com" }] }],
        subject: "Test",
        content: [{ type: "text/plain", value: "Hello" }],
      }),
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      errors: [{ message: "Emulated Gmail delivery failed.", field: null, help: null }],
    });
    expect(store.collection("twilio.sendgrid.emails").all()).toEqual([]);
  });

  it.each([false, true])(
    "makes an invitation searchable and readable through Gmail's API (attachment: %s)",
    async (withAttachment) => {
      const google = new Hono<AppEnv>();
      const googleStore = new Store();
      const webhooks = new WebhookDispatcher();
      const tokens: TokenMap = new Map([
        [
          "inbox-token",
          {
            login: "automation@example.com",
            id: 1,
            scopes: ["https://www.googleapis.com/auth/gmail.modify"],
          },
        ],
      ]);
      google.use("*", authMiddleware(tokens));
      googlePlugin.register(google, googleStore, webhooks, "http://gmail.local", tokens);
      googlePlugin.seed?.(googleStore, "http://gmail.local");
      seedFromConfig(googleStore, "http://gmail.local", {
        users: [{ email: "automation@example.com", name: "Automation" }],
      });
      const twilio = new Hono<AppEnv>();
      const store = new Store();
      const plugin = createTwilioPlugin({
        sendgrid: {
          apiKeys: ["SG.invite-test"],
          fetch: (url, init) => google.request(url, init),
        },
      });
      plugin.register(twilio, store, webhooks, "http://twilio.local");
      plugin.seed?.(store, "http://twilio.local");
      seedTwilio(store, "http://twilio.local", {
        sendgrid: { gmail: { base_url: "http://gmail.local", access_token: "inbox-token" } },
      });
      const html = '<a href="https://dashboard.example.com/invite/123">Accept invitation</a>';
      const accepted = await twilio.request("http://twilio.local/v3/mail/send", {
        method: "POST",
        headers: { Authorization: "Bearer SG.invite-test", "Content-Type": "application/json" },
        body: JSON.stringify({
          from: { email: "invites@example.com", name: "Reception" },
          personalizations: [
            {
              to: [{ email: "automation+guest@example.com" }],
              cc: [{ email: "host@example.com" }],
              bcc: [{ email: "audit@example.com" }],
            },
          ],
          headers: { "X-Hotel2-Source": "hub-events-queue" },
          reply_to: { email: "reception@example.com" },
          subject: "Invitation to visit",
          content: [{ type: "text/html", value: html }],
          ...(withAttachment
            ? { attachments: [{ filename: "badge.bin", type: "application/octet-stream", content: "AP+A" }] }
            : {}),
        }),
      });
      expect(accepted.status).toBe(202);
      const headers = { Authorization: "Bearer inbox-token" };
      const query = encodeURIComponent("to:automation+guest@example.com subject:Invitation");
      const listing = await google.request(`http://gmail.local/gmail/v1/users/me/messages?q=${query}`, { headers });
      expect(listing.status).toBe(200);
      const list = (await listing.json()) as { messages: Array<{ id: string }> };
      expect(list.messages).toHaveLength(1);
      const detail = await google.request(
        `http://gmail.local/gmail/v1/users/me/messages/${list.messages[0].id}?format=full`,
        { headers },
      );
      const message = (await detail.json()) as {
        payload: {
          body: { data: string };
          headers: Array<{ name: string; value: string }>;
          parts?: Array<{ mimeType: string; filename: string; body: { data: string; attachmentId?: string } }>;
        };
      };
      const htmlData = withAttachment
        ? message.payload.parts?.find((part) => part.mimeType === "text/html")?.body.data
        : message.payload.body.data;
      expect(htmlData).toBeTruthy();
      expect(Buffer.from(htmlData!, "base64url").toString("utf8")).toBe(html);
      expect(message.payload.headers).toContainEqual({ name: "Subject", value: "Invitation to visit" });
      expect(message.payload.headers).toContainEqual({ name: "Cc", value: "host@example.com" });
      expect(message.payload.headers).toContainEqual({ name: "Bcc", value: "audit@example.com" });
      const rawResponse = await google.request(
        `http://gmail.local/gmail/v1/users/me/messages/${list.messages[0].id}?format=raw`,
        { headers },
      );
      const rawMessage = (await rawResponse.json()) as { raw: string };
      expect(Buffer.from(rawMessage.raw, "base64url").toString("utf8")).toMatch(/X-Hotel2-Source: hub-events-queue/i);
      expect(message.payload.headers).toContainEqual({ name: "Reply-To", value: "reception@example.com" });
      if (withAttachment) {
        const attachment = message.payload.parts?.find((part) => part.filename === "badge.bin");
        expect(attachment?.body.attachmentId).toBeTruthy();
        const response = await google.request(
          `http://gmail.local/gmail/v1/users/me/messages/${list.messages[0].id}/attachments/${attachment!.body.attachmentId}`,
          { headers },
        );
        expect(response.status).toBe(200);
        const body = (await response.json()) as { data: string };
        expect([...Buffer.from(body.data, "base64url")]).toEqual([0, 255, 128]);
      }
    },
  );
});
