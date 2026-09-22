import { randomUUID } from "node:crypto";
import { type Entity, type ServicePlugin, type Store } from "@emulators/core";
import { browserRoutes } from "./browser.js";

export interface TurnstileSite extends Entity {
  sitekey: string;
  secret: string;
  hostnames: string[];
}
export interface TurnstileToken extends Entity {
  token: string;
  sitekey: string;
  hostname: string;
  action: string;
  cdata: string;
  expires_at: number;
  consumed: boolean;
}
export interface CloudflareSeedConfig {
  sites?: Array<Pick<TurnstileSite, "sitekey" | "secret" | "hostnames">>;
}
export function getCloudflareStore(store: Store) {
  return {
    sites: store.collection<TurnstileSite>("cloudflare.sites", ["sitekey", "secret"]),
    tokens: store.collection<TurnstileToken>("cloudflare.tokens", ["token"]),
  };
}
export function seedFromConfig(store: Store, _baseUrl: string, config: CloudflareSeedConfig): void {
  const { sites } = getCloudflareStore(store);
  for (const site of config.sites ?? []) {
    if (
      !site.sitekey ||
      !site.secret ||
      !Array.isArray(site.hostnames) ||
      !site.hostnames.length ||
      site.hostnames.some((host) => typeof host !== "string" || !/^[a-z0-9.-]+$/.test(host))
    ) {
      throw new Error("Turnstile sites require a sitekey, secret and explicit hostnames");
    }
    const existing = sites.findOneBy("sitekey", site.sitekey);
    const sharedSecret = sites.findOneBy("secret", site.secret);
    if (sharedSecret && sharedSecret.id !== existing?.id) throw new Error("Turnstile site secrets must be unique");
    if (existing) sites.update(existing.id, site);
    else sites.insert(site);
  }
}
const failure = (code: string) => ({ success: false, "error-codes": [code] });
export const cloudflarePlugin: ServicePlugin = {
  name: "cloudflare",
  register(app, store) {
    browserRoutes(app);
    app.post("/turnstile/v0/issue", async (c) => {
      const input = await c.req.json().catch(() => null);
      if (!input || typeof input !== "object") return c.json(failure("bad-request"), 400);
      const { sites, tokens } = getCloudflareStore(store);
      const site = sites.findOneBy("sitekey", String(input.sitekey ?? ""));
      let hostname: string;
      try {
        const origin = new URL(input.origin);
        if (!["http:", "https:"].includes(origin.protocol) || origin.origin !== input.origin) throw new Error();
        hostname = origin.hostname;
      } catch {
        return c.json(failure("bad-request"), 400);
      }
      if (!site || !site.hostnames.includes(hostname)) return c.json(failure("invalid-input-response"), 400);
      if (
        (input.action && (typeof input.action !== "string" || !/^[\w-]{1,32}$/.test(input.action))) ||
        (input.cData && (typeof input.cData !== "string" || !/^[\w-]{1,255}$/.test(input.cData)))
      ) {
        return c.json(failure("bad-request"), 400);
      }
      // Bound transient state while keeping recently expired tokens available for diagnostics.
      for (const previous of tokens.all()) if (previous.expires_at < Date.now() - 300_000) tokens.delete(previous.id);
      const token = `emulate-turnstile-${randomUUID()}`;
      tokens.insert({
        token,
        sitekey: site.sitekey,
        hostname,
        action: input.action ?? "",
        cdata: input.cData ?? "",
        expires_at: Date.now() + 300_000,
        consumed: false,
      });
      return c.json({ token });
    });
    app.post("/turnstile/v0/siteverify", async (c) => {
      let input: Record<string, unknown>;
      try {
        input = c.req.header("Content-Type")?.includes("application/json")
          ? await c.req.json()
          : await c.req.parseBody();
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error();
      } catch {
        return c.json(failure("bad-request"));
      }
      if (!input.secret) return c.json(failure("missing-input-secret"));
      const { sites, tokens } = getCloudflareStore(store);
      const site = sites.findOneBy("secret", String(input.secret));
      if (!site) return c.json(failure("invalid-input-secret"));
      if (!input.response) return c.json(failure("missing-input-response"));
      if (typeof input.response !== "string" || input.response.length > 2048)
        return c.json(failure("invalid-input-response"));
      const token = tokens.findOneBy("token", input.response);
      if (!token || token.sitekey !== site.sitekey) return c.json(failure("invalid-input-response"));
      if (token.consumed || token.expires_at <= Date.now()) return c.json(failure("timeout-or-duplicate"));
      tokens.update(token.id, { consumed: true });
      return c.json({
        success: true,
        challenge_ts: token.created_at,
        hostname: token.hostname,
        "error-codes": [],
        action: token.action,
        cdata: token.cdata,
      });
    });
  },
};
