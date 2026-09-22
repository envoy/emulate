import { describe, expect, it } from "vitest";
import { Hono, Store, WebhookDispatcher, type AppEnv, type TokenMap } from "@emulators/core";
import { stripePlugin } from "@emulators/stripe";
import { chargebeePlugin, seedFromConfig } from "../index.js";

type JsonResponse = Omit<Response, "json"> & { json(): Promise<any> };
function setup() {
  const app = new Hono<AppEnv>(),
    store = new Store(),
    webhooks = new WebhookDispatcher();
  const tokens: TokenMap = new Map(
    ["cb_test_key", "pk_test_example", "sk_test_example"].map((key) => [key, { login: "tester", id: 1, scopes: [] }]),
  );
  stripePlugin.register(app, store, webhooks, "http://localhost", tokens);
  chargebeePlugin.register(app, store, webhooks, "http://localhost", tokens);
  const config = {
    plans: [
      {
        id: "pro-monthly",
        name: "Pro",
        price: 2000,
        trial_period: 14,
        cf_product: "pro",
        meta_data: { feature: true },
      },
    ],
  };
  seedFromConfig(store, "http://localhost", config);
  const request = (path: string, params?: Record<string, string>, key = "cb_test_key") =>
    app.request(`http://localhost/api/v2/${path}`, {
      method: params ? "POST" : "GET",
      headers: {
        Authorization: `Basic ${Buffer.from(key + ":").toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      ...(params ? { body: new URLSearchParams(params).toString() } : {}),
    }) as Promise<JsonResponse>;
  const token = (number = "4242424242424242") =>
    app.request("http://localhost/v1/tokens", {
      method: "POST",
      headers: { Authorization: "Bearer pk_test_example", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        "card[number]": number,
        "card[exp_month]": "12",
        "card[exp_year]": "2099",
        "card[cvc]": "123",
        "card[name]": "Test User",
        "card[address_zip]": "94103",
      }).toString(),
    }) as Promise<JsonResponse>;
  return { app, store, request, token, config };
}

describe("Chargebee Product Catalog 1", () => {
  it("authenticates Basic API keys and rejects unknown credentials", async () => {
    const { request, app } = setup();
    expect((await request("plans")).status).toBe(200);
    const denied = await request("plans", undefined, "wrong");
    expect(denied.status).toBe(401);
    expect(await denied.json()).toMatchObject({ api_error_code: "api_authentication_failed", http_status_code: 401 });
    expect((await app.request("http://localhost/api/v2/plans")).status).toBe(401);
  });
  it("persists customers, custom fields, subscriptions and scheduled trial cancellation", async () => {
    const { request } = setup();
    expect(
      (
        await request("customers", {
          id: "customer-a",
          company: "Example",
          cf_customer_key: "example",
          meta_data: '{"region":"west"}',
        })
      ).status,
    ).toBe(200);
    expect((await request("customers", { id: "customer-a" })).status).toBe(400);
    const result = await (
      await request("customers/customer-a/subscriptions", { id: "subscription-a", plan_id: "pro-monthly" })
    ).json();
    expect(result.subscription).toMatchObject({
      customer_id: "customer-a",
      status: "in_trial",
      plan_id: "pro-monthly",
      plan_unit_price: 2000,
    });
    expect(result.subscription.trial_end - result.subscription.trial_start).toBe(14 * 86400);
    const cancellation = await (await request("subscriptions/subscription-a/cancel", { end_of_term: "true" })).json();
    expect(cancellation.subscription).toMatchObject({
      status: "in_trial",
      cancelled_at: result.subscription.trial_end,
    });
    const listed = await (
      await request('subscriptions?customer_id[in]=["customer-a"]&status[in]=[in_trial,active]')
    ).json();
    expect(listed.list).toHaveLength(1);
    expect((await (await request("subscriptions?customer_id[is]=other")).json()).list).toEqual([]);
    expect((await (await request("customers/customer-a")).json()).customer).toMatchObject({
      cf_customer_key: "example",
      meta_data: { region: "west" },
    });
  });
  it("requires real related records and valid quantities", async () => {
    const { request } = setup();
    expect((await request("customers/missing/subscriptions", { plan_id: "pro-monthly" })).status).toBe(404);
    await request("customers", { id: "customer-a" });
    expect((await request("customers/customer-a/subscriptions", { plan_id: "missing" })).status).toBe(400);
    expect(
      (await request("customers/customer-a/subscriptions", { plan_id: "pro-monthly", plan_quantity: "-1" })).status,
    ).toBe(400);
    expect((await request("plans/pro-monthly", { pricing_model: "flat_fee" })).status).toBe(200);
    expect(
      (await request("customers/customer-a/subscriptions", { plan_id: "pro-monthly", plan_quantity: "1" })).status,
    ).toBe(400);
    expect((await request("subscriptions/missing")).status).toBe(404);
    expect((await request("customers", { id: "bad", meta_data: "not-json" })).status).toBe(400);
  });
  it("paginates plans and idempotently installs seeds", async () => {
    const { request, store, config } = setup();
    seedFromConfig(store, "http://localhost", config);
    await request("plans", { id: "basic-monthly", name: "Basic" });
    const first = await (await request("plans?limit=1&status[is]=active")).json();
    expect(first.list).toHaveLength(1);
    const next = await (await request(`plans?limit=1&offset=${first.next_offset}`)).json();
    expect(next.list).toHaveLength(1);
    expect(next.next_offset).toBeUndefined();
    expect((await request("plans?unsupported=true")).status).toBe(400);
  });
  it("exchanges one-use Stripe tokens and isolates customer payment roles", async () => {
    const { request, token, app } = setup();
    await request("customers", { id: "customer-a" });
    await request("customers", { id: "customer-b" });
    const card = await (await token()).json();
    const input = { customer_id: "customer-a", type: "card", tmp_token: card.id };
    const saved = await (await request("payment_sources/create_using_temp_token", input)).json();
    expect(saved.payment_source).toMatchObject({
      customer_id: "customer-a",
      card: { last4: "4242", first_name: "Test", last_name: "User", expiry_year: 2099 },
    });
    expect(saved.customer.primary_payment_source_id).toBe(saved.payment_source.id);
    expect((await request("payment_sources/create_using_temp_token", input)).status).toBe(400);
    const consumed: any = await (
      await app.request(`http://localhost/v1/tokens/${card.id}`, {
        headers: { Authorization: "Bearer sk_test_example" },
      })
    ).json();
    expect(consumed.used).toBe(true);
    expect((await (await request("payment_sources?customer_id[is]=customer-a")).json()).list).toHaveLength(1);
    expect((await (await request("payment_sources?customer_id[is]=customer-b")).json()).list).toEqual([]);
    expect(
      (
        await request("customers/customer-b/assign_payment_role", {
          role: "primary",
          payment_source_id: saved.payment_source.id,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request("customers/customer-a/assign_payment_role", {
          role: "backup",
          payment_source_id: saved.payment_source.id,
        })
      ).status,
    ).toBe(200);
  });
  it("snapshots consumption and redacted card data, resets, and restores through the same routes", async () => {
    const { request, token, store } = setup();
    await request("customers", { id: "customer-a" });
    const card = await (await token()).json();
    const input = { customer_id: "customer-a", type: "card", tmp_token: card.id };
    await request("payment_sources/create_using_temp_token", input);
    const snapshot = store.snapshot();
    expect(JSON.stringify(snapshot)).not.toContain("4242424242424242");
    expect(JSON.stringify(snapshot)).not.toContain('"cvc"');
    store.reset();
    expect((await request("customers/customer-a")).status).toBe(404);
    store.restore(snapshot);
    expect((await request("payment_sources/create_using_temp_token", input)).status).toBe(400);
    expect((await (await request("payment_sources?customer_id[is]=customer-a")).json()).list).toHaveLength(1);
    await request("customers/customer-a/delete", {});
    expect((await (await request("payment_sources?customer_id[is]=customer-a")).json()).list).toEqual([]);
  });
  it("refuses unsupported cards and returns decline errors without a source", async () => {
    const { token, request, app } = setup();
    expect((await token("4111111111111111")).status).toBe(402);
    expect(await (await token("4000000000000002")).json()).toMatchObject({ error: { code: "card_declined" } });
    expect(
      (
        await app.request("http://localhost/v1/tokens", {
          method: "POST",
          headers: { Authorization: "Bearer pk_live_example" },
          body: "card[number]=4242424242424242",
        })
      ).status,
    ).toBe(401);
    expect((await (await request("payment_sources")).json()).list).toEqual([]);
  });
});
