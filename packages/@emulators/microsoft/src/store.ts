import { Store, type Collection } from "@emulators/core";
import type {
  MicrosoftUser,
  MicrosoftOAuthClient,
  TeamsConversation,
  TeamsActivity,
  TeamsInstallation,
} from "./entities.js";

export interface MicrosoftStore {
  conversations: Collection<TeamsConversation>;
  activities: Collection<TeamsActivity>;
  installations: Collection<TeamsInstallation>;
  users: Collection<MicrosoftUser>;
  oauthClients: Collection<MicrosoftOAuthClient>;
}

export function getMicrosoftStore(store: Store): MicrosoftStore {
  return {
    conversations: store.collection<TeamsConversation>("microsoft.teams_conversations", ["conversation_id"]),
    activities: store.collection<TeamsActivity>("microsoft.teams_activities", ["conversation_id", "activity_id"]),
    installations: store.collection<TeamsInstallation>("microsoft.teams_installations", ["user_id"]),
    users: store.collection<MicrosoftUser>("microsoft.users", ["oid", "email"]),
    oauthClients: store.collection<MicrosoftOAuthClient>("microsoft.oauth_clients", ["client_id"]),
  };
}
