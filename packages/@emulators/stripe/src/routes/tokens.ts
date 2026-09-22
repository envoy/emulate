import type { Entity, Store, RouteContext } from "@emulators/core";
import { parseStripeBody, stripeError, stripeId } from "../helpers.js";

export interface TestCard {
  id: string;
  object: "card";
  brand: string;
  last4: string;
  exp_month: number;
  exp_year: number;
  name: string | null;
  address_zip: string | null;
  country: string;
  funding: string;
}
export interface StripeCardToken extends Entity {
  stripe_id: string;
  card: TestCard;
  used: boolean;
}
export function cardTokens(store: Store) {
  return store.collection<StripeCardToken>("stripe.card_tokens", ["stripe_id"]);
}
export function consumeCardToken(store: Store, id: string): TestCard | undefined {
  const tokens = cardTokens(store);
  const token = tokens.findOneBy("stripe_id", id);
  if (!token || token.used) return undefined;
  tokens.update(token.id, { used: true });
  return structuredClone(token.card);
}
function format(token: StripeCardToken) {
  return {
    id: token.stripe_id,
    object: "token",
    type: "card",
    livemode: false,
    created: Math.floor(new Date(token.created_at).getTime() / 1000),
    used: token.used,
    card: token.card,
  };
}
export function tokenRoutes({ app, store, tokenMap }: RouteContext): void {
  const tokens = cardTokens(store);
  app.post("/v1/tokens", async (c) => {
    const body = await parseStripeBody(c);
    const key = c.req.header("Authorization")?.replace(/^Bearer /i, "") ?? body.key;
    if (typeof key !== "string" || !/^(pk|sk)_test_/.test(key) || !tokenMap?.has(key)) {
      return stripeError(c, 401, "invalid_request_error", "Use a configured test API key", "invalid_api_key");
    }
    const card = body.card as Record<string, unknown> | undefined;
    if (!card || typeof card !== "object")
      return stripeError(c, 400, "invalid_request_error", "card is required", "parameter_missing", "card");
    const number = String(card.number ?? "").replace(/\s/g, "");
    // Accept only documented test fixtures. Card numbers and CVC never enter Store.
    const brand = { "4242424242424242": "Visa", "5555555555554444": "MasterCard", "4000000000000002": "Visa" }[number];
    if (!brand)
      return stripeError(c, 402, "card_error", "Use a supported test card number", "invalid_number", "number");
    const month = Number(card.exp_month),
      year = Number(card.exp_year);
    const now = new Date();
    if (!Number.isInteger(month) || month < 1 || month > 12)
      return stripeError(c, 402, "card_error", "Invalid expiry month", "invalid_expiry_month", "exp_month");
    if (
      !Number.isInteger(year) ||
      year < now.getUTCFullYear() ||
      (year === now.getUTCFullYear() && month < now.getUTCMonth() + 1)
    )
      return stripeError(c, 402, "card_error", "Card has expired", "expired_card", "exp_year");
    if (!/^\d{3}$/.test(String(card.cvc ?? "")))
      return stripeError(c, 402, "card_error", "Invalid CVC", "invalid_cvc", "cvc");
    if (number === "4000000000000002")
      return stripeError(c, 402, "card_error", "Your card was declined", "card_declined");
    const token = tokens.insert({
      stripe_id: stripeId("tok"),
      used: false,
      card: {
        id: stripeId("card"),
        object: "card",
        brand,
        last4: number.slice(-4),
        exp_month: month,
        exp_year: year,
        name: typeof card.name === "string" ? card.name.slice(0, 200) : null,
        address_zip: typeof card.address_zip === "string" ? card.address_zip.slice(0, 20) : null,
        country: "US",
        funding: "credit",
      },
    });
    return c.json(format(token));
  });
  app.get("/v1/tokens/:id", (c) => {
    const key = c.req.header("Authorization")?.replace(/^Bearer /i, "");
    if (!key?.startsWith("sk_test_") || !tokenMap?.has(key))
      return stripeError(c, 401, "invalid_request_error", "Use a configured secret test API key", "invalid_api_key");
    const token = tokens.findOneBy("stripe_id", c.req.param("id"));
    return token
      ? c.json(format(token))
      : stripeError(c, 404, "invalid_request_error", "No such token", "resource_missing");
  });
}
