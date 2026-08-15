// @ts-check
import { describe, it, expect } from "bun:test";

import { Sender } from "../src";
import { log } from "../src/logging";

describe("Sender configuration options suite", function () {
  it("creates a sender from a configuration string", async function () {
    const sender = await Sender.fromConfig("ws::addr=hostname;");
    await sender.close();
  });

  it("creates a sender from a configuration string picked up from env", async function () {
    process.env.QDB_CLIENT_CONF = "wss::addr=hostname;protocol_version=1";
    await (await Sender.fromEnv()).close();
    delete process.env.QDB_CLIENT_CONF;
  });

  it("throws exception if tls_roots or tls_roots_password is used", async function () {
    await expect((async () => {
      const sender = await Sender.fromConfig(
        "wss::addr=hostname;username=bobo;tls_roots=bla;",
      );
      await sender.close();
    })()).rejects.toThrow(
      "'tls_roots' and 'tls_roots_password' options are not supported, please, use the 'tls_ca' option or the NODE_EXTRA_CA_CERTS environment variable instead",
    );

    await expect((async () => {
      const sender = await Sender.fromConfig(
        "wss::addr=hostname;token=bobo_token;tls_roots_password=bla;",
      );
      await sender.close();
    })()).rejects.toThrow(
      "'tls_roots' and 'tls_roots_password' options are not supported, please, use the 'tls_ca' option or the NODE_EXTRA_CA_CERTS environment variable instead",
    );
  });

  it("fails to connect when the server is unreachable", async function () {
    await expect((async () => {
      const sender = await Sender.fromConfig(
        "ws::addr=localhost:1;request_timeout=500",
      );
      await sender.connect();
      await sender.close();
    })()).rejects.toThrow("Failed to connect");
  });

  it("fails if the host is missing", async function () {
    expect(() => new Sender({ protocol: "ws" })).toThrow(
      "The 'host' option is mandatory",
    );
  });

  it("accepts the stale_retries option from the config string", async function () {
    const sender = await Sender.fromConfig("ws::addr=host;stale_retries=5");
    expect(staleRetries(sender)).toBe(5);
    await sender.close();
  });

  it("rejects an invalid stale_retries value", async function () {
    await expect((async () => {
      const sender = await Sender.fromConfig("ws::addr=host;stale_retries=0");
      await sender.close();
    })()).rejects.toThrow("Invalid stale table retries option: 0");
  });
});

describe("Sender options test suite", function () {
  it("fails if no options defined", async function () {
    // @ts-expect-error - Testing invalid options
    expect(() => new Sender()).toThrow("The 'protocol' option is mandatory");
  });

  it("fails if options are null", async function () {
    // @ts-expect-error - Testing invalid options
    expect(() => new Sender(null)).toThrow("The 'protocol' option is mandatory");
  });

  it("fails if options are undefined", async function () {
    // @ts-expect-error - Testing invalid options
    expect(() => new Sender(undefined)).toThrow(
      "The 'protocol' option is mandatory",
    );
  });

  it("fails if options are empty", async function () {
    // @ts-expect-error - Testing invalid options
    expect(() => new Sender({})).toThrow("The 'protocol' option is mandatory");
  });

  it("fails if protocol option is missing", async function () {
    // @ts-expect-error - Testing invalid options
    expect(() => new Sender({ host: "host" })).toThrow(
      "The 'protocol' option is mandatory",
    );
  });

  it("fails if protocol option is invalid", async function () {
    expect(() => new Sender({ protocol: "abcd", host: "hostname" })).toThrow(
      "Invalid protocol: 'abcd'",
    );
  });

  it("throws error if initial buffer size is greater than max_buf_size", async function () {
    expect(
      () =>
        new Sender({
          protocol: "ws",
          protocol_version: "1",
          host: "host",
          max_buf_size: 8192,
          init_buf_size: 16384,
        }),
    ).toThrow("Max buffer size is 8192 bytes, requested buffer size: 16384");
  });

  it("accepts a valid buffer size configuration", async function () {
    const sender = new Sender({
      protocol: "ws",
      protocol_version: "1",
      host: "host",
      init_buf_size: 1024,
      max_buf_size: 131072,
    });
    await sender.close();
  });

  it("warns about deprecated option 'copy_buffer'", async function () {
    const log = (
      level: "error" | "warn" | "info" | "debug",
      message: string | Error,
    ) => {
      if (level !== "debug") {
        expect(level).toBe("warn");
        expect(message).toMatch(
          "Option 'copy_buffer' is not supported anymore, please, remove it",
        );
      }
    };
    const sender = new Sender({
      protocol: "ws",
      protocol_version: "1",
      host: "host",
      // @ts-expect-error - Testing deprecated option
      copy_buffer: false,
      log: log,
    });
    await sender.close();
  });

  it("warns about deprecated option 'copyBuffer'", async function () {
    const log = (
      level: "error" | "warn" | "info" | "debug",
      message: string | Error,
    ) => {
      if (level !== "debug") {
        expect(level).toBe("warn");
        expect(message).toMatch(
          "Option 'copyBuffer' is not supported anymore, please, remove it",
        );
      }
    };
    const sender = new Sender({
      protocol: "ws",
      protocol_version: "1",
      host: "host",
      // @ts-expect-error - Testing deprecated option
      copyBuffer: false,
      log: log,
    });
    await sender.close();
  });

  it("migrates deprecated 'bufferSize' to 'init_buf_size'", async function () {
    const log = (
      level: "error" | "warn" | "info" | "debug",
      message: string | Error,
    ) => {
      if (level !== "debug") {
        expect(level).toBe("warn");
        expect(message).toMatch(
          "Option 'bufferSize' is not supported anymore, please, replace it with 'init_buf_size'",
        );
      }
    };
    const sender = new Sender({
      protocol: "ws",
      protocol_version: "1",
      host: "host",
      // @ts-expect-error - Testing deprecated option
      bufferSize: 2048,
      log: log,
    });
    await sender.close();
  });

  it("uses default logger if log function is not set", async function () {
    const sender = new Sender({
      protocol: "ws",
      protocol_version: "1",
      host: "host",
    });
    expect(logger(sender)).toBe(log);
    await sender.close();
  });

  it("uses the required log function if it is set", async function () {
    const testFunc = () => {};
    const sender = new Sender({
      protocol: "ws",
      protocol_version: "1",
      host: "host",
      log: testFunc,
    });
    expect(logger(sender)).toBe(testFunc);
    await sender.close();
  });

  it("uses default logger if log is set to null", async function () {
    const sender = new Sender({
      protocol: "ws",
      protocol_version: "1",
      host: "host",
      // @ts-expect-error - Testing invalid options
      log: null,
    });
    expect(logger(sender)).toBe(log);
    await sender.close();
  });

  it("uses default logger if log is set to undefined", async function () {
    const sender = new Sender({
      protocol: "ws",
      protocol_version: "1",
      host: "host",
      log: undefined,
    });
    expect(logger(sender)).toBe(log);
    await sender.close();
  });

  it("uses default logger if log is not a function", async function () {
    const sender = new Sender({
      protocol: "ws",
      protocol_version: "1",
      host: "host",
      // @ts-expect-error - Testing invalid options
      log: "",
    });
    expect(logger(sender)).toBe(log);
    await sender.close();
  });
});

function logger(sender: Sender) {
  // @ts-expect-error - Accessing private field
  return sender.log;
}

function staleRetries(sender: Sender) {
  // @ts-expect-error - Accessing private field
  return sender.staleRetries;
}
