// @ts-check
import { describe, it, expect } from "bun:test";

import { SenderOptions } from "../src/options";

describe("Configuration string parser suite", function () {
  it("can parse a basic config string", async function () {
    const options = await SenderOptions.fromConfig(
      "wss::addr=host;username=user1;password=pwd;protocol_version=1",
    );
    expect(options.protocol).toBe("wss");
    expect(options.protocol_version).toBe("1");
    expect(options.addr).toBe("host");
    expect(options.username).toBe("user1");
    expect(options.password).toBe("pwd");
  });

  it("can parse a config string from environment variable", async function () {
    process.env.QDB_CLIENT_CONF = "ws::addr=host;";
    const options = await SenderOptions.fromEnv();
    expect(options.protocol).toBe("ws");
    expect(options.addr).toBe("host");
    delete process.env.QDB_CLIENT_CONF;
  });

  it("accepts only lowercase protocols", async function () {
    let options = await SenderOptions.fromConfig("ws::addr=host;");
    expect(options.protocol).toBe("ws");

    options = await SenderOptions.fromConfig("wss::addr=host;");
    expect(options.protocol).toBe("wss");

    await expect(SenderOptions.fromConfig("WS::")).rejects.toThrow(
      "Invalid protocol: 'WS', accepted protocols: 'ws', 'wss'",
    );
    await expect(SenderOptions.fromConfig("Ws::")).rejects.toThrow(
      "Invalid protocol: 'Ws', accepted protocols: 'ws', 'wss'",
    );
    await expect(SenderOptions.fromConfig("wSS::")).rejects.toThrow(
      "Invalid protocol: 'wSS', accepted protocols: 'ws', 'wss'",
    );
    await expect(SenderOptions.fromConfig("http::")).rejects.toThrow(
      "Invalid protocol: 'http', accepted protocols: 'ws', 'wss'",
    );
    await expect(SenderOptions.fromConfig("tcp::")).rejects.toThrow(
      "Invalid protocol: 'tcp', accepted protocols: 'ws', 'wss'",
    );
  });

  it("considers that keys and values are case-sensitive", async function () {
    const options = await SenderOptions.fromConfig(
      "wss::addr=Host;username=useR1;token=TOKEN;",
    );
    expect(options.protocol).toBe("wss");
    expect(options.addr).toBe("Host");
    expect(options.username).toBe("useR1");
    expect(options.token).toBe("TOKEN");

    await expect(SenderOptions.fromConfig(
          "wss::addr=Host;UserNAME=useR1;PaSswOrD=pWd;",
        )).rejects.toThrow("Unknown configuration key: 'UserNAME'");
    await expect(SenderOptions.fromConfig("wss::addr=Host;PaSswOrD=pWd;")).rejects.toThrow("Unknown configuration key: 'PaSswOrD'");
  });

  it("can parse with or without the last semicolon", async function () {
    let options = await SenderOptions.fromConfig(
      "wss::addr=host:9002;protocol_version=1;",
    );
    expect(options.protocol).toBe("wss");
    expect(options.addr).toBe("host:9002");

    options = await SenderOptions.fromConfig(
      "wss::addr=host:9002;protocol_version=1",
    );
    expect(options.protocol).toBe("wss");
    expect(options.addr).toBe("host:9002");

    options = await SenderOptions.fromConfig(
      "wss::addr=host:9002;token=abcde;protocol_version=1",
    );
    expect(options.protocol).toBe("wss");
    expect(options.addr).toBe("host:9002");
    expect(options.token).toBe("abcde");

    options = await SenderOptions.fromConfig(
      "wss::addr=host:9002;protocol_version=1;token=abcde;;",
    );
    expect(options.protocol).toBe("wss");
    expect(options.addr).toBe("host:9002");
    expect(options.token).toBe("abcde;");

    options = await SenderOptions.fromConfig(
      "wss::addr=host:9002;protocol_version=1;token=abcde;;;",
    );
    expect(options.protocol).toBe("wss");
    expect(options.addr).toBe("host:9002");
    expect(options.token).toBe("abcde;");
  });

  it("can parse escaped config string values", async function () {
    const options = await SenderOptions.fromConfig(
      "wss::addr=host:9002;protocol_version=1;username=us;;;;;;er;;1;;;password=p;;wd;",
    );
    expect(options.protocol).toBe("wss");
    expect(options.addr).toBe("host:9002");
    expect(options.username).toBe("us;;;er;1;");
    expect(options.password).toBe("p;wd");
  });

  it("can parse the address", async function () {
    let options = await SenderOptions.fromConfig(
      "wss::addr=host1:9002;token=resttoken123;protocol_version=1;",
    );
    expect(options.protocol).toBe("wss");
    expect(options.protocol_version).toBe("1");
    expect(options.addr).toBe("host1:9002");
    expect(options.host).toBe("host1");
    expect(options.port).toBe(9002);
    expect(options.token).toBe("resttoken123");

    options = await SenderOptions.fromConfig(
      "ws::addr=host2:9005;username=user1;token=jwkprivkey123;",
    );
    expect(options.protocol).toBe("ws");
    expect(options.addr).toBe("host2:9005");
    expect(options.host).toBe("host2");
    expect(options.port).toBe(9005);
    expect(options.username).toBe("user1");
    expect(options.token).toBe("jwkprivkey123");
  });

  it("can default the port", async function () {
    let options = await SenderOptions.fromConfig(
      "wss::addr=hostname;protocol_version=1;token=resttoken123;",
    );
    expect(options.protocol).toBe("wss");
    expect(options.addr).toBe("hostname");
    expect(options.host).toBe("hostname");
    expect(options.port).toBe(9000);
    expect(options.token).toBe("resttoken123");

    options = await SenderOptions.fromConfig(
      "ws::addr=hostname;protocol_version=1;token=resttoken123;",
    );
    expect(options.protocol).toBe("ws");
    expect(options.addr).toBe("hostname");
    expect(options.host).toBe("hostname");
    expect(options.port).toBe(9000);
    expect(options.token).toBe("resttoken123");
  });

  it("can parse protocol version", async function () {
    // invalid protocol version
    await expect(SenderOptions.fromConfig("ws::addr=hostname;protocol_version=2")).rejects.toThrow(
      "Invalid protocol version: '2', accepted values: 'auto', '1'",
    );
    await expect(SenderOptions.fromConfig(
          "ws::addr=hostname;protocol_version=0",
        )).rejects.toThrow(
      "Invalid protocol version: '0', accepted values: 'auto', '1'",
    );
    await expect(SenderOptions.fromConfig(
          "ws::addr=hostname;protocol_version=-1",
        )).rejects.toThrow(
      "Invalid protocol version: '-1', accepted values: 'auto', '1'",
    );
    await expect(SenderOptions.fromConfig(
          "ws::addr=hostname;protocol_version=automatic",
        )).rejects.toThrow(
      "Invalid protocol version: 'automatic', accepted values: 'auto', '1'",
    );

    // auto defaults to 1 (QWP supports a single version)
    let options = await SenderOptions.fromConfig("ws::addr=localhost");
    expect(options.protocol_version).toBe("1");
    options = await SenderOptions.fromConfig("wss::addr=localhost");
    expect(options.protocol_version).toBe("1");

    // explicit 1 and auto are accepted
    options = await SenderOptions.fromConfig(
      "ws::addr=localhost;protocol_version=1",
    );
    expect(options.protocol_version).toBe("1");
    options = await SenderOptions.fromConfig(
      "wss::addr=localhost;protocol_version=auto",
    );
    expect(options.protocol_version).toBe("1");
  });

  it("fails if port is not a positive integer", async function () {
    await expect(SenderOptions.fromConfig("ws::addr=host:;")).rejects.toThrow("Port is required");
    await expect(SenderOptions.fromConfig("ws::addr=host:0")).rejects.toThrow("Invalid port: 0");
    await expect(SenderOptions.fromConfig("ws::addr=host:0.2")).rejects.toThrow("Invalid port: 0.2");
    await expect(SenderOptions.fromConfig("ws::addr=host:-2")).rejects.toThrow("Invalid port: -2");
    await expect(SenderOptions.fromConfig("ws::addr=host:!;")).rejects.toThrow("Invalid port: '!'");
    await expect(SenderOptions.fromConfig("ws::addr=host:9009x;")).rejects.toThrow("Invalid port: '9009x'");
    await expect(SenderOptions.fromConfig("ws::addr=host:900 9;")).rejects.toThrow("Invalid port: '900 9'");
  });

  it("fails if init_buf_size is not a positive integer", async function () {
    await expect(SenderOptions.fromConfig("ws::addr=host;init_buf_size=;")).rejects.toThrow(
      "Invalid configuration, value is not set for 'init_buf_size'",
    );
    await expect(SenderOptions.fromConfig("ws::addr=host;init_buf_size=1024a;")).rejects.toThrow(
      "Invalid initial buffer size option, not a number: '1024a'",
    );
    await expect(SenderOptions.fromConfig("ws::addr=host;init_buf_size=102 4;")).rejects.toThrow(
      "Invalid initial buffer size option, not a number: '102 4'",
    );
    await expect(SenderOptions.fromConfig("ws::addr=host;init_buf_size=0;")).rejects.toThrow("Invalid initial buffer size option: 0");
  });

  it("fails if max_buf_size is not a positive integer", async function () {
    await expect(SenderOptions.fromConfig("ws::addr=host;max_buf_size=;")).rejects.toThrow(
      "Invalid configuration, value is not set for 'max_buf_size'",
    );
    await expect(SenderOptions.fromConfig("ws::addr=host;max_buf_size=1024a;")).rejects.toThrow("Invalid max buffer size option, not a number: '1024a'");
    await expect(SenderOptions.fromConfig("ws::addr=host;max_buf_size=102 4;")).rejects.toThrow("Invalid max buffer size option, not a number: '102 4'");
    await expect(SenderOptions.fromConfig("ws::addr=host;max_buf_size=0;")).rejects.toThrow("Invalid max buffer size option: 0");
  });

  it("rejects missing or empty hostname", async function () {
    await expect(SenderOptions.fromConfig("ws::")).rejects.toThrow("Invalid configuration, 'addr' is required");
    await expect(SenderOptions.fromConfig("ws::;")).rejects.toThrow("Missing '=' sign in ''");
    await expect(SenderOptions.fromConfig("ws::addr=;")).rejects.toThrow("Invalid configuration, value is not set for 'addr'");
    await expect(SenderOptions.fromConfig("ws::addr=;username=user1;")).rejects.toThrow("Invalid configuration, value is not set for 'addr'");
    await expect(SenderOptions.fromConfig("ws::username=user1;addr=;")).rejects.toThrow("Invalid configuration, value is not set for 'addr'");
    await expect(SenderOptions.fromConfig("ws::addr=:9000;")).rejects.toThrow("Host name is required");

    const options = await SenderOptions.fromConfig(
      "ws::addr=x;protocol_version=1",
    );
    expect(options.protocol).toBe("ws");
    expect(options.host).toBe("x");
  });

  it("does not default optional fields", async function () {
    const options = await SenderOptions.fromConfig(
      "wss::addr=host:9000;token=abcdef123;protocol_version=1;",
    );
    expect(options.protocol).toBe("wss");
    expect(options.token).toBe("abcdef123");
    expect(options.username).toBe(undefined);
    expect(options.password).toBe(undefined);
  });

  it("rejects invalid config value", async function () {
    await expect(SenderOptions.fromConfig("ws::addr=host:9000;username=;")).rejects.toThrow("Invalid configuration, value is not set for 'username'");

    await expect(SenderOptions.fromConfig("ws::addr=host:9000;username=user\t;")).rejects.toThrow(
      "Invalid configuration, control characters are not allowed: 'user\t'",
    );
    await expect(SenderOptions.fromConfig("ws::addr=host:9000;username=user\n;")).rejects.toThrow(
      "Invalid configuration, control characters are not allowed: 'user\n'",
    );

    let options = await SenderOptions.fromConfig(
      "ws::addr=host:9000;username=us\x7Eer;protocol_version=1;",
    );
    expect(options.protocol).toBe("ws");
    expect(options.addr).toBe("host:9000");
    expect(options.username).toBe("us\x7Eer");

    await expect(SenderOptions.fromConfig(
          "ws::addr=host:9000;username=us\x7Fer;",
        )).rejects.toThrow(
      "Invalid configuration, control characters are not allowed: 'us\x7Fer'",
    );
    await expect(SenderOptions.fromConfig(
          "ws::addr=host:9000;username=us\x9Fer;",
        )).rejects.toThrow(
      "Invalid configuration, control characters are not allowed: 'us\x9Fer'",
    );

    options = await SenderOptions.fromConfig(
      "ws::addr=host:9000;username=us\xA0er;protocol_version=1;",
    );
    expect(options.protocol).toBe("ws");
    expect(options.addr).toBe("host:9000");
    expect(options.username).toBe("us\xA0er");
  });

  it("reject invalid config keys", async function () {
    await expect(SenderOptions.fromConfig(
          "ws::addr=host:9000;username=user1;pass=pwd;",
        )).rejects.toThrow("Unknown configuration key: 'pass'");
    await expect(SenderOptions.fromConfig(
          "ws::addr=host:9000;user=user1;password=pwd;",
        )).rejects.toThrow("Unknown configuration key: 'user'");
    await expect(SenderOptions.fromConfig(
          "ws::addr=host:9000;username =user1;password=pwd;",
        )).rejects.toThrow("Unknown configuration key: 'username '");
    await expect(SenderOptions.fromConfig(
          "ws::addr=host:9000; username=user1;password=pwd;",
        )).rejects.toThrow("Unknown configuration key: ' username'");
    await expect(SenderOptions.fromConfig(
          "ws::addr=host:9000;user name=user1;password=pwd;",
        )).rejects.toThrow("Unknown configuration key: 'user name'");
  });

  it("rejects keys without value", async function () {
    await expect(SenderOptions.fromConfig("ws::addr;username=user1")).rejects.toThrow("Missing '=' sign in 'addr'");
    await expect(SenderOptions.fromConfig("ws::addr=host:9000;username;")).rejects.toThrow("Missing '=' sign in 'username'");
  });

  it("throws error if protocol is invalid", async function () {
    await expect(SenderOptions.fromConfig(
          "::addr=host;username=user1;password=pwd;",
        )).rejects.toThrow(
      "Invalid protocol: '', accepted protocols: 'ws', 'wss'",
    );
    await expect(SenderOptions.fromConfig(
          "htt::addr=host;username=user1;password=pwd;",
        )).rejects.toThrow(
      "Invalid protocol: 'htt', accepted protocols: 'ws', 'wss'",
    );
  });

  it("throws error if protocol is missing", async function () {
    await expect(SenderOptions.fromConfig(
          "addr=host;username=user1;password=pwd;",
        )).rejects.toThrow(
      "Missing protocol, configuration string format: 'protocol::key1=value1;key2=value2;key3=value3;'",
    );
    await expect(SenderOptions.fromConfig(
          "wss:addr=host;username=user1;password=pwd;",
        )).rejects.toThrow(
      "Missing protocol, configuration string format: 'protocol::key1=value1;key2=value2;key3=value3;'",
    );
  });

  it("throws error if configuration string is missing", async function () {
    // @ts-expect-error - Testing invalid input
    await expect(SenderOptions.fromConfig()).rejects.toThrow(
      "Configuration string is missing",
    );
    await expect(SenderOptions.fromConfig("")).rejects.toThrow(
      "Configuration string is missing",
    );
    await expect(
      SenderOptions.fromConfig(null as unknown as string),
    ).rejects.toThrow("Configuration string is missing");
    await expect(
      SenderOptions.fromConfig(undefined as unknown as string),
    ).rejects.toThrow("Configuration string is missing");
  });

  it("can parse auto_flush config", async function () {
    let options = await SenderOptions.fromConfig(
      "ws::addr=host:9000;protocol_version=1;auto_flush=on;",
    );
    expect(options.protocol).toBe("ws");
    expect(options.host).toBe("host");
    expect(options.port).toBe(9000);
    expect(options.auto_flush).toBe(true);

    options = await SenderOptions.fromConfig(
      "ws::addr=host:9000;protocol_version=1;auto_flush=off;",
    );
    expect(options.protocol).toBe("ws");
    expect(options.host).toBe("host");
    expect(options.port).toBe(9000);
    expect(options.auto_flush).toBe(false);

    await expect(SenderOptions.fromConfig(
          "ws::addr=host:9000;protocol_version=1;auto_flush=ON;",
        )).rejects.toThrow("Invalid auto flush option: 'ON'");
    await expect(SenderOptions.fromConfig(
          "ws::addr=host:9000;protocol_version=1;auto_flush=On;",
        )).rejects.toThrow("Invalid auto flush option: 'On'");
    await expect(SenderOptions.fromConfig(
          "ws::addr=host:9000;protocol_version=1;auto_flush=true;",
        )).rejects.toThrow("Invalid auto flush option: 'true'");
    await expect(SenderOptions.fromConfig(
          "ws::addr=host:9000;protocol_version=1;auto_flush=OFF;",
        )).rejects.toThrow("Invalid auto flush option: 'OFF'");
    await expect(SenderOptions.fromConfig(
          "ws::addr=host:9000;protocol_version=1;auto_flush=Off;",
        )).rejects.toThrow("Invalid auto flush option: 'Off'");
    await expect(SenderOptions.fromConfig(
          "ws::addr=host:9000;protocol_version=1;auto_flush=false;",
        )).rejects.toThrow("Invalid auto flush option: 'false'");
  });

  it("can parse auto_flush_rows config", async function () {
    let options = await SenderOptions.fromConfig(
      "ws::addr=host:9000;protocol_version=1;auto_flush_rows=123;",
    );
    expect(options.protocol).toBe("ws");
    expect(options.auto_flush_rows).toBe(123);

    options = await SenderOptions.fromConfig(
      "ws::addr=host:9000;protocol_version=1;auto_flush_rows=0;",
    );
    expect(options.protocol).toBe("ws");
    expect(options.auto_flush_rows).toBe(0);

    await expect(SenderOptions.fromConfig(
          "ws::addr=host:9000;protocol_version=1;auto_flush_rows=-123;",
        )).rejects.toThrow("Invalid auto flush rows option: -123");
    await expect(SenderOptions.fromConfig(
          "ws::addr=host:9000;protocol_version=1;auto_flush_rows=1.23;",
        )).rejects.toThrow("Invalid auto flush rows option: 1.23");
    await expect(SenderOptions.fromConfig(
          "ws::addr=host:9000;protocol_version=1;auto_flush_rows=123x;",
        )).rejects.toThrow("Invalid auto flush rows option, not a number: '123x'");
    await expect(SenderOptions.fromConfig(
          "ws::addr=host:9000;protocol_version=1;auto_flush_rows=a123;",
        )).rejects.toThrow("Invalid auto flush rows option, not a number: 'a123'");
    await expect(SenderOptions.fromConfig(
          "ws::addr=host:9000;protocol_version=1;auto_flush_rows=1w23;",
        )).rejects.toThrow("Invalid auto flush rows option, not a number: '1w23'");
  });

  it("can parse auto_flush_interval config", async function () {
    let options = await SenderOptions.fromConfig(
      "ws::addr=host:9000;protocol_version=1;auto_flush_interval=30",
    );
    expect(options.protocol).toBe("ws");
    expect(options.auto_flush_interval).toBe(30);

    options = await SenderOptions.fromConfig(
      "ws::addr=host:9000;protocol_version=1;auto_flush_interval=0",
    );
    expect(options.protocol).toBe("ws");
    expect(options.auto_flush_interval).toBe(0);

    await expect(SenderOptions.fromConfig(
          "ws::addr=host:9000;protocol_version=1;auto_flush_interval=-60",
        )).rejects.toThrow("Invalid auto flush interval option: -60");
    await expect(SenderOptions.fromConfig(
          "ws::addr=host:9000;protocol_version=1;auto_flush_interval=-6.0",
        )).rejects.toThrow("Invalid auto flush interval option: -6");
    await expect(SenderOptions.fromConfig(
          "ws::addr=host:9000;protocol_version=1;auto_flush_interval=60x",
        )).rejects.toThrow(
      "Invalid auto flush interval option, not a number: '60x'",
    );
    await expect(SenderOptions.fromConfig(
          "ws::addr=host:9000;protocol_version=1;auto_flush_interval=a60",
        )).rejects.toThrow(
      "Invalid auto flush interval option, not a number: 'a60'",
    );
    await expect(SenderOptions.fromConfig(
          "ws::addr=host:9000;protocol_version=1;auto_flush_interval=6w0",
        )).rejects.toThrow(
      "Invalid auto flush interval option, not a number: '6w0'",
    );
  });

  it("can parse tls_verify config", async function () {
    let options = await SenderOptions.fromConfig(
      "wss::addr=host:9000;protocol_version=1;tls_verify=on",
    );
    expect(options.protocol).toBe("wss");
    expect(options.host).toBe("host");
    expect(options.port).toBe(9000);
    expect(options.tls_verify).toBe(true);

    options = await SenderOptions.fromConfig(
      "wss::addr=host:9000;protocol_version=1;tls_verify=unsafe_off",
    );
    expect(options.protocol).toBe("wss");
    expect(options.host).toBe("host");
    expect(options.port).toBe(9000);
    expect(options.tls_verify).toBe(false);

    await expect(SenderOptions.fromConfig(
          "wss::addr=host:9000;protocol_version=1;tls_verify=ON",
        )).rejects.toThrow("Invalid TLS verify option: 'ON'");
    await expect(SenderOptions.fromConfig(
          "wss::addr=host:9000;protocol_version=1;tls_verify=true",
        )).rejects.toThrow("Invalid TLS verify option: 'true'");
    await expect(SenderOptions.fromConfig(
          "wss::addr=host:9000;protocol_version=1;tls_verify=OFF",
        )).rejects.toThrow("Invalid TLS verify option: 'OFF'");
    await expect(SenderOptions.fromConfig(
          "wss::addr=host:9000;protocol_version=1;tls_verify=unsafe_OFF",
        )).rejects.toThrow("Invalid TLS verify option: 'unsafe_OFF'");
    await expect(SenderOptions.fromConfig(
          "wss::addr=host:9000;protocol_version=1;tls_verify=false",
        )).rejects.toThrow("Invalid TLS verify option: 'false'");
  });

  it("fails with tls_roots or tls_roots_password config", async function () {
    await expect(SenderOptions.fromConfig(
          "wss::addr=host:9000;protocol_version=1;tls_roots=/whatever/path",
        )).rejects.toThrow(
      "'tls_roots' and 'tls_roots_password' options are not supported, please, use the 'tls_ca' option or the NODE_EXTRA_CA_CERTS environment variable instead",
    );
    await expect(SenderOptions.fromConfig(
          "wss::addr=host:9000;protocol_version=1;tls_roots_password=pwd",
        )).rejects.toThrow(
      "'tls_roots' and 'tls_roots_password' options are not supported, please, use the 'tls_ca' option or the NODE_EXTRA_CA_CERTS environment variable instead",
    );
  });

  it("can parse request_min_throughput config", async function () {
    const options = await SenderOptions.fromConfig(
      "ws::addr=host:9000;protocol_version=1;request_min_throughput=300",
    );
    expect(options.protocol).toBe("ws");
    expect(options.request_min_throughput).toBe(300);

    await expect(SenderOptions.fromConfig(
          "ws::addr=host:9000;protocol_version=1;request_min_throughput=0",
        )).rejects.toThrow("Invalid request min throughput option: 0");
    await expect(SenderOptions.fromConfig(
          "ws::addr=host:9000;protocol_version=1;request_min_throughput=0.5",
        )).rejects.toThrow("Invalid request min throughput option: 0.5");
    await expect(SenderOptions.fromConfig(
          "ws::addr=host:9000;protocol_version=1;request_min_throughput=-60",
        )).rejects.toThrow("Invalid request min throughput option: -60");
    await expect(SenderOptions.fromConfig(
          "ws::addr=host:9000;protocol_version=1;request_min_throughput=60x",
        )).rejects.toThrow(
      "Invalid request min throughput option, not a number: '60x'",
    );
  });

  it("can parse request_timeout config", async function () {
    const options = await SenderOptions.fromConfig(
      "ws::addr=host:9000;protocol_version=1;request_timeout=30",
    );
    expect(options.protocol).toBe("ws");
    expect(options.request_timeout).toBe(30);

    await expect(SenderOptions.fromConfig(
          "ws::addr=host:9000;protocol_version=1;request_timeout=0",
        )).rejects.toThrow("Invalid request timeout option: 0");
    await expect(SenderOptions.fromConfig(
          "ws::addr=host:9000;protocol_version=1;request_timeout=10.32",
        )).rejects.toThrow("Invalid request timeout option: 10.32");
    await expect(SenderOptions.fromConfig(
          "ws::addr=host:9000;protocol_version=1;request_timeout=-60",
        )).rejects.toThrow("Invalid request timeout option: -60");
    await expect(SenderOptions.fromConfig(
          "ws::addr=host:9000;protocol_version=1;request_timeout=60x",
        )).rejects.toThrow("Invalid request timeout option, not a number: '60x'");
  });

  it("can parse retry_timeout config", async function () {
    let options = await SenderOptions.fromConfig(
      "ws::addr=host:9000;protocol_version=1;retry_timeout=60",
    );
    expect(options.protocol).toBe("ws");
    expect(options.retry_timeout).toBe(60);

    options = await SenderOptions.fromConfig(
      "ws::addr=host:9000;protocol_version=1;retry_timeout=0",
    );
    expect(options.protocol).toBe("ws");
    expect(options.retry_timeout).toBe(0);

    await expect(SenderOptions.fromConfig(
          "ws::addr=host:9000;protocol_version=1;retry_timeout=-60",
        )).rejects.toThrow("Invalid retry timeout option: -60");
    await expect(SenderOptions.fromConfig(
          "ws::addr=host:9000;protocol_version=1;retry_timeout=60x",
        )).rejects.toThrow("Invalid retry timeout option, not a number: '60x'");
  });

  it("can parse max_name_len config", async function () {
    const options = await SenderOptions.fromConfig(
      "ws::addr=host:9000;protocol_version=1;max_name_len=30",
    );
    expect(options.protocol).toBe("ws");
    expect(options.max_name_len).toBe(30);

    await expect(SenderOptions.fromConfig(
          "ws::addr=host:9000;protocol_version=1;max_name_len=0",
        )).rejects.toThrow("Invalid max name length option: 0");
    await expect(SenderOptions.fromConfig(
          "ws::addr=host:9000;protocol_version=1;max_name_len=10.32",
        )).rejects.toThrow("Invalid max name length option: 10.32");
    await expect(SenderOptions.fromConfig(
          "ws::addr=host:9000;protocol_version=1;max_name_len=60x",
        )).rejects.toThrow("Invalid max name length option, not a number: '60x'");
  });

  it("can take a custom logger", async function () {
    const options = await SenderOptions.fromConfig(
      "ws::addr=host:9000;protocol_version=1",
      {
        log: console.log,
      },
    );
    expect(options.protocol).toBe("ws");
    expect(options.log).toBe(console.log);

    await expect(SenderOptions.fromConfig(
          "ws::addr=host:9000;protocol_version=1",
          // @ts-expect-error - Testing invalid input
          { log: 1234 },
        )).rejects.toThrow("Invalid logging function");
    await expect(SenderOptions.fromConfig(
          "ws::addr=host:9000;protocol_version=1",
          {
            // @ts-expect-error - Testing invalid input
            log: "hoppa",
          },
        )).rejects.toThrow("Invalid logging function");
  });
});
