import { randomUUID } from "node:crypto";
import { StreamChat, type Event } from "stream-chat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { signStreamToken } from "../auth.js";
import { eventually, startStream, TEST_API_KEY, TEST_API_SECRET, type RunningStream } from "./helpers.js";

/**
 * The browser side of Envoy Response's chat, driven with the real stream-chat client at
 * the version react-rich-components ships (9.20.3): a WebSocket handshake, queryChannels
 * with the control centre's filter, watch, addMembers, sendMessage, and the events the
 * other participant receives.
 */

// The channel fields communication-service writes, as react-rich-components declares them
// (src/chat/custom-stream-data.ts), so filters and channel.data type-check.
declare module "stream-chat" {
  interface CustomChannelData {
    name?: string;
    announcement_id?: string;
    recipient_user_id?: string;
  }
}

const TEAM = "7";
const ANNOUNCEMENT_ID = "4242";

function client(stream: RunningStream): StreamChat {
  return new StreamChat(TEST_API_KEY, {
    baseURL: stream.baseUrl,
    allowServerSideConnect: true,
  });
}

function serverClient(stream: RunningStream): StreamChat {
  return new StreamChat(TEST_API_KEY, TEST_API_SECRET, { baseURL: stream.baseUrl });
}

function collect(chat: StreamChat): Event[] {
  const events: Event[] = [];
  chat.on((event) => {
    events.push(event);
  });
  return events;
}

describe("stream-chat 9.20.3 against the emulator", () => {
  let stream: RunningStream;
  let channelId: string;
  const clients: StreamChat[] = [];

  beforeEach(async () => {
    stream = await startStream();
    channelId = randomUUID();
    const server = serverClient(stream);
    await server.upsertUsers([
      { id: "admin-1", name: "Ada Admin", teams: [TEAM] },
      { id: "recipient-1", name: "Rene Recipient", teams: [TEAM] },
      { id: "outsider-1", name: "Oscar Outsider", teams: ["8"] },
    ]);
    // What communication-service does when a recipient opens chat: create the channel
    // with the recipient as a member, then post the announcement as a system message.
    const channel = server.channel("emno", channelId, {
      team: TEAM,
      created_by_id: "recipient-1",
      members: ["recipient-1"],
      name: "Rene Recipient",
      announcement_id: ANNOUNCEMENT_ID,
      recipient_user_id: "recipient-1",
    } as Record<string, unknown>);
    await channel.create();
    await channel.sendMessage({ text: "Fire drill", type: "system", user_id: "system" } as never);
  });

  afterEach(async () => {
    for (const chat of clients.splice(0)) await chat.disconnectUser().catch(() => {});
    await stream.close();
  });

  async function connect(userId: string): Promise<StreamChat> {
    const chat = client(stream);
    clients.push(chat);
    await chat.connectUser({ id: userId }, stream.userToken(userId));
    return chat;
  }

  it("connects over the WebSocket and receives the own user", async () => {
    const chat = client(stream);
    clients.push(chat);
    const response = await chat.connectUser({ id: "admin-1" }, stream.userToken("admin-1"));

    expect(response?.connection_id).toBeTruthy();
    expect(response?.me?.id).toBe("admin-1");
    expect(response?.me?.teams).toEqual([TEAM]);
    expect(chat.user?.name).toBe("Ada Admin");
    expect(chat.wsConnection?.isHealthy).toBe(true);
  });

  it("lists the incident's conversations with the control centre's filter", async () => {
    const admin = await connect("admin-1");
    const channels = await admin.queryChannels(
      { type: "emno", announcement_id: ANNOUNCEMENT_ID, last_message_at: { $exists: true } },
      {},
      { limit: 10, message_limit: 25 },
    );

    expect(channels).toHaveLength(1);
    const [channel] = channels;
    expect(channel.cid).toBe(`emno:${channelId}`);
    expect(channel.data?.name).toBe("Rene Recipient");
    expect(channel.state.messages.map((message) => message.text)).toEqual(["Fire drill"]);
    expect(channel.state.messages[0].type).toBe("system");
    // The admin is not a member until the first send adds them.
    expect(channel.state.membership.channel_role).toBeUndefined();

    const noMatch = await admin.queryChannels({ type: "emno", announcement_id: "9999" });
    expect(noMatch).toHaveLength(0);
    // Equality is type-sensitive, as in Stream: the id is stored as a string.
    const numeric = await admin.queryChannels({ type: "emno", announcement_id: Number(ANNOUNCEMENT_ID) } as never);
    expect(numeric).toHaveLength(0);
  });

  it("hides a conversation with no messages from the list", async () => {
    const server = serverClient(stream);
    await server
      .channel("emno", randomUUID(), {
        team: TEAM,
        created_by_id: "recipient-1",
        members: ["recipient-1"],
        announcement_id: ANNOUNCEMENT_ID,
      } as Record<string, unknown>)
      .create();

    const admin = await connect("admin-1");
    const all = await admin.queryChannels({ type: "emno", announcement_id: ANNOUNCEMENT_ID });
    const listed = await admin.queryChannels({
      type: "emno",
      announcement_id: ANNOUNCEMENT_ID,
      last_message_at: { $exists: true },
    });
    expect(all).toHaveLength(2);
    expect(listed).toHaveLength(1);
  });

  it("joins, sends, and delivers message.new to the other participant", async () => {
    const recipient = await connect("recipient-1");
    const recipientChannel = recipient.channel("emno", channelId);
    await recipientChannel.watch();
    const recipientEvents = collect(recipient);

    const admin = await connect("admin-1");
    const [channel] = await admin.queryChannels({ type: "emno", announcement_id: ANNOUNCEMENT_ID });
    await channel.watch();

    // RRC's submit handler: join on the first send, then send.
    await channel.addMembers(["admin-1"]);
    const { message } = await channel.sendMessage({ text: "Are you safe?" });

    expect(message.text).toBe("Are you safe?");
    expect(message.user?.id).toBe("admin-1");

    const delivered = await eventually(() =>
      recipientEvents.find((event) => event.type === "message.new" && event.message?.id === message.id),
    );
    expect(delivered.cid).toBe(`emno:${channelId}`);
    expect(delivered.user?.id).toBe("admin-1");
    expect(recipientEvents.some((event) => event.type === "member.added" && event.user?.id === "admin-1")).toBe(true);
    await eventually(() => (recipientChannel.state.messages.some((item) => item.id === message.id) ? true : undefined));
    expect(recipientChannel.state.messages.map((item) => item.text)).toEqual(["Fire drill", "Are you safe?"]);
    // The system message and the reply arrived after the recipient joined.
    expect(recipientChannel.countUnread()).toBe(2);

    // The send is durable: a fresh query returns it, and the sender is now a member.
    const [requeried] = await admin.queryChannels({ cid: `emno:${channelId}` }, {}, { watch: false });
    expect(requeried.state.messages.map((item) => item.text)).toEqual(["Fire drill", "Are you safe?"]);
    expect(requeried.state.members["admin-1"]).toBeDefined();
  });

  it("marks read and tells the other watcher", async () => {
    const admin = await connect("admin-1");
    const adminChannel = admin.channel("emno", channelId);
    await adminChannel.watch();
    await adminChannel.addMembers(["admin-1"]);
    await adminChannel.sendMessage({ text: "Reply when you can" });
    const adminEvents = collect(admin);

    const recipient = await connect("recipient-1");
    const recipientChannel = recipient.channel("emno", channelId);
    await recipientChannel.watch();
    expect(recipientChannel.countUnread()).toBe(2);

    const response = await recipientChannel.markRead();
    expect(response?.event?.type).toBe("message.read");
    expect(recipientChannel.countUnread()).toBe(0);
    const read = await eventually(() =>
      adminEvents.find((event) => event.type === "message.read" && event.user?.id === "recipient-1"),
    );
    expect(read.cid).toBe(`emno:${channelId}`);
  });

  it("relays typing indicators to watchers", async () => {
    const recipient = await connect("recipient-1");
    await recipient.channel("emno", channelId).watch();
    const recipientEvents = collect(recipient);

    const admin = await connect("admin-1");
    const channel = admin.channel("emno", channelId);
    await channel.watch();
    await channel.keystroke();

    const typing = await eventually(() => recipientEvents.find((event) => event.type === "typing.start"));
    expect(typing.user?.id).toBe("admin-1");
  });

  it("notifies a connected member who is not watching", async () => {
    const recipient = await connect("recipient-1");
    const recipientEvents = collect(recipient);

    const admin = await connect("admin-1");
    const channel = admin.channel("emno", channelId);
    await channel.watch();
    await channel.addMembers(["admin-1"]);
    await channel.sendMessage({ text: "Ping" });

    const notification = await eventually(() =>
      recipientEvents.find((event) => event.type === "notification.message_new"),
    );
    expect(notification.message?.text).toBe("Ping");
    expect(notification.channel?.cid).toBe(`emno:${channelId}`);
  });

  it("keeps a team's channels from another team", async () => {
    const outsider = await connect("outsider-1");
    expect(await outsider.queryChannels({ type: "emno" })).toHaveLength(0);
    await expect(outsider.channel("emno", channelId).watch()).rejects.toMatchObject({ code: 17, status: 403 });
    await expect(outsider.channel("emno", randomUUID(), { team: TEAM } as never).create()).rejects.toMatchObject({
      code: 17,
      status: 403,
    });
  });

  it("refuses a client message to a frozen channel", async () => {
    await stream.server("PATCH", `/channels/emno/${channelId}`, { set: { frozen: true } });
    const admin = await connect("admin-1");
    const channel = admin.channel("emno", channelId);
    await channel.watch();
    expect(channel.data?.frozen).toBe(true);
    await expect(channel.sendMessage({ text: "too late" })).rejects.toMatchObject({ code: 17, status: 403 });
  });

  it("rejects a token signed with another secret", async () => {
    const chat = client(stream);
    clients.push(chat);
    const forged = signStreamToken("not-the-secret", { user_id: "admin-1" });
    await expect(chat.connectUser({ id: "admin-1" }, forged)).rejects.toThrow(/signature/);
  });

  it("rejects an expired token with Stream's expiry code", async () => {
    const expired = signStreamToken(TEST_API_SECRET, { user_id: "admin-1", exp: Math.floor(Date.now() / 1000) - 60 });
    const response = await fetch(`${stream.baseUrl}/channels?api_key=${TEST_API_KEY}`, {
      method: "POST",
      headers: { Authorization: expired, "stream-auth-type": "jwt", "Content-Type": "application/json" },
      body: JSON.stringify({ filter_conditions: {} }),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 40, StatusCode: 401 });
  });
});
