import type { Entity } from "@emulators/core";

export interface MicrosoftUser extends Entity {
  /** Object ID (oid) — unique per-tenant user identifier */
  oid: string;
  email: string;
  name: string;
  given_name: string;
  family_name: string;
  email_verified: boolean;
  /** Microsoft tenant ID */
  tenant_id: string;
  /** User principal name (usually email) */
  preferred_username: string;
}

export interface MicrosoftOAuthClient extends Entity {
  client_id: string;
  client_secret: string;
  name: string;
  redirect_uris: string[];
  /** Tenant ID this app is registered in */
  tenant_id: string;
}

/** Bot Connector state. Activity payloads retain arbitrary channel/card fields. */
export interface TeamsConversation extends Entity {
  conversation_id: string;
  bot_id: string;
  tenant_id: string;
  members: Array<{ id: string }>;
  is_group: boolean;
  blocked?: boolean;
}
export interface TeamsActivity extends Entity {
  activity_id: string;
  conversation_id: string;
  payload: Record<string, unknown>;
}
export interface TeamsInstallation extends Entity {
  installation_id: string;
  user_id: string;
  app_id: string;
  external_id?: string;
  conversation_id: string;
}
