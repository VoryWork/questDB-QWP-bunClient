// @ts-check
import { describe, it, expect, afterEach } from "bun:test";

import { Sender } from "../src";
import { MockQwpServer } from "./util/mockws";

const servers: MockQwpServer[] = [];

async function startServer(): Promise<MockQwpServer> {
  const server = new MockQwpServer();
  await server.start(0);
  servers.push(server);
  return server;
}

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()!.stop();
  }
});

describe("Sender QWP transport suite", function () {
  it("sends the QWP upgrade headers during the handshake", async function () {
    const server = await startServer();
    const sender = await Sender.fromConfig(`ws::addr=localhost:${server.server!.port};auto_flush=off`);
    await sender.connect();

    const headers = server.upgradeHeaders!;
    expect(headers.get("x-qwp-max-version")).toBe("1");
    expect(headers.get("x-qwp-client-id")).not.toBeNull();
    await sender.close();
  });

  it("sends Basic authorization header when username and password are set", async function () {
    const server = await startServer();
    const sender = await Sender.fromConfig(
      `ws::addr=localhost:${server.server!.port};username=admin;password=secret;auto_flush=off`,
    );
    await sender.connect();
    const auth = server.upgradeHeaders!.get("authorization");
    expect(auth).toBe(`Basic ${btoa("admin:secret")}`);
    await sender.close();
  });

  it("sends Bearer authorization header when token is set", async function () {
    const server = await startServer();
    const sender = await Sender.fromConfig(
      `ws::addr=localhost:${server.server!.port};token=my-token;auto_flush=off`,
    );
    await sender.connect();
    expect(server.upgradeHeaders!.get("authorization")).toBe("Bearer my-token");
    await sender.close();
  });

  it("flushes buffered rows as a single QWP message", async function () {
    const server = await startServer();
    const sender = await Sender.fromConfig(
      `ws::addr=localhost:${server.server!.port};auto_flush=off`,
    );

    sender
      .table("sensors")
      .symbol("host", "server1")
      .floatColumn("temp", 91.6)
      .at(1658484765000000000n, "ns");
    const flushed = await sender.flush();
    expect(flushed).toBe(true);

    expect(server.frames).toHaveLength(1);
    const frame = server.frames[0]!;
    // 12-byte header: magic "QWP1", version 1, flags, tableCount, payloadLength
    expect(Array.from(frame.subarray(0, 4))).toEqual([0x51, 0x57, 0x50, 0x31]);
    expect(frame[4]).toBe(1);
    expect(new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint16(6, true)).toBe(1);
    await sender.close();
  });

  it("does not flush when there are no buffered rows", async function () {
    const server = await startServer();
    const sender = await Sender.fromConfig(
      `ws::addr=localhost:${server.server!.port};auto_flush=off`,
    );
    expect(await sender.flush()).toBe(false);
    expect(server.frames).toHaveLength(0);
    await sender.close();
  });

  it("throws when the server rejects the batch with an error status", async function () {
    const server = await startServer();
    server.errorStatus = { status: 0x08, message: "access denied" };
    const sender = await Sender.fromConfig(
      `ws::addr=localhost:${server.server!.port};auto_flush=off`,
    );

    sender.table("sensors").symbol("host", "server1").atNow();
    await expect(sender.flush()).rejects.toThrow(
      "Server rejected the batch",
    );
    await sender.close();
  });

  it("fails to connect when the server is unreachable", async function () {
    const sender = await Sender.fromConfig("ws::addr=localhost:1;request_timeout=500");
    await expect(sender.connect()).rejects.toThrow("Failed to connect");
    await sender.close();
  });

  it("throws when connect() is called twice", async function () {
    const server = await startServer();
    const sender = await Sender.fromConfig(`ws::addr=localhost:${server.server!.port};auto_flush=off`);
    await sender.connect();
    await expect(sender.connect()).rejects.toThrow("Sender connected already");
    await sender.close();
  });

  it("connects lazily during flush", async function () {
    const server = await startServer();
    const sender = await Sender.fromConfig(
      `ws::addr=localhost:${server.server!.port};auto_flush=off`,
    );
    sender.table("t").intColumn("x", 1).atNow();
    expect(await sender.flush()).toBe(true);
    expect(server.frames).toHaveLength(1);
    await sender.close();
  });

  it("is idempotent when closed twice", async function () {
    const server = await startServer();
    const sender = await Sender.fromConfig(`ws::addr=localhost:${server.server!.port};auto_flush=off`);
    await sender.close();
    await sender.close();
  });

  it("throws when flushing with an unclosed row", async function () {
    const server = await startServer();
    const sender = await Sender.fromConfig(
      `ws::addr=localhost:${server.server!.port};auto_flush=off`,
    );
    sender.table("t").intColumn("x", 1);
    await expect(sender.flush()).rejects.toThrow(
      "the current row is not closed",
    );
    await sender.close();
  });

  it("ingests multiple rows of one table in a single message", async function () {
    const server = await startServer();
    const sender = await Sender.fromConfig(
      `ws::addr=localhost:${server.server!.port};auto_flush=off`,
    );
    for (let i = 0; i < 3; i++) {
      sender.table("t").intColumn("x", i).atNow();
    }
    await sender.flush();
    const frame = server.frames[0]!;
    expect(frame).not.toBeNull();
    await sender.close();
  });
});
