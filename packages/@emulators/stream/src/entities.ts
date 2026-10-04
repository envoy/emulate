import type { Entity } from "@emulators/core";

export type StreamCustomData = Record<string, unknown>;

export interface StreamUser extends Entity {
  user_id: string;
  name: string | null;
  role: string;
  teams: string[];
  custom: StreamCustomData;
  last_active: string | null;
}

export interface StreamChannel extends Entity {
  cid: string;
  type: string;
  channel_id: string;
  team: string | null;
  created_by_id: string | null;
  frozen: boolean;
  custom: StreamCustomData;
  last_message_at: string | null;
}

export interface StreamMember extends Entity {
  cid: string;
  user_id: string;
  role: "owner" | "member";
  channel_role: "channel_member" | "channel_moderator";
}

export type StreamMessageType = "regular" | "system";

export interface StreamMessage extends Entity {
  message_id: string;
  cid: string;
  user_id: string;
  text: string;
  type: StreamMessageType;
  custom: StreamCustomData;
}

export interface StreamRead extends Entity {
  cid: string;
  user_id: string;
  last_read: string;
  last_read_message_id: string | null;
  unread_messages: number;
}

export interface StreamWebhookDelivery extends Entity {
  event_type: string;
  url: string;
  cid: string | null;
  status_code: number | null;
  error: string | null;
  payload: string;
}
