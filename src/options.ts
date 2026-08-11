import type { Logger } from "./logging";
import { isBoolean } from "./utils";

const WS_PORT = 9000;

const WS = "ws";
const WSS = "wss";

const ON = "on";
const OFF = "off";
const UNSAFE_OFF = "unsafe_off";

const PROTOCOL_VERSION_AUTO = "auto";
const PROTOCOL_VERSION_V1 = "1";

type ExtraOptions = {
  log?: Logger;
};

type DeprecatedOptions = {
  /** @deprecated */
  copy_buffer?: boolean;
  /** @deprecated */
  copyBuffer?: boolean;
  /** @deprecated */
  bufferSize?: number;
};

/**
 * {@link Sender} configuration options.
 * <br>
 * Properties of the object are initialized through a configuration string. <br>
 * The configuration string has the following format: <i>protocol</i>::<i>key</i>=<i>value</i>;<i>key</i>=<i>value</i>...</i> <br>
 * The keys are case-sensitive, the trailing semicolon is optional. <br>
 * The values are validated and an error is thrown if the format is invalid. <br>
 * <br>
 * Connection and protocol options
 * <ul>
 * <li> <b>protocol</b>: <i>enum, accepted values: ws, wss</i> - The protocol used to communicate with the server. <br>
 * Both protocols use the QuestDB Wire Protocol (QWP) over a WebSocket connection. <br>
 * When <i>wss</i> is used, the connection is secured with TLS encryption.
 * </li>
 * <li> <b>protocol_version</b>: <i>enum, accepted values: auto, 1</i> - The protocol version used for data serialization. <br>
 * QWP currently supports a single version, so this option always resolves to 1.
 * </li>
 * <li> addr: <i>string</i> - Hostname and port, separated by colon. This key is mandatory, but the port part is optional. <br>
 * If no port is specified, a default will be used. <br>
 * The port defaults to 9000 for both <i>ws</i> and <i>wss</i> protocols. <br>
 * <br>
 * Examples: <i>ws::addr=localhost:9000</i>, <i>wss::addr=localhost:9000</i>, <i>ws::addr=localhost</i>
 * </li>
 * </ul>
 * <br>
 * Authentication options
 * <ul>
 * <li> username: <i>string</i> - Used for Basic authentication, requires the <i>password</i> option.
 * The credentials are sent in the <i>Authorization: Basic ...</i> header during the WebSocket upgrade handshake.
 * </li>
 * <li> password: <i>string</i> - Password for Basic authentication, should be accompanied by the <i>username</i> option.
 * </li>
 * <li> token: <i>string</i> - Bearer token, sent in the <i>Authorization: Bearer ...</i> header during the WebSocket
 * upgrade handshake. Note that token-based authentication is supported by QuestDB Enterprise only.
 * </li>
 * </ul>
 * <br>
 * TLS options
 * <ul>
 * <li> tls_verify: <i>enum, accepted values: on, unsafe_off</i> - When the wss protocol is selected, TLS encryption is used. <br>
 * By default, the Sender will verify the server's certificate.
 * Note: the Bun runtime does not currently support custom CA certificates or disabling certificate
 * verification for the client WebSocket API. These options are accepted for configuration compatibility
 * but are not applied by the transport.
 * </li>
 * <li> tls_ca: <i>string</i> - Path to a file containing the root CA's certificate in PEM format. <br>
 * Accepted for configuration compatibility; not applied by the Bun WebSocket transport.
 * </li>
 * </ul>
 * <br>
 * Auto flush options
 * <ul>
 * <li> auto_flush: <i>enum, accepted values: on, off</i> - The Sender automatically flushes the buffer by default. This can be switched off
 * by setting this option to <i>off</i>. <br>
 * When disabled, the flush() method of the Sender has to be called explicitly to make sure data is sent to the server. <br>
 * Manual buffer flushing can be useful, especially when we want to control transaction boundaries. <br>
 * Each flush results in a single QWP message, which becomes a single transaction on the server side. <br>
 * The transaction either succeeds, and all rows sent in the request are inserted; or it fails, and none of the rows make it into the database.
 * </li>
 * <li> auto_flush_rows: <i>integer</i> - The number of rows that will trigger a flush. When set to 0, row-based flushing is disabled. <br>
 * The Sender will default this parameter to 1000 rows.
 * </li>
 * <li> auto_flush_interval: <i>integer</i> - The number of milliseconds that will trigger a flush, default value is 1000.
 * When set to 0, interval-based flushing is disabled. <br>
 * Note that the setting is checked only when a new row is added to the buffer. There is no timer registered to flush the buffer automatically.
 * </li>
 * </ul>
 * <br>
 * Buffer sizing options
 * <ul>
 * <li> init_buf_size: <i>integer</i> - Initial buffer size, defaults to 64 KiB in the Sender.
 * </li>
 * <li> max_buf_size: <i>integer</i> - Maximum buffer size, defaults to 100 MiB in the Sender. <br>
 * If the buffer would need to be extended beyond the maximum size, an error is thrown.
 * </li>
 * </ul>
 * <br>
 * Request specific options
 * <ul>
 * <li> request_timeout: <i>integer</i> - The time in milliseconds to wait for the WebSocket connection and for
 * each server acknowledgement, set to 10 seconds by default.
 * </li>
 * <li> request_min_throughput: <i>integer</i> - Accepted for configuration compatibility; not used by the WebSocket transport.
 * </li>
 * <li> retry_timeout: <i>integer</i> - Accepted for configuration compatibility; the WebSocket transport does not retry.
 * </li>
 * </ul>
 * <br>
 * Other options
 * <ul>
 * <li> max_name_len: <i>integer</i> - The maximum length of a table or column name, the Sender defaults this parameter to 127. <br>
 * Recommended to use the same setting as the server, which also uses 127 by default.
 * </li>
 * </ul>
 */
class SenderOptions {
  protocol!: string;
  protocol_version?: string;

  addr?: string;
  host?: string; // derived from addr
  port?: number; // derived from addr

  username?: string;
  password?: string;
  token?: string;
  token_x?: string; // allowed, but ignored
  token_y?: string; // allowed, but ignored

  auto_flush?: boolean;
  auto_flush_rows?: number;
  auto_flush_interval?: number;

  request_min_throughput?: number;
  request_timeout?: number;
  retry_timeout?: number;

  init_buf_size?: number | null;
  max_buf_size?: number | null;

  tls_verify?: boolean;
  tls_ca?: string;
  tls_roots?: never; // not supported
  tls_roots_password?: never; // not supported

  max_name_len?: number;

  log?: Logger;

  stdlib_http?: boolean;

  /**
   * Creates a Sender options object by parsing the provided configuration string.
   *
   * @param {string} configurationString - Configuration string. <br>
   * @param {object} extraOptions - Optional extra configuration. <br>
   * - 'log' is a logging function used by the {@link Sender}.
   * Prototype: <i>(level: 'error'|'warn'|'info'|'debug', message: string) => void</i>. <br>
   */
  constructor(configurationString: string, extraOptions?: ExtraOptions) {
    parseConfigurationString(this, configurationString);

    if (extraOptions) {
      if (extraOptions.log && typeof extraOptions.log !== "function") {
        throw new Error("Invalid logging function");
      }
      this.log = extraOptions.log;
    }
  }

  /**
   * Resolves the protocol version, if it is set to 'auto'. <br>
   * QWP currently supports a single protocol version, so this always resolves to '1'
   * without contacting the server.
   * @param {SenderOptions} options SenderOptions instance needing resolving protocol version
   */
  static async resolveAuto(options: SenderOptions) {
    parseProtocolVersion(options);
    return options;
  }

  static resolveDeprecated(
    options: SenderOptions & DeprecatedOptions,
    log: Logger,
  ) {
    if (!options) {
      return;
    }

    // deal with deprecated options
    if (options.copy_buffer !== undefined) {
      log(
        "warn",
        `Option 'copy_buffer' is not supported anymore, please, remove it`,
      );
      options.copy_buffer = undefined;
    }
    if (options.copyBuffer !== undefined) {
      log(
        "warn",
        `Option 'copyBuffer' is not supported anymore, please, remove it`,
      );
      options.copyBuffer = undefined;
    }
    if (options.bufferSize !== undefined) {
      log(
        "warn",
        `Option 'bufferSize' is not supported anymore, please, replace it with 'init_buf_size'`,
      );
      options.init_buf_size = options.bufferSize;
      options.bufferSize = undefined;
    }
  }

  /**
   * Creates a Sender options object by parsing the provided configuration string.
   *
   * @param {string} configurationString - Configuration string. <br>
   * @param {object} extraOptions - Optional extra configuration. <br>
   *
   * @return {SenderOptions} A Sender configuration object initialized from the provided configuration string.
   */
  static async fromConfig(
    configurationString: string,
    extraOptions?: ExtraOptions,
  ): Promise<SenderOptions> {
    const options = new SenderOptions(configurationString, extraOptions);
    await SenderOptions.resolveAuto(options);
    return options;
  }

  /**
   * Creates a Sender options object by parsing the configuration string set in the <b>QDB_CLIENT_CONF</b> environment variable.
   *
   * @param {object} extraOptions - Optional extra configuration. <br>
   *
   * @return {SenderOptions} A Sender configuration object initialized from the <b>QDB_CLIENT_CONF</b> environment variable.
   */
  static async fromEnv(extraOptions?: ExtraOptions): Promise<SenderOptions> {
    return await SenderOptions.fromConfig(
      process.env.QDB_CLIENT_CONF as string,
      extraOptions,
    );
  }
}

function parseConfigurationString(
  options: SenderOptions,
  configString: string,
) {
  if (!configString) {
    throw new Error("Configuration string is missing or empty");
  }

  const position = parseProtocol(options, configString);
  parseSettings(options, configString, position);
  parseProtocolVersion(options);
  parseAddress(options);
  parseBufferSizes(options);
  parseAutoFlushOptions(options);
  parseTlsOptions(options);
  parseRequestTimeoutOptions(options);
  parseMaxNameLength(options);
  parseStdlibTransport(options);
}

function parseSettings(
  options: SenderOptions,
  configString: string,
  position: number,
) {
  let index = configString.indexOf(";", position);
  while (index > -1) {
    if (
      index + 1 < configString.length &&
      configString.charAt(index + 1) === ";"
    ) {
      index = configString.indexOf(";", index + 2);
      continue;
    }

    parseSetting(options, configString, position, index);

    position = index + 1;
    index = configString.indexOf(";", position);
  }
  if (position < configString.length) {
    parseSetting(options, configString, position, configString.length);
  }
}

function parseSetting(
  options: SenderOptions,
  configString: string,
  position: number,
  index: number,
) {
  const setting = configString.slice(position, index).replaceAll(";;", ";");
  const equalsIndex = setting.indexOf("=");
  if (equalsIndex < 0) {
    throw new Error(`Missing '=' sign in '${setting}'`);
  }
  const key = setting.slice(0, equalsIndex);
  const value = setting.slice(equalsIndex + 1);
  validateConfigKey(key);
  validateConfigValue(key, value);
  (options as unknown as Record<string, string>)[key] = value;
}

const ValidConfigKeys = [
  "protocol_version",
  "addr",
  "username",
  "password",
  "token",
  "token_x",
  "token_y",
  "auto_flush",
  "auto_flush_rows",
  "auto_flush_interval",
  "request_min_throughput",
  "request_timeout",
  "retry_timeout",
  "init_buf_size",
  "max_buf_size",
  "max_name_len",
  "stdlib_http",
  "tls_verify",
  "tls_ca",
  "tls_roots",
  "tls_roots_password",
];

function validateConfigKey(key: string) {
  if (!ValidConfigKeys.includes(key)) {
    throw new Error(`Unknown configuration key: '${key}'`);
  }
}

function validateConfigValue(key: string, value: string) {
  if (!value) {
    throw new Error(`Invalid configuration, value is not set for '${key}'`);
  }
  for (let i = 0; i < value.length; i++) {
    const unicode = value.codePointAt(i) ?? 0;
    if (unicode < 0x20 || (unicode > 0x7e && unicode < 0xa0)) {
      throw new Error(
        `Invalid configuration, control characters are not allowed: '${value}'`,
      );
    }
  }
}

function parseProtocol(options: SenderOptions, configString: string) {
  const index = configString.indexOf("::");
  if (index < 0) {
    throw new Error(
      "Missing protocol, configuration string format: 'protocol::key1=value1;key2=value2;key3=value3;'",
    );
  }

  options.protocol = configString.slice(0, index) as string;
  switch (options.protocol) {
    case WS:
    case WSS:
      break;
    default:
      throw new Error(
        `Invalid protocol: '${options.protocol}', accepted protocols: 'ws', 'wss'`,
      );
  }
  return index + 2;
}

function parseProtocolVersion(options: SenderOptions) {
  const protocol_version = options.protocol_version ?? PROTOCOL_VERSION_AUTO;
  switch (protocol_version) {
    case PROTOCOL_VERSION_AUTO:
      options.protocol_version = PROTOCOL_VERSION_V1;
      break;
    case PROTOCOL_VERSION_V1:
      break;
    default:
      throw new Error(
        `Invalid protocol version: '${protocol_version}', accepted values: 'auto', '1'`,
      );
  }
  return;
}

function parseAddress(options: SenderOptions) {
  if (!options.addr) {
    throw new Error("Invalid configuration, 'addr' is required");
  }

  const index = options.addr.indexOf(":");
  if (index < 0) {
    options.host = options.addr;
    switch (options.protocol) {
      case WS:
      case WSS:
        options.port = WS_PORT;
        return;
      default:
        throw new Error(
          `Invalid protocol: '${options.protocol}', accepted protocols: 'ws', 'wss'`,
        );
    }
  }

  options.host = options.addr.slice(0, index);
  if (!options.host) {
    throw new Error(`Host name is required`);
  }

  const portStr = options.addr.slice(index + 1);
  if (!portStr) {
    throw new Error(`Port is required`);
  }
  options.port = Number(portStr);
  if (isNaN(options.port)) {
    throw new Error(`Invalid port: '${portStr}'`);
  }
  if (!Number.isInteger(options.port) || options.port < 1) {
    throw new Error(`Invalid port: ${options.port}`);
  }
}

function parseBufferSizes(options: SenderOptions) {
  parseInteger(options, "init_buf_size", "initial buffer size", 1);
  parseInteger(options, "max_buf_size", "max buffer size", 1);
}

function parseAutoFlushOptions(options: SenderOptions) {
  parseBoolean(options, "auto_flush", "auto flush");
  parseInteger(options, "auto_flush_rows", "auto flush rows", 0);
  parseInteger(options, "auto_flush_interval", "auto flush interval", 0);
}

function parseTlsOptions(options: SenderOptions) {
  parseBoolean(options, "tls_verify", "TLS verify", UNSAFE_OFF);

  if (options.tls_roots || options.tls_roots_password) {
    throw new Error(
      `'tls_roots' and 'tls_roots_password' options are not supported, please, use the 'tls_ca' option or the NODE_EXTRA_CA_CERTS environment variable instead`,
    );
  }
}

function parseRequestTimeoutOptions(options: SenderOptions) {
  parseInteger(options, "request_min_throughput", "request min throughput", 1);
  parseInteger(options, "request_timeout", "request timeout", 1);
  parseInteger(options, "retry_timeout", "retry timeout", 0);
}

function parseMaxNameLength(options: SenderOptions) {
  parseInteger(options, "max_name_len", "max name length", 1);
}

function parseStdlibTransport(options: SenderOptions) {
  parseBoolean(options, "stdlib_http", "stdlib http");
}

function parseBoolean(
  options: SenderOptions,
  property: string,
  description: string,
  offValue = OFF,
) {
  const record = options as unknown as Record<string, unknown>;
  if (record[property] !== undefined && record[property] !== null) {
    const property_str = record[property] as string;
    switch (property_str) {
      case ON:
        record[property] = true;
        break;
      case offValue:
        record[property] = false;
        break;
      default:
        throw new Error(`Invalid ${description} option: '${property_str}'`);
    }
  }
}

function parseInteger(
  options: SenderOptions,
  property: string,
  description: string,
  lowerBound: number,
) {
  const record = options as unknown as Record<string, unknown>;
  if (record[property] !== undefined && record[property] !== null) {
    const property_str = record[property] as string;
    record[property] = Number(property_str);
    if (isNaN(record[property] as number)) {
      throw new Error(
        `Invalid ${description} option, not a number: '${property_str}'`,
      );
    }
    if (
      !Number.isInteger(record[property]) ||
      (record[property] as number) < lowerBound
    ) {
      throw new Error(`Invalid ${description} option: ${record[property]}`);
    }
  }
}

export { SenderOptions, WS, WSS, PROTOCOL_VERSION_AUTO, PROTOCOL_VERSION_V1 };
export type { ExtraOptions };
