import type { Hono } from "@emulators/core";
import type { ServicePlugin, Store, WebhookDispatcher, TokenMap, AppEnv, RouteContext } from "@emulators/core";
import { getMicrosoftStore } from "./store.js";
import { generateOid, DEFAULT_TENANT_ID } from "./helpers.js";
import { teamsRoutes } from "./routes/teams.js";
import { oauthRoutes } from "./routes/oauth.js";

export { getMicrosoftStore, type MicrosoftStore } from "./store.js";
export * from "./entities.js";

export interface MicrosoftSeedConfig {
  teams_conversations?: Array<Omit<import("./entities.js").TeamsConversation, "id" | "created_at" | "updated_at">>;
  teams_installations?: Array<Omit<import("./entities.js").TeamsInstallation, "id" | "created_at" | "updated_at">>;

  users?: Array<{
    email: string;
    oid?: string;
    name?: string;
    given_name?: string;
    family_name?: string;
    tenant_id?: string;
  }>;
  oauth_clients?: Array<{
    client_id: string;
    client_secret: string;
    name: string;
    redirect_uris: string[];
    tenant_id?: string;
  }>;
}

function seedDefaults(store: Store, _baseUrl: string): void {
  const ms = getMicrosoftStore(store);

  ms.users.insert({
    oid: generateOid(),
    email: "testuser@outlook.com",
    name: "Test User",
    given_name: "Test",
    family_name: "User",
    email_verified: true,
    tenant_id: DEFAULT_TENANT_ID,
    preferred_username: "testuser@outlook.com",
  });
}

export function seedFromConfig(store: Store, _baseUrl: string, config: MicrosoftSeedConfig): void {
  const ms = getMicrosoftStore(store);

  for (const conversation of config.teams_conversations ?? []) {
    if (!ms.conversations.findOneBy("conversation_id", conversation.conversation_id))
      ms.conversations.insert(conversation);
  }
  for (const installation of config.teams_installations ?? []) {
    if (
      !ms.installations
        .all()
        .some((i) => i.user_id === installation.user_id && i.installation_id === installation.installation_id)
    )
      ms.installations.insert(installation);
  }
  if (config.users) {
    for (const u of config.users) {
      const existing = ms.users.findOneBy("email", u.email);
      if (existing) continue;

      const nameParts = (u.name ?? "").split(/\s+/);
      ms.users.insert({
        oid: u.oid ?? generateOid(),
        email: u.email,
        name: u.name ?? u.email.split("@")[0],
        given_name: u.given_name ?? nameParts[0] ?? "",
        family_name: u.family_name ?? nameParts.slice(1).join(" ") ?? "",
        email_verified: true,
        tenant_id: u.tenant_id ?? DEFAULT_TENANT_ID,
        preferred_username: u.email,
      });
    }
  }

  if (config.oauth_clients) {
    for (const client of config.oauth_clients) {
      const existing = ms.oauthClients.findOneBy("client_id", client.client_id);
      if (existing) continue;
      ms.oauthClients.insert({
        client_id: client.client_id,
        client_secret: client.client_secret,
        name: client.name,
        redirect_uris: client.redirect_uris,
        tenant_id: client.tenant_id ?? DEFAULT_TENANT_ID,
      });
    }
  }
}

export const microsoftPlugin: ServicePlugin = {
  name: "microsoft",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void {
    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    teamsRoutes(ctx);
    oauthRoutes(ctx);
  },
  seed(store: Store, baseUrl: string): void {
    seedDefaults(store, baseUrl);
  },
};

export default microsoftPlugin;
