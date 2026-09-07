import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serve } from "@emulators/core";
import type { AddressInfo } from "node:net";
import {
  SNSClient,
  CreatePlatformApplicationCommand,
  GetPlatformApplicationAttributesCommand,
  SetPlatformApplicationAttributesCommand,
  DeletePlatformApplicationCommand,
  ListPlatformApplicationsCommand,
  CreatePlatformEndpointCommand,
  GetEndpointAttributesCommand,
  SetEndpointAttributesCommand,
  DeleteEndpointCommand,
  ListEndpointsByPlatformApplicationCommand,
  PublishCommand,
} from "@aws-sdk/client-sns";
import { createTestApp } from "./helpers.js";
import type { SnsMessage } from "../entities.js";
import { getAwsStore } from "../store.js";

describe("SNS mobile push with the real AWS SDK", () => {
  let fixture: ReturnType<typeof createTestApp>;
  let client: SNSClient;
  let base: string;
  let close: () => Promise<void>;

  beforeEach(async () => {
    fixture = createTestApp();
    const server = serve({ fetch: fixture.app.fetch, port: 0, hostname: "127.0.0.1" });
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    client = new SNSClient({
      endpoint: base,
      region: "us-west-2",
      maxAttempts: 1,
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
    });
    close = () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });
  afterEach(async () => {
    client.destroy();
    await close();
  });

  async function application(platform = "GCM", name = "sample") {
    const result = await client.send(
      new CreatePlatformApplicationCommand({
        Name: name,
        Platform: platform,
        Attributes: { PlatformCredential: "dummy", PlatformPrincipal: "dummy" },
      }),
    );
    expect(result.$metadata.requestId).toBeTruthy();
    return result.PlatformApplicationArn!;
  }
  async function endpoint(arn: string, token = "device-token") {
    return (await client.send(new CreatePlatformEndpointCommand({ PlatformApplicationArn: arn, Token: token })))
      .EndpointArn!;
  }
  async function captured() {
    return ((await (await fetch(`${base}/_emulate/sns/messages`)).json()) as { messages: SnsMessage[] }).messages;
  }

  it.each(["APNS", "APNS_SANDBOX", "GCM"])(
    "captures the selected %s payload and original envelope",
    async (platform) => {
      const arn = await application(platform);
      expect(arn).toBe(`arn:aws:sns:us-west-2:123456789012:app/${platform}/sample`);
      const target = await endpoint(arn);
      const envelope = {
        default: "hello",
        APNS: JSON.stringify({ aps: { alert: { title: "Title", body: "Hello <&>" }, "content-available": 1 } }),
        APNS_SANDBOX: JSON.stringify({ aps: { alert: "sandbox" } }),
        GCM: JSON.stringify({ data: { message: "hello", key: "value" } }),
      };
      const message = JSON.stringify(envelope);
      const result = await client.send(
        new PublishCommand({ TargetArn: target, MessageStructure: "json", Message: message }),
      );
      expect(result.MessageId).toMatch(/^[a-f0-9-]{36}$/);
      const read = (await (await fetch(`${base}/_emulate/sns/messages/${result.MessageId}`)).json()) as SnsMessage;
      expect(read).toMatchObject({
        message_id: result.MessageId,
        message,
        target_arn: target,
        platform,
        payload: envelope[platform as keyof typeof envelope],
        token: "device-token",
        status: "captured",
      });
      expect(await captured()).toEqual([read]);
      expect(
        (
          (await (await fetch(`${base}/_emulate/sns/messages?target_arn=${encodeURIComponent(target)}`)).json()) as {
            messages: SnsMessage[];
          }
        ).messages,
      ).toEqual([read]);
      expect(
        ((await (await fetch(`${base}/_emulate/sns/messages?target_arn=absent`)).json()) as { messages: SnsMessage[] })
          .messages,
      ).toEqual([]);
      expect((await fetch(`${base}/_emulate/sns/messages/absent`)).status).toBe(404);
    },
  );

  it("supports application and endpoint attributes, idempotence, conflicts, and deletion", async () => {
    const arn = await application();
    expect(await application()).toBe(arn);
    await client.send(
      new SetPlatformApplicationAttributesCommand({
        PlatformApplicationArn: arn,
        Attributes: { EventEndpointCreated: "local-value" },
      }),
    );
    expect(
      (await client.send(new GetPlatformApplicationAttributesCommand({ PlatformApplicationArn: arn }))).Attributes,
    ).toMatchObject({ EventEndpointCreated: "local-value" });
    expect((await client.send(new ListPlatformApplicationsCommand({}))).PlatformApplications).toHaveLength(1);
    const target = await endpoint(arn);
    expect(await endpoint(arn)).toBe(target);
    await expect(
      client.send(
        new CreatePlatformEndpointCommand({
          PlatformApplicationArn: arn,
          Token: "device-token",
          CustomUserData: "different",
        }),
      ),
    ).rejects.toMatchObject({ name: "InvalidParameterException" });
    await client.send(
      new SetEndpointAttributesCommand({
        EndpointArn: target,
        Attributes: { Token: "rotated", CustomUserData: "<user & data>", Enabled: "false" },
      }),
    );
    expect((await client.send(new GetEndpointAttributesCommand({ EndpointArn: target }))).Attributes).toEqual({
      Token: "rotated",
      CustomUserData: "<user & data>",
      Enabled: "false",
    });
    expect(
      (await client.send(new ListEndpointsByPlatformApplicationCommand({ PlatformApplicationArn: arn }))).Endpoints?.[0]
        .Attributes?.CustomUserData,
    ).toBe("<user & data>");
    await expect(client.send(new PublishCommand({ TargetArn: target, Message: "hello" }))).rejects.toMatchObject({
      name: "EndpointDisabledException",
      $metadata: { httpStatusCode: 400 },
    });
    expect(await captured()).toEqual([]);
    await client.send(new SetEndpointAttributesCommand({ EndpointArn: target, Attributes: { Enabled: "true" } }));
    await client.send(new PublishCommand({ TargetArn: target, Message: "plain text" }));
    expect((await captured())[0]).toMatchObject({ token: "rotated", payload: "plain text" });
    await client.send(new DeleteEndpointCommand({ EndpointArn: target }));
    await client.send(new DeleteEndpointCommand({ EndpointArn: target }));
    await expect(client.send(new GetEndpointAttributesCommand({ EndpointArn: target }))).rejects.toMatchObject({
      name: "NotFoundException",
    });
    await expect(client.send(new PublishCommand({ TargetArn: target, Message: "hello" }))).rejects.toMatchObject({
      name: "NotFoundException",
    });
    await endpoint(arn, "another");
    await client.send(new DeletePlatformApplicationCommand({ PlatformApplicationArn: arn }));
    await client.send(new DeletePlatformApplicationCommand({ PlatformApplicationArn: arn }));
    expect(getAwsStore(fixture.store).snsEndpoints.all()).toEqual([]);
    expect(await captured()).toHaveLength(1); // Captured history survives resource deletion.
  });

  it("rejects malformed publish requests atomically and supports default fallback", async () => {
    const target = await endpoint(await application());
    for (const Message of [
      "",
      "{",
      "[]",
      '{"GCM":"{}"}',
      '{"default":1}',
      '{"default":"ok","GCM":{}}',
      '{"default":"ok","APNS":"broken"}',
      "x".repeat(262145),
    ]) {
      await expect(
        client.send(new PublishCommand({ TargetArn: target, MessageStructure: "json", Message })),
      ).rejects.toMatchObject({ name: "InvalidParameterException" });
    }
    await expect(client.send(new PublishCommand({ TargetArn: "bad", Message: "hi" }))).rejects.toMatchObject({
      name: "InvalidParameterException",
    });
    await expect(
      client.send(new PublishCommand({ TargetArn: target, Message: "hi", MessageStructure: "xml" })),
    ).rejects.toMatchObject({ name: "InvalidParameterException" });
    await expect(
      client.send(new PublishCommand({ TargetArn: target, TopicArn: "topic", Message: "hi" })),
    ).rejects.toMatchObject({ name: "InvalidParameterException" });
    expect(await captured()).toEqual([]);
    await client.send(
      new PublishCommand({ TargetArn: target, MessageStructure: "json", Message: '{"default":"fallback"}' }),
    );
    expect((await captured())[0].payload).toBe("fallback");
  });

  it("rejects invalid registration and attribute updates without modifying state", async () => {
    await expect(application("ADM")).rejects.toMatchObject({ name: "InvalidParameterException" });
    await expect(application("GCM", "invalid name")).rejects.toMatchObject({ name: "InvalidParameterException" });
    const arn = await application();
    await expect(endpoint(arn, "")).rejects.toMatchObject({ name: "InvalidParameterException" });
    const target = await endpoint(arn);
    await endpoint(arn, "other");
    for (const Attributes of [
      { Enabled: "yes" },
      { Token: "" },
      { CustomUserData: "é".repeat(1024) },
      { Unknown: "value" },
      { Token: "other" },
    ] as Record<string, string>[]) {
      await expect(
        client.send(new SetEndpointAttributesCommand({ EndpointArn: target, Attributes })),
      ).rejects.toMatchObject({ name: "InvalidParameterException" });
    }
    expect((await client.send(new GetEndpointAttributesCommand({ EndpointArn: target }))).Attributes).toEqual({
      Enabled: "true",
      Token: "device-token",
    });
    await expect(
      client.send(new GetEndpointAttributesCommand({ EndpointArn: target.replace("us-west-2", "us-east-1") })),
    ).rejects.toMatchObject({ name: "InvalidParameterException" });
  });

  it("paginates endpoints with scoped cursors and preserves application isolation", async () => {
    const arn = await application();
    const other = await application("GCM", "other");
    await endpoint(other, "shared");
    for (let i = 0; i < 101; i++) await endpoint(arn, `token-${i}`);
    const first = await client.send(new ListEndpointsByPlatformApplicationCommand({ PlatformApplicationArn: arn }));
    expect(first.Endpoints).toHaveLength(100);
    expect(first.NextToken).toBeTruthy();
    const second = await client.send(
      new ListEndpointsByPlatformApplicationCommand({ PlatformApplicationArn: arn, NextToken: first.NextToken }),
    );
    expect(second.Endpoints).toHaveLength(1);
    expect(second.NextToken).toBeUndefined();
    expect(second.Endpoints?.[0].Attributes?.Token).toBe("token-100");
    await expect(
      client.send(
        new ListEndpointsByPlatformApplicationCommand({ PlatformApplicationArn: other, NextToken: first.NextToken }),
      ),
    ).rejects.toMatchObject({ name: "InvalidParameterException" });
    await expect(client.send(new ListPlatformApplicationsCommand({ NextToken: "invalid" }))).rejects.toMatchObject({
      name: "InvalidParameterException",
    });
  });

  it("snapshots and resets captures and renders untrusted payloads safely", async () => {
    const arn = await application();
    const target = await endpoint(arn);
    await client.send(new PublishCommand({ TargetArn: target, Message: "<script>alert(1)</script>" }));
    const before = await captured();
    const html = await (await fetch(`${base}/_inspector?tab=sns`)).text();
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    const snapshot = fixture.store.snapshot();
    fixture.store.reset();
    expect(await captured()).toEqual([]);
    expect((await client.send(new ListPlatformApplicationsCommand({}))).PlatformApplications).toEqual([]);
    fixture.store.restore(snapshot);
    expect(await captured()).toEqual(before);
    expect((await client.send(new GetEndpointAttributesCommand({ EndpointArn: target }))).Attributes?.Token).toBe(
      "device-token",
    );
    await client.send(new PublishCommand({ TargetArn: target, Message: "after restore" }));
    expect((await captured()).map((m) => m.payload)).toEqual(["<script>alert(1)</script>", "after restore"]);
  });

  it("enforces byte limits and rejects unsupported publish options", async () => {
    const target = await endpoint(await application());
    await client.send(new PublishCommand({ TargetArn: target, Message: "é".repeat(131072) }));
    await expect(
      client.send(new PublishCommand({ TargetArn: target, Message: "é".repeat(131073) })),
    ).rejects.toMatchObject({ name: "InvalidParameterException" });
    await expect(
      client.send(new PublishCommand({ TargetArn: target, Message: "hello", Subject: "subject" })),
    ).rejects.toMatchObject({ name: "InvalidParameterException" });
    await expect(
      client.send(
        new PublishCommand({
          TargetArn: target,
          Message: "hello",
          MessageAttributes: { key: { DataType: "String", StringValue: "value" } },
        }),
      ),
    ).rejects.toMatchObject({ name: "InvalidParameterException" });
    expect(await captured()).toHaveLength(1);
  });

  it("paginates applications and excludes other signing regions", async () => {
    for (let i = 0; i < 101; i++) await application("GCM", `app-${i}`);
    const first = await client.send(new ListPlatformApplicationsCommand({}));
    expect(first.PlatformApplications).toHaveLength(100);
    const second = await client.send(new ListPlatformApplicationsCommand({ NextToken: first.NextToken }));
    expect(second.PlatformApplications).toHaveLength(1);
    expect(second.NextToken).toBeUndefined();
    const response = await fetch(`${base}/sns?Action=ListPlatformApplications`);
    expect(await response.text()).not.toContain("app/GCM/app-");
  });

  it("accepts query-style requests at /sns/ and leaves S3 root GET intact", async () => {
    const response = await fetch(`${base}/sns/`, {
      method: "POST",
      body: new URLSearchParams({
        Action: "CreatePlatformApplication",
        Name: "wire",
        Platform: "GCM",
        "Attributes.entry.1.key": "PlatformCredential",
        "Attributes.entry.1.value": "dummy",
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("arn:aws:sns:us-east-1:123456789012:app/GCM/wire");
    expect(await (await fetch(`${base}/sns?Action=ListPlatformApplications`)).text()).toContain("app/GCM/wire");
    expect(await (await fetch(`${base}/?Action=ListPlatformApplications`)).text()).toContain("app/GCM/wire");
    expect(await (await fetch(`${base}/`)).text()).toContain("ListAllMyBucketsResult");
    expect(
      (await fetch(`${base}/sns/`, { method: "POST", body: new URLSearchParams({ Action: "CreateTopic" }) })).status,
    ).toBe(400);
  });
});
