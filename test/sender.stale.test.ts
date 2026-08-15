// @ts-check
import { describe, it, expect, afterEach } from "bun:test";

import { Sender } from "../src";
import { MockQwpServer, parseFrameTableNames } from "./util/mockws";

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

describe("Sender stale table recovery suite", function () {
  it("acknowledges a normal flush in a single frame", async function () {
    const server = await startServer();
    const sender = await Sender.fromConfig(
      `ws::addr=localhost:${server.server!.port};auto_flush=off`,
    );

    sender.table("t").intColumn("value", 1).atNow();
    expect(await sender.flush()).toBe(true);

    expect(server.frames).toHaveLength(1);
    expect(parseFrameTableNames(server.frames[0]!)).toEqual(["t"]);
    await sender.close();
  });

  it("re-sends a table whose ack omits it (first swallowed frame)", async function () {
    const server = await startServer();
    server.script = [{ t: "drop" }, { t: "advance" }];
    const sender = await Sender.fromConfig(
      `ws::addr=localhost:${server.server!.port};auto_flush=off`,
    );

    sender.table("t").intColumn("value", 1).atNow();
    expect(await sender.flush()).toBe(true);

    // frame 1: dropped by the server; frame 2: the client's single-table retry
    expect(server.frames).toHaveLength(2);
    expect(parseFrameTableNames(server.frames[0]!)).toEqual(["t"]);
    expect(parseFrameTableNames(server.frames[1]!)).toEqual(["t"]);
    await sender.close();
  });

  it("re-sends only the stale table of a multi-table frame", async function () {
    const server = await startServer();
    server.script = [
      { a: "advance", b: "drop" },
      { b: "advance" },
    ];
    const sender = await Sender.fromConfig(
      `ws::addr=localhost:${server.server!.port};auto_flush=off`,
    );

    sender.table("a").intColumn("value", 1).atNow();
    sender.table("b").intColumn("value", 2).atNow();
    expect(await sender.flush()).toBe(true);

    expect(server.frames).toHaveLength(2);
    expect(parseFrameTableNames(server.frames[0]!)).toEqual(["a", "b"]);
    // only the stale table b is re-sent, not the already-acked table a
    expect(parseFrameTableNames(server.frames[1]!)).toEqual(["b"]);
    await sender.close();
  });

  it("throws after exhausting retries and retries the retained data on the next flush", async function () {
    const server = await startServer();
    // initial frame + 3 retries all hold the seqTxn at 0
    server.script = [{ t: "hold" }, { t: "hold" }, { t: "hold" }, { t: "hold" }];
    const sender = await Sender.fromConfig(
      `ws::addr=localhost:${server.server!.port};auto_flush=off`,
    );

    sender.table("t").intColumn("value", 1).atNow();
    await expect(sender.flush()).rejects.toThrow(
      "the table may have just been DROPped and recreated",
    );
    // data is retained: the next flush re-sends it and succeeds
    expect(await sender.flush()).toBe(true);
    expect(server.frames).toHaveLength(5);
    await sender.close();
  });

  it("matches acks case-insensitively", async function () {
    const server = await startServer();
    // the server acks table T under its lower-cased name t
    server.script = [{ t: { mode: "advance", name: "t" } }];
    const sender = await Sender.fromConfig(
      `ws::addr=localhost:${server.server!.port};auto_flush=off`,
    );

    sender.table("T").intColumn("value", 1).atNow();
    expect(await sender.flush()).toBe(true);

    expect(server.frames).toHaveLength(1);
    expect(parseFrameTableNames(server.frames[0]!)).toEqual(["T"]);
    await sender.close();
  });

  it("warns on close when the stale retry queue is not empty", async function () {
    const server = await startServer();
    server.script = [{ t: "hold" }, { t: "hold" }, { t: "hold" }, { t: "hold" }];
    const warnings: string[] = [];
    const sender = await Sender.fromConfig(
      `ws::addr=localhost:${server.server!.port};auto_flush=off`,
      {
        log: (level, message) => {
          if (level === "warn") {
            warnings.push(String(message));
          }
        },
      },
    );

    sender.table("t").intColumn("value", 1).atNow();
    await expect(sender.flush()).rejects.toThrow();
    await sender.close();

    expect(
      warnings.some((message) =>
        message.includes("Retry queue contains data"),
      ),
    ).toBe(true);
  });
});
