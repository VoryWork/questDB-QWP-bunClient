// @ts-check
import { describe, it, expect, afterEach } from "bun:test";

import { Sender } from "../src";
import { QwpError } from "../src/qwp/errors";
import type { Logger } from "../src/logging";
import { MockQwpServer } from "./util/mockws";

const servers: MockQwpServer[] = [];
const senders: Sender[] = [];
const silentLogger: Logger = () => {};

async function startServer(): Promise<MockQwpServer> {
  const server = new MockQwpServer();
  await server.start(0);
  servers.push(server);
  return server;
}

async function makeSender(
  server: MockQwpServer,
  extra = "",
  log: Logger = silentLogger,
): Promise<Sender> {
  const sender = await Sender.fromConfig(
    `ws::addr=localhost:${server.server!.port};auto_flush=off;request_timeout=200;ack_timeout=60;replay_backoff_ms=0${extra}`,
    { log },
  );
  senders.push(sender);
  return sender;
}

async function rejection(promise: Promise<unknown>): Promise<QwpError> {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof QwpError)) {
      throw error;
    }
    return error;
  }
  throw new Error("expected the operation to reject");
}

afterEach(async () => {
  for (const sender of senders.splice(0)) {
    try {
      await sender.close();
    } catch {
      // ignore cleanup failures
    }
  }
  while (servers.length > 0) {
    await servers.pop()!.stop();
  }
});

describe("Sender delivery outcome suite", function () {
  it("replays the same frame once after an ack timeout when enabled", async function () {
    const server = await startServer();
    server.frameActions = ["silent", "ack"];
    const sender = await makeSender(server, ";resend_on_unknown=on");

    await sender.table("t").intColumn("x", 1).atNow();
    await expect(sender.flush()).resolves.toBe(true);

    expect(server.frames).toHaveLength(2);
    expect(server.connectionCount).toBe(2);
    expect(sender.hasPendingWrite()).toBe(false);
  });

  it("keeps the data and throws an unknown-delivery error by default", async function () {
    const server = await startServer();
    server.frameActions = ["silent"];
    const sender = await makeSender(server);

    await sender.table("t").intColumn("x", 1).atNow();
    const error = await rejection(sender.flush());

    expect(error.code).toBe("ACK_TIMEOUT");
    expect(error.delivery).toBe("unknown");
    expect(error.retryable).toBe(true);
    expect(server.frames).toHaveLength(1);
    expect(sender.hasPendingWrite()).toBe(true);
  });

  it("rejects after the replay also times out and still keeps the data", async function () {
    const server = await startServer();
    server.frameActions = ["silent", "silent"];
    const sender = await makeSender(server, ";resend_on_unknown=on");

    await sender.table("t").intColumn("x", 1).atNow();
    const error = await rejection(sender.flush());

    expect(error.code).toBe("ACK_TIMEOUT");
    expect(error.delivery).toBe("unknown");
    expect(server.frames).toHaveLength(2);
    expect(sender.hasPendingWrite()).toBe(true);
  });

  it("retries the retained frame through retryPending()", async function () {
    const server = await startServer();
    server.frameActions = ["silent", "silent"];
    const sender = await makeSender(server, ";resend_on_unknown=on");

    await sender.table("t").intColumn("x", 1).atNow();
    await rejection(sender.flush());

    await expect(sender.retryPending()).resolves.toBe(true);
    expect(server.frames).toHaveLength(3);
    expect(sender.hasPendingWrite()).toBe(false);
  });

  it("drains the retained frame byte-for-byte before new rows on the next flush", async function () {
    const server = await startServer();
    server.frameActions = ["silent"];
    const sender = await makeSender(server);

    await sender.table("t").intColumn("x", 1).atNow();
    await rejection(sender.flush());

    await sender.table("t").intColumn("x", 2).atNow();
    await expect(sender.flush()).resolves.toBe(true);

    expect(server.frames).toHaveLength(3);
    expect(server.frames[1]).toEqual(server.frames[0]);
    expect(sender.hasPendingWrite()).toBe(false);
  });

  it("replays after the connection drops mid-flight", async function () {
    const server = await startServer();
    server.frameActions = ["close", "ack"];
    const sender = await makeSender(server, ";resend_on_unknown=on");

    await sender.table("t").intColumn("x", 1).atNow();
    await expect(sender.flush()).resolves.toBe(true);

    expect(server.frames).toHaveLength(2);
    expect(server.connectionCount).toBe(2);
    expect(sender.hasPendingWrite()).toBe(false);
  });

  it("replays a NOT_WRITABLE rejection even without resend_on_unknown", async function () {
    const server = await startServer();
    server.frameErrors = [{ status: 0x0c, message: "WAL busy" }, null];
    const sender = await makeSender(server);

    await sender.table("t").intColumn("x", 1).atNow();
    await expect(sender.flush()).resolves.toBe(true);

    expect(server.frames).toHaveLength(2);
    expect(sender.hasPendingWrite()).toBe(false);
  });

  it("reports a repeated NOT_WRITABLE rejection as retryable", async function () {
    const server = await startServer();
    server.frameErrors = [
      { status: 0x0c, message: "WAL busy" },
      { status: 0x0c, message: "WAL busy" },
    ];
    const sender = await makeSender(server);

    await sender.table("t").intColumn("x", 1).atNow();
    const error = await rejection(sender.flush());

    expect(error.code).toBe("NOT_WRITABLE");
    expect(error.delivery).toBe("rejected");
    expect(error.retryable).toBe(true);
    expect(server.frames).toHaveLength(2);
    expect(sender.hasPendingWrite()).toBe(true);
  });

  it("does not replay a deterministic schema mismatch", async function () {
    const server = await startServer();
    server.errorStatus = { status: 0x03, message: "table does not exist" };
    const sender = await makeSender(server);

    await sender.table("t").intColumn("x", 1).atNow();
    const error = await rejection(sender.flush());

    expect(error.code).toBe("SCHEMA_MISMATCH");
    expect(error.delivery).toBe("rejected");
    expect(error.retryable).toBe(false);
    expect(server.frames).toHaveLength(1);
    expect(sender.hasPendingWrite()).toBe(false);
  });

  it("treats a durable ack as success", async function () {
    const server = await startServer();
    server.durableAck = true;
    const sender = await makeSender(server);

    await sender.table("t").intColumn("x", 1).atNow();
    await expect(sender.flush()).resolves.toBe(true);

    expect(server.frames).toHaveLength(1);
    expect(sender.hasPendingWrite()).toBe(false);
  });

  it("does not start a replay when the flush deadline leaves no budget", async function () {
    const server = await startServer();
    server.frameActions = ["silent"];
    const sender = await makeSender(server, ";resend_on_unknown=on");

    await sender.table("t").intColumn("x", 1).atNow();
    const started = Date.now();
    const error = await rejection(sender.flush(50));

    expect(error.code).toBe("ACK_TIMEOUT");
    expect(error.delivery).toBe("unknown");
    expect(server.frames).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(500);
    expect(sender.hasPendingWrite()).toBe(true);
  });

  it("reports a connect failure as not-sent", async function () {
    const sender = await Sender.fromConfig(
      "ws::addr=localhost:1;auto_flush=off;request_timeout=50;replay_backoff_ms=0",
      { log: silentLogger },
    );
    senders.push(sender);

    await sender.table("t").intColumn("x", 1).atNow();
    const error = await rejection(sender.flush());

    expect(error.code).toBe("CONNECT_FAILED");
    expect(error.delivery).toBe("not_sent");
    expect(error.retryable).toBe(true);
  });

  it("drops the retained frame after a deterministic rejection", async function () {
    const server = await startServer();
    server.frameActions = ["silent"];
    const sender = await makeSender(server);

    await sender.table("t").intColumn("x", 1).atNow();
    await rejection(sender.flush());
    expect(sender.hasPendingWrite()).toBe(true);

    server.errorStatus = { status: 0x03, message: "column does not exist" };
    const error = await rejection(sender.retryPending());

    expect(error.code).toBe("SCHEMA_MISMATCH");
    expect(sender.hasPendingWrite()).toBe(false);
  });

  it("warns about the retained frame when closing", async function () {
    const warnings: string[] = [];
    const log: Logger = (level, message) => {
      if (level === "warn") {
        warnings.push(String(message));
      }
    };
    const server = await startServer();
    server.frameActions = ["silent"];
    const sender = await makeSender(server, "", log);

    await sender.table("t").intColumn("x", 1).atNow();
    await rejection(sender.flush());
    await sender.close();

    expect(
      warnings.some((message) => message.includes("unacknowledged frame")),
    ).toBe(true);
  });
});
