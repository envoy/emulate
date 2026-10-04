import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { StreamChat } from "stream-chat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startStream, TEST_API_KEY, TEST_API_SECRET, type RunningStream } from "./helpers.js";

/**
 * stream-chat-java 1.32.0, as communication-service drives it, against the emulator.
 *
 * Opt-in, because it needs a JVM and the SDK's jars: set STREAM_JAVA_CLASSPATH to the
 * classpath of io.getstream:stream-chat-java:1.32.0 and its runtime dependencies.
 */
const classpath = process.env.STREAM_JAVA_CLASSPATH;
const probe = fileURLToPath(new URL("./jvm/StreamJavaProbe.java", import.meta.url));

describe.skipIf(!classpath)("stream-chat-java 1.32.0 against the emulator", () => {
  let stream: RunningStream;

  beforeEach(async () => {
    stream = await startStream();
  });

  afterEach(async () => {
    await stream.close();
  });

  it("runs communication-service's calls and mints a token the browser client accepts", async () => {
    const channelId = randomUUID();
    const { stdout } = await promisify(execFile)(
      "java",
      ["-cp", classpath!, probe, TEST_API_KEY, TEST_API_SECRET, channelId],
      // DefaultClient reads the base URL from this variable when no property sets it.
      { env: { ...process.env, STREAM_CHAT_URL: stream.baseUrl }, timeout: 60_000 },
    );
    const lines = stdout.trim().split("\n");

    expect(lines).toContain("upsert ok");
    expect(lines).toContain("list-before 0");
    expect(lines).toContain("create ok");
    expect(lines.some((line) => /^send \S+ SYSTEM$/.test(line))).toBe(true);
    expect(lines).toContain("add-members ok");
    expect(lines).toContain("recipient_user_id 202");
    expect(lines).toContain("members 101/owner,202/member,303/member");
    expect(lines).toContain("frozen true");

    const channels = await stream.server("POST", "/channels", { filter_conditions: { cid: `emno:${channelId}` } });
    const [state] = channels.body.channels;
    expect(state.channel.team).toBe("7");
    expect(state.channel.created_by.id).toBe("101");
    expect(state.messages[0]).toMatchObject({
      text: "Fire drill",
      type: "system",
      message_subtype: "announcement_content",
      user: { id: "system" },
    });

    // The token User.createToken made is the one /api/v1/chat/token returns to the browser.
    const token = lines.find((line) => line.startsWith("token "))!.slice("token ".length);
    const browser = new StreamChat(TEST_API_KEY, { baseURL: stream.baseUrl, allowServerSideConnect: true });
    const connected = await browser.connectUser({ id: "101" }, token);
    expect(connected?.me?.teams).toEqual(["7"]);
    await browser.disconnectUser();
  }, 90_000);
});
