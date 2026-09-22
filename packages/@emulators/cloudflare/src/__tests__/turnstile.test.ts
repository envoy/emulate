import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "@emulators/core";
import { cloudflarePlugin, getCloudflareStore, seedFromConfig } from "../index.js";

function setup() {
  const { app, store } = createServer(cloudflarePlugin);
  seedFromConfig(store, "http://localhost", {
    sites: [
      { sitekey: "site-a", secret: "secret-a", hostnames: ["app.example.com"] },
      { sitekey: "site-b", secret: "secret-b", hostnames: ["app.example.com"] },
    ],
  });
  const issue = async (values = {}) => {
    const response = await app.request("/turnstile/v0/issue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sitekey: "site-a", origin: "https://app.example.com", ...values }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  const verify = async (values: Record<string, string>, json = false) => {
    const response = await app.request("/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": json ? "application/json" : "application/x-www-form-urlencoded" },
      body: json ? JSON.stringify(values) : new URLSearchParams(values),
    });
    expect(response.status).toBe(200);
    return response.json();
  };
  return { app, store, issue, verify };
}
afterEach(() => vi.useRealTimers());
describe("Turnstile", () => {
  it("issues a token and verifies it once through the form-encoded API", async () => {
    const { issue, verify } = setup();
    const { body } = await issue({ action: "signup", cData: "request-123" });
    expect(await verify({ secret: "secret-a", response: body.token })).toMatchObject({
      success: true,
      hostname: "app.example.com",
      action: "signup",
      cdata: "request-123",
      "error-codes": [],
    });
    expect(await verify({ secret: "secret-a", response: body.token })).toEqual({
      success: false,
      "error-codes": ["timeout-or-duplicate"],
    });
  });
  it("requires a configured site and hostname", async () => {
    const { issue } = setup();
    expect((await issue({ sitekey: "missing" })).status).toBe(400);
    expect((await issue({ origin: "https://unexpected.example.com" })).status).toBe(400);
    expect((await issue({ origin: "https://app.example.com/path" })).status).toBe(400);
  });
  it("rejects missing, invalid and mismatched credentials without consuming the token", async () => {
    const { issue, verify } = setup();
    const { body } = await issue();
    for (const [values, code] of [
      [{ response: body.token }, "missing-input-secret"],
      [{ secret: "unknown", response: body.token }, "invalid-input-secret"],
      [{ secret: "secret-a" }, "missing-input-response"],
      [{ secret: "secret-a", response: "unknown" }, "invalid-input-response"],
      [{ secret: "secret-b", response: body.token }, "invalid-input-response"],
    ] as Array<[Record<string, string>, string]>) {
      expect(await verify(values)).toEqual({ success: false, "error-codes": [code] });
    }
    expect(await verify({ secret: "secret-a", response: body.token }, true)).toMatchObject({ success: true });
  });
  it("expires after five minutes and retains consumption through snapshots", async () => {
    vi.useFakeTimers();
    const { issue, verify, store } = setup();
    const first = (await issue()).body.token;
    expect(await verify({ secret: "secret-a", response: first })).toMatchObject({ success: true });
    const snapshot = structuredClone(store.snapshot());
    store.reset();
    store.restore(snapshot);
    expect(await verify({ secret: "secret-a", response: first })).toMatchObject({ success: false });
    const second = (await issue()).body.token;
    vi.advanceTimersByTime(300_000);
    expect(await verify({ secret: "secret-a", response: second })).toEqual({
      success: false,
      "error-codes": ["timeout-or-duplicate"],
    });
  });
  it("resets through the shared Store and seeds idempotently", async () => {
    const { issue, store } = setup();
    await issue();
    seedFromConfig(store, "http://localhost", {
      sites: [{ sitekey: "site-a", secret: "secret-a", hostnames: ["app.example.com"] }],
    });
    expect(getCloudflareStore(store).sites.all()).toHaveLength(2);
    store.reset();
    expect(getCloudflareStore(store).tokens.all()).toHaveLength(0);
    expect((await issue()).status).toBe(400);
  });
  it("serves the explicit browser API and safely encodes widget configuration", async () => {
    const { app } = setup();
    const script = await app.request("/turnstile/v0/api.js?render=explicit");
    expect(script.headers.get("Content-Type")).toContain("javascript");
    expect(await script.text()).toContain("window.turnstile");
    const widget = await app.request(
      "/turnstile/v0/widget?config=" +
        encodeURIComponent(JSON.stringify({ origin: "https://app.example.com", sitekey: "</script>" })),
    );
    expect(widget.status).toBe(200);
    expect(await widget.text()).toContain("\\u003c/script>");
    expect((await app.request("/turnstile/v0/widget?config={}")).status).toBe(400);
  });
});
