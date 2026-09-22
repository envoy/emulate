import { describe, expect, it } from "vitest";
import { Hono, Store, WebhookDispatcher, type AppEnv, type TokenMap } from "@emulators/core";
import { consumeCardToken, stripePlugin } from "../index.js";

function setup() {
  const app = new Hono<AppEnv>();
  const store = new Store();
  const tokens: TokenMap = new Map(
    ["pk_test_example", "sk_test_example", "pk_live_example"].map((key) => [
      key,
      { login: "tester", id: 1, scopes: [] },
    ]),
  );
  stripePlugin.register(app, store, new WebhookDispatcher(), "http://localhost", tokens);
  const createToken = (card: Record<string, string> = {}, key = "pk_test_example") =>
    app.request("http://localhost/v1/tokens", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(
        Object.entries({ number: "4242424242424242", exp_month: "12", exp_year: "2099", cvc: "123", ...card }).map(
          ([name, value]): [string, string] => [`card[${name}]`, value],
        ),
      ).toString(),
    });
  const retrieveToken = (id: string, key = "sk_test_example") =>
    app.request(`http://localhost/v1/tokens/${id}`, { headers: { Authorization: `Bearer ${key}` } });
  return { app, store, createToken, retrieveToken };
}

describe("Stripe test card tokens", () => {
  it("creates and retrieves redacted tokens that embedded consumers can use only once", async () => {
    const { store, createToken, retrieveToken } = setup();
    const response = await createToken({ name: "Test User", address_zip: "94103" });
    expect(response.status).toBe(200);
    const token = (await response.json()) as { id: string };
    expect(token).toMatchObject({
      object: "token",
      livemode: false,
      used: false,
      card: { brand: "Visa", last4: "4242", exp_year: 2099, name: "Test User", address_zip: "94103" },
    });
    expect(await (await retrieveToken(token.id)).json()).toEqual(token);
    expect(consumeCardToken(store, token.id)).toMatchObject({ last4: "4242" });
    expect(consumeCardToken(store, token.id)).toBeUndefined();
    expect(consumeCardToken(store, "tok_missing")).toBeUndefined();
    expect(await (await retrieveToken(token.id)).json()).toMatchObject({ used: true });
  });

  it("requires configured test keys and a secret key for retrieval", async () => {
    const { createToken, retrieveToken } = setup();
    expect((await createToken({}, "pk_test_unknown")).status).toBe(401);
    expect((await createToken({}, "pk_live_example")).status).toBe(401);
    expect((await createToken({}, "")).status).toBe(401);
    const token = (await (await createToken({}, "sk_test_example")).json()) as { id: string };
    expect((await retrieveToken(token.id, "pk_test_example")).status).toBe(401);
    expect((await retrieveToken(token.id, "sk_test_unknown")).status).toBe(401);
    expect((await retrieveToken("tok_missing")).status).toBe(404);
  });

  it("rejects unsupported, declined, expired and invalid cards without storing them", async () => {
    const { store, createToken } = setup();
    const before = store.snapshot();
    for (const [card, code] of [
      [{ number: "4111111111111111" }, "invalid_number"],
      [{ number: "4000000000000002" }, "card_declined"],
      [{ exp_month: "13" }, "invalid_expiry_month"],
      [{ exp_year: "2000" }, "expired_card"],
      [{ cvc: "12" }, "invalid_cvc"],
    ] as const) {
      const response = await createToken(card);
      expect(response.status).toBe(402);
      expect(await response.json()).toMatchObject({ error: { code } });
    }
    expect(store.snapshot()).toEqual(before);
  });

  it("preserves consumption through snapshot and restore without retaining PAN or CVC", async () => {
    const { store, createToken, retrieveToken } = setup();
    const token = (await (await createToken()).json()) as { id: string };
    consumeCardToken(store, token.id);
    const snapshot = store.snapshot();
    expect(JSON.stringify(snapshot)).not.toContain("4242424242424242");
    expect(JSON.stringify(snapshot)).not.toContain('"cvc"');
    store.reset();
    expect((await retrieveToken(token.id)).status).toBe(404);
    store.restore(snapshot);
    expect(await (await retrieveToken(token.id)).json()).toMatchObject({ used: true, card: { last4: "4242" } });
    expect(consumeCardToken(store, token.id)).toBeUndefined();
  });

  it("serves the card-entry shim and requires an exact HTTP parent origin for the iframe", async () => {
    const { app } = setup();
    const script = await app.request("http://localhost/stripe.js");
    expect(script.status).toBe(200);
    expect(script.headers.get("Content-Type")).toContain("application/javascript");
    for (const parent of ["", "null", "file:///tmp", "https://example.com/path"]) {
      expect((await app.request(`http://localhost/elements/card?parent=${encodeURIComponent(parent)}`)).status).toBe(
        400,
      );
    }
    const frame = await app.request("http://localhost/elements/card?parent=https%3A%2F%2Fexample.com");
    expect(frame.status).toBe(200);
    expect(await frame.text()).toContain('placeholder="Card number"');
  });
});
