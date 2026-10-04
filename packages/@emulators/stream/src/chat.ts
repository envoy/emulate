import { randomUUID } from "node:crypto";
import type { Store } from "@emulators/core";
import type {
  StreamChannel,
  StreamCustomData,
  StreamMember,
  StreamMessage,
  StreamMessageType,
  StreamRead,
  StreamUser,
} from "./entities.js";
import { inputError, notAllowed, notFound } from "./errors.js";
import { getAppConfig, getStreamStore, type StreamAppConfig, type StreamStore } from "./store.js";

/**
 * The emulated Stream Chat application: users, channels, members, messages and read
 * state, and the API response shapes the Stream SDKs parse.
 *
 * Every timestamp is an ISO 8601 string with milliseconds and a `Z`, which both
 * stream-chat (JS) and stream-chat-java (Jackson StdDateFormat) accept.
 */

const RESERVED_USER_FIELDS = new Set([
  "id",
  "role",
  "teams",
  "teams_role",
  "created_at",
  "updated_at",
  "last_active",
  "online",
  "banned",
  "deactivated_at",
  "deleted_at",
  "invisible",
  "language",
  "push_notifications",
]);

const RESERVED_CHANNEL_FIELDS = new Set([
  "id",
  "type",
  "cid",
  "team",
  "created_by",
  "created_by_id",
  "members",
  "frozen",
  "disabled",
  "config",
  "own_capabilities",
  "member_count",
  "created_at",
  "updated_at",
  "last_message_at",
  "hidden",
  "truncated_at",
  "deleted_at",
]);

const RESERVED_MESSAGE_FIELDS = new Set([
  "id",
  "text",
  "html",
  "mml",
  "type",
  "user",
  "user_id",
  "cid",
  "parent_id",
  "show_in_channel",
  "attachments",
  "mentioned_users",
  "silent",
  "pinned",
  "pinned_at",
  "pin_expires",
  "pinned_by",
  "quoted_message_id",
  "restricted_visibility",
  "poll_id",
  "shared_location",
  "created_at",
  "updated_at",
  "deleted_at",
  "latest_reactions",
  "own_reactions",
  "reaction_counts",
  "reaction_scores",
  "reaction_groups",
  "reply_count",
  "status",
]);

/** The channel type configuration returned on every channel. Uploads and reactions are not emulated. */
export function channelConfig(type: string): Record<string, unknown> {
  const now = "2020-01-01T00:00:00.000Z";
  return {
    name: type,
    typing_events: true,
    read_events: true,
    connect_events: true,
    search: false,
    reactions: false,
    replies: false,
    quotes: false,
    mutes: false,
    uploads: false,
    url_enrichment: false,
    custom_events: false,
    push_notifications: false,
    reminders: false,
    mark_messages_pending: false,
    polls: false,
    user_message_reminders: false,
    shared_locations: false,
    message_retention: "infinite",
    max_message_length: 5000,
    automod: "disabled",
    automod_behavior: "flag",
    blocklist_behavior: "flag",
    commands: [],
    created_at: now,
    updated_at: now,
  };
}

const MEMBER_CAPABILITIES = [
  "connect-events",
  "read-events",
  "typing-events",
  "send-message",
  "send-links",
  "update-own-message",
  "delete-own-message",
  "join-channel",
  "leave-channel",
  "add-members",
];

function splitCustom(input: Record<string, unknown>, reserved: Set<string>): StreamCustomData {
  const custom: StreamCustomData = {};
  for (const [key, value] of Object.entries(input)) {
    if (!reserved.has(key) && value !== undefined) custom[key] = value;
  }
  return custom;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function parseCid(cid: string): { type: string; id: string } {
  const index = cid.indexOf(":");
  if (index <= 0 || index === cid.length - 1) throw inputError(`cid "${cid}" must be <type>:<id>`);
  return { type: cid.slice(0, index), id: cid.slice(index + 1) };
}

export interface UserInput {
  id: string;
  name?: unknown;
  role?: unknown;
  teams?: unknown;
  [key: string]: unknown;
}

export interface MessageInput {
  id?: unknown;
  text?: unknown;
  type?: unknown;
  user_id?: unknown;
  user?: { id?: unknown };
  [key: string]: unknown;
}

export interface MessagePageOptions {
  limit?: number;
  id_lt?: string;
  id_lte?: string;
  id_gt?: string;
  id_gte?: string;
}

export class StreamChatApp {
  readonly db: StreamStore;

  constructor(readonly store: Store) {
    this.db = getStreamStore(store);
  }

  get app(): StreamAppConfig {
    return getAppConfig(this.store);
  }

  // Users

  findUser(userId: string): StreamUser | undefined {
    return this.db.users.findOneBy("user_id", userId);
  }

  /** Create or fully replace a user, as `POST /users` does. */
  upsertUser(input: UserInput): StreamUser {
    if (typeof input.id !== "string" || input.id.length === 0) throw inputError("user.id is a required field");
    const teams = input.teams === undefined ? undefined : this.teamsOf(input.teams);
    const name = typeof input.name === "string" ? input.name : null;
    const custom = splitCustom(input, new Set([...RESERVED_USER_FIELDS, "name"]));
    const existing = this.findUser(input.id);
    const role = typeof input.role === "string" ? input.role : (existing?.role ?? "user");
    if (existing) {
      return this.db.users.update(existing.id, {
        name,
        role,
        teams: teams ?? existing.teams,
        custom,
      })!;
    }
    return this.db.users.insert({ user_id: input.id, name, role, teams: teams ?? [], custom, last_active: null });
  }

  /** `PATCH /users`: set and unset individual fields. */
  partialUpdateUser(userId: string, set: Record<string, unknown> = {}, unset: string[] = []): StreamUser {
    const user = this.findUser(userId);
    if (!user) throw notFound(`user "${userId}" does not exist`);
    const custom = { ...user.custom };
    let name = user.name;
    let role = user.role;
    let teams = user.teams;
    for (const [key, value] of Object.entries(set)) {
      if (key === "name") name = typeof value === "string" ? value : null;
      else if (key === "role" && typeof value === "string") role = value;
      else if (key === "teams") teams = this.teamsOf(value);
      else if (!RESERVED_USER_FIELDS.has(key)) custom[key] = value;
    }
    for (const key of unset) {
      if (key === "name") name = null;
      else delete custom[key];
    }
    return this.db.users.update(user.id, { name, role, teams, custom })!;
  }

  /**
   * The user an id names, created on first sight. Stream creates a referenced user
   * implicitly in several server-side calls (a message's `user_id`, a channel's
   * `created_by`), and stream-chat-java's callers rely on that for `system`.
   */
  ensureUser(userId: string): StreamUser {
    return (
      this.findUser(userId) ??
      this.db.users.insert({
        user_id: userId,
        name: null,
        role: "user",
        teams: [],
        custom: {},
        last_active: null,
      })
    );
  }

  touchUser(userId: string): void {
    const user = this.findUser(userId);
    if (user) this.db.users.update(user.id, { last_active: new Date().toISOString() });
  }

  private teamsOf(value: unknown): string[] {
    if (!Array.isArray(value) || !value.every((team) => typeof team === "string")) {
      throw inputError("user.teams must be an array of strings");
    }
    return [...value];
  }

  // Channels

  findChannel(type: string, id: string): StreamChannel | undefined {
    return this.db.channels.findOneBy("cid", `${type}:${id}`);
  }

  requireChannel(type: string, id: string): StreamChannel {
    const channel = this.findChannel(type, id);
    if (!channel) throw notFound(`channel "${type}:${id}" does not exist`);
    return channel;
  }

  /** May this user see the channel? Multi-tenancy: a teamed channel is visible only to its team. */
  canAccess(userId: string, channel: StreamChannel): boolean {
    if (!channel.team) return true;
    return this.findUser(userId)?.teams.includes(channel.team) ?? false;
  }

  requireAccess(userId: string, channel: StreamChannel): void {
    if (!this.canAccess(userId, channel)) {
      throw notAllowed(`user "${userId}" is not allowed to access channel "${channel.cid}" of team "${channel.team}"`);
    }
  }

  /**
   * `POST /channels/{type}/{id}/query` with `data`: create the channel if it does not
   * exist, adding `data.members`. An existing channel is returned unchanged.
   */
  getOrCreateChannel(
    type: string,
    id: string,
    data: Record<string, unknown> | undefined,
    actingUserId: string | null,
  ): { channel: StreamChannel; created: boolean; addedMembers: StreamMember[] } {
    const existing = this.findChannel(type, id);
    if (existing) return { channel: existing, created: false, addedMembers: [] };
    if (!/^[a-zA-Z0-9_-]+$/.test(type)) throw inputError(`channel type "${type}" is not valid`);
    if (!/^[a-zA-Z0-9@_!-]+$/.test(id) || id.length > 64) throw inputError(`channel id "${id}" is not valid`);

    const input = data ?? {};
    const createdById = this.createdById(input) ?? actingUserId;
    if (!createdById)
      throw inputError("either data.created_by or data.created_by_id is required for server-side requests");
    this.ensureUser(createdById);
    const team = typeof input.team === "string" && input.team.length > 0 ? input.team : null;
    const channel = this.db.channels.insert({
      cid: `${type}:${id}`,
      type,
      channel_id: id,
      team,
      created_by_id: createdById,
      frozen: input.frozen === true,
      custom: splitCustom(input, RESERVED_CHANNEL_FIELDS),
      last_message_at: null,
    });
    const memberIds = this.memberIdsOf(input.members);
    const addedMembers = this.addMembers(channel, memberIds, createdById);
    return { channel, created: true, addedMembers };
  }

  private createdById(data: Record<string, unknown>): string | null {
    if (typeof data.created_by_id === "string") return data.created_by_id;
    const createdBy = data.created_by as { id?: unknown } | undefined;
    if (createdBy && typeof createdBy.id === "string") return createdBy.id;
    return null;
  }

  /** Accepts `["id"]` and `[{ user_id: "id" }]`, the two shapes the SDKs send. */
  memberIdsOf(value: unknown): string[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw inputError("members must be an array");
    return value.map((entry) => {
      if (typeof entry === "string") return entry;
      const userId =
        (entry as { user_id?: unknown; user?: { id?: unknown } })?.user_id ??
        (entry as { user?: { id?: unknown } })?.user?.id;
      if (typeof userId !== "string") throw inputError("each member needs a user_id");
      return userId;
    });
  }

  addMembers(channel: StreamChannel, userIds: string[], ownerId: string | null = null): StreamMember[] {
    const added: StreamMember[] = [];
    const now = new Date().toISOString();
    for (const userId of [...new Set(userIds)]) {
      if (this.findMember(channel.cid, userId)) continue;
      this.ensureUser(userId);
      added.push(
        this.db.members.insert({
          cid: channel.cid,
          user_id: userId,
          role: userId === ownerId ? "owner" : "member",
          channel_role: "channel_member",
        }),
      );
      if (!this.findRead(channel.cid, userId)) {
        this.db.reads.insert({
          cid: channel.cid,
          user_id: userId,
          last_read: now,
          last_read_message_id: null,
          unread_messages: 0,
        });
      }
    }
    if (added.length > 0) this.db.channels.update(channel.id, {});
    return added;
  }

  removeMembers(channel: StreamChannel, userIds: string[]): StreamMember[] {
    const removed: StreamMember[] = [];
    for (const userId of userIds) {
      const member = this.findMember(channel.cid, userId);
      if (!member) continue;
      this.db.members.delete(member.id);
      removed.push(member);
    }
    return removed;
  }

  findMember(cid: string, userId: string): StreamMember | undefined {
    return this.db.members.findBy("cid", cid).find((member) => member.user_id === userId);
  }

  members(cid: string): StreamMember[] {
    return this.db.members.findBy("cid", cid).sort((a, b) => a.id - b.id);
  }

  /** `POST /channels/{type}/{id}` with `data`: replace the channel's custom data. */
  replaceChannelData(channel: StreamChannel, data: Record<string, unknown>): StreamChannel {
    return this.db.channels.update(channel.id, {
      custom: splitCustom(data, RESERVED_CHANNEL_FIELDS),
      team: typeof data.team === "string" && data.team.length > 0 ? data.team : channel.team,
      frozen: typeof data.frozen === "boolean" ? data.frozen : channel.frozen,
    })!;
  }

  /** `PATCH /channels/{type}/{id}`: set and unset individual fields. */
  partialUpdateChannel(channel: StreamChannel, set: Record<string, unknown> = {}, unset: string[] = []): StreamChannel {
    const custom = { ...channel.custom };
    let frozen = channel.frozen;
    let team = channel.team;
    for (const [key, value] of Object.entries(set)) {
      if (key === "frozen") {
        if (typeof value !== "boolean") throw inputError("frozen must be a boolean");
        frozen = value;
      } else if (key === "team") {
        team = typeof value === "string" && value.length > 0 ? value : null;
      } else if (!RESERVED_CHANNEL_FIELDS.has(key)) {
        custom[key] = value;
      } else {
        throw inputError(`field "${key}" cannot be set with a partial update`);
      }
    }
    for (const key of unset) {
      if (key === "frozen") frozen = false;
      else delete custom[key];
    }
    return this.db.channels.update(channel.id, { custom, frozen, team })!;
  }

  // Messages

  findMessage(messageId: string): StreamMessage | undefined {
    return this.db.messages.findOneBy("message_id", messageId);
  }

  /** All of a channel's messages, oldest first. */
  messages(cid: string): StreamMessage[] {
    return this.db.messages.findBy("cid", cid).sort((a, b) => a.id - b.id);
  }

  messagePage(cid: string, options: MessagePageOptions = {}): StreamMessage[] {
    let messages = this.messages(cid);
    const position = (id: string | undefined) =>
      id === undefined ? -1 : messages.findIndex((message) => message.message_id === id);
    const limit = Math.max(0, Math.min(Number(options.limit ?? 25), 300));
    if (options.id_lt !== undefined || options.id_lte !== undefined) {
      const index = options.id_lt !== undefined ? position(options.id_lt) : position(options.id_lte) + 1;
      messages = index < 0 ? [] : messages.slice(0, index);
      return messages.slice(Math.max(0, messages.length - limit));
    }
    if (options.id_gt !== undefined || options.id_gte !== undefined) {
      const index = options.id_gt !== undefined ? position(options.id_gt) + 1 : position(options.id_gte);
      messages = index < 0 ? [] : messages.slice(index);
      return messages.slice(0, limit);
    }
    return messages.slice(Math.max(0, messages.length - limit));
  }

  sendMessage(
    channel: StreamChannel,
    userId: string,
    input: MessageInput,
    options: { server: boolean },
  ): StreamMessage {
    if (channel.frozen && !options.server) throw notAllowed(`channel "${channel.cid}" is frozen`);
    const text = input.text === undefined || input.text === null ? "" : input.text;
    if (typeof text !== "string") throw inputError("message.text must be a string");
    const type = (input.type ?? "regular") as StreamMessageType;
    if (type !== "regular" && type !== "system") {
      throw inputError(`message.type "${String(type)}" is not supported; use "regular" or "system"`);
    }
    if (type === "system" && !options.server) throw notAllowed("only server-side requests can send system messages");
    if (text.length === 0 && type === "regular") throw inputError("message.text is required");
    if (text.length > 5000) throw inputError("message.text is longer than 5000 characters");

    const messageId = typeof input.id === "string" && input.id.length > 0 ? input.id : randomUUID();
    if (this.findMessage(messageId)) throw inputError(`a message with id "${messageId}" already exists`);
    this.ensureUser(userId);
    const message = this.db.messages.insert({
      message_id: messageId,
      cid: channel.cid,
      user_id: userId,
      text,
      type,
      custom: splitCustom(input, RESERVED_MESSAGE_FIELDS),
    });

    this.db.channels.update(channel.id, { last_message_at: message.created_at });
    for (const read of this.db.reads.findBy("cid", channel.cid)) {
      if (read.user_id === userId) {
        this.db.reads.update(read.id, {
          last_read: message.created_at,
          last_read_message_id: message.message_id,
          unread_messages: 0,
        });
      } else if (this.findMember(channel.cid, read.user_id)) {
        this.db.reads.update(read.id, { unread_messages: read.unread_messages + 1 });
      }
    }
    return message;
  }

  // Read state

  findRead(cid: string, userId: string): StreamRead | undefined {
    return this.db.reads.findBy("cid", cid).find((read) => read.user_id === userId);
  }

  reads(cid: string): StreamRead[] {
    const memberIds = new Set(this.members(cid).map((member) => member.user_id));
    return this.db.reads.findBy("cid", cid).filter((read) => memberIds.has(read.user_id));
  }

  /** Mark a channel read for a member. Returns null for a non-member, as Stream does. */
  markRead(channel: StreamChannel, userId: string, messageId?: string): StreamRead | null {
    if (!this.findMember(channel.cid, userId)) return null;
    const last = messageId ? this.findMessage(messageId) : this.messages(channel.cid).at(-1);
    const read = this.findRead(channel.cid, userId)!;
    return this.db.reads.update(read.id, {
      last_read: new Date().toISOString(),
      last_read_message_id: last?.message_id ?? null,
      unread_messages: 0,
    })!;
  }

  unreadCounts(userId: string): { total_unread_count: number; unread_channels: number } {
    let total = 0;
    let channels = 0;
    for (const read of this.db.reads.findBy("user_id", userId)) {
      if (!this.findMember(read.cid, userId) || read.unread_messages === 0) continue;
      total += read.unread_messages;
      channels += 1;
    }
    return { total_unread_count: total, unread_channels: channels };
  }

  // Response shapes

  formatUser(user: StreamUser, online = false): Record<string, unknown> {
    return {
      ...user.custom,
      id: user.user_id,
      ...(user.name !== null ? { name: user.name } : {}),
      role: user.role,
      teams: user.teams,
      created_at: user.created_at,
      updated_at: user.updated_at,
      ...(user.last_active ? { last_active: user.last_active } : {}),
      banned: false,
      online,
    };
  }

  formatUserId(userId: string, online = false): Record<string, unknown> {
    const user = this.findUser(userId);
    return user ? this.formatUser(user, online) : { id: userId, role: "user", banned: false, online };
  }

  formatOwnUser(user: StreamUser): Record<string, unknown> {
    const counts = this.unreadCounts(user.user_id);
    return {
      ...this.formatUser(user, true),
      ...counts,
      unread_count: counts.total_unread_count,
      unread_threads: 0,
      channel_mutes: [],
      mutes: [],
      devices: [],
      invisible: false,
    };
  }

  formatMember(member: StreamMember, isOnline: (userId: string) => boolean): Record<string, unknown> {
    return {
      user_id: member.user_id,
      user: this.formatUserId(member.user_id, isOnline(member.user_id)),
      created_at: member.created_at,
      updated_at: member.updated_at,
      banned: false,
      shadow_banned: false,
      role: member.role,
      channel_role: member.channel_role,
      notifications_muted: false,
      status: "member",
    };
  }

  formatMessage(message: StreamMessage, isOnline: (userId: string) => boolean): Record<string, unknown> {
    return {
      ...message.custom,
      id: message.message_id,
      text: message.text,
      html: message.text ? `<p>${escapeHtml(message.text)}</p>\n` : "",
      type: message.type,
      user: this.formatUserId(message.user_id, isOnline(message.user_id)),
      cid: message.cid,
      attachments: [],
      latest_reactions: [],
      own_reactions: [],
      reaction_counts: {},
      reaction_scores: {},
      reaction_groups: null,
      reply_count: 0,
      deleted_reply_count: 0,
      created_at: message.created_at,
      updated_at: message.updated_at,
      shadowed: false,
      mentioned_users: [],
      silent: false,
      pinned: false,
      pinned_at: null,
      pinned_by: null,
      pin_expires: null,
      restricted_visibility: [],
    };
  }

  formatRead(read: StreamRead, isOnline: (userId: string) => boolean): Record<string, unknown> {
    return {
      user: this.formatUserId(read.user_id, isOnline(read.user_id)),
      last_read: read.last_read,
      unread_messages: read.unread_messages,
      ...(read.last_read_message_id ? { last_read_message_id: read.last_read_message_id } : {}),
    };
  }

  /** The `channel` object. */
  formatChannel(channel: StreamChannel, isOnline: (userId: string) => boolean): Record<string, unknown> {
    // A frozen channel refuses new messages, so it offers neither sending nor typing.
    const capabilities = channel.frozen
      ? MEMBER_CAPABILITIES.filter((capability) => capability !== "send-message" && capability !== "typing-events")
      : MEMBER_CAPABILITIES;
    return {
      ...channel.custom,
      id: channel.channel_id,
      type: channel.type,
      cid: channel.cid,
      ...(channel.last_message_at ? { last_message_at: channel.last_message_at } : {}),
      created_at: channel.created_at,
      updated_at: channel.updated_at,
      ...(channel.created_by_id
        ? { created_by: this.formatUserId(channel.created_by_id, isOnline(channel.created_by_id)) }
        : {}),
      frozen: channel.frozen,
      disabled: false,
      member_count: this.members(channel.cid).length,
      config: channelConfig(channel.type),
      own_capabilities: capabilities,
      hidden: false,
      ...(channel.team ? { team: channel.team } : {}),
    };
  }

  /** The full channel state: `ChannelAPIResponse` in stream-chat, `ChannelGetResponse` in Java. */
  formatChannelState(
    channel: StreamChannel,
    viewerId: string | null,
    isOnline: (userId: string) => boolean,
    watcherCount: number,
    messages: StreamMessage[],
  ): Record<string, unknown> {
    const members = this.members(channel.cid);
    const membership = viewerId ? members.find((member) => member.user_id === viewerId) : undefined;
    return {
      channel: this.formatChannel(channel, isOnline),
      members: members.map((member) => this.formatMember(member, isOnline)),
      messages: messages.map((message) => this.formatMessage(message, isOnline)),
      pinned_messages: [],
      read: this.reads(channel.cid).map((read) => this.formatRead(read, isOnline)),
      watcher_count: watcherCount,
      watchers: [],
      threads: [],
      ...(membership ? { membership: this.formatMember(membership, isOnline) } : {}),
    };
  }

  /** The flat document query filters and sorts evaluate against. */
  channelDocument(channel: StreamChannel): Record<string, unknown> {
    const members = this.members(channel.cid).map((member) => member.user_id);
    return {
      ...channel.custom,
      id: channel.channel_id,
      type: channel.type,
      cid: channel.cid,
      team: channel.team,
      frozen: channel.frozen,
      disabled: false,
      hidden: false,
      created_by_id: channel.created_by_id,
      created_at: channel.created_at,
      updated_at: channel.updated_at,
      last_message_at: channel.last_message_at,
      last_updated:
        channel.last_message_at && channel.last_message_at > channel.created_at
          ? channel.last_message_at
          : channel.created_at,
      member_count: members.length,
      members,
    };
  }

  userDocument(user: StreamUser): Record<string, unknown> {
    return {
      ...user.custom,
      id: user.user_id,
      name: user.name,
      role: user.role,
      teams: user.teams,
      created_at: user.created_at,
      updated_at: user.updated_at,
      last_active: user.last_active,
    };
  }
}
