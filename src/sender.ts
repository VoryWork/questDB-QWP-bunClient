// @ts-check
import { log } from "./logging";
import type { Logger } from "./logging";
import { SenderOptions } from "./options";
import type { ExtraOptions } from "./options";
import { QwpEncoder } from "./qwp/encoder";
import { QwpTransport } from "./qwp/transport";
import { QwpError, toQwpError } from "./qwp/errors";
import { QwpTableBuffer } from "./qwp/tablebuffer";
import type { QwpValue } from "./qwp/tablebuffer";
import type { QwpResponse } from "./qwp/decoder";
import { GlobalSymbolDictionary } from "./qwp/symboldict";
import {
  TYPE_BOOLEAN,
  TYPE_DECIMAL128,
  TYPE_DECIMAL256,
  TYPE_DECIMAL64,
  TYPE_DOUBLE,
  TYPE_DOUBLE_ARRAY,
  TYPE_LONG,
  TYPE_SYMBOL,
  TYPE_TIMESTAMP,
  TYPE_TIMESTAMP_NANOS,
  TYPE_VARCHAR,
} from "./qwp/constants";
import {
  bigintToTwosComplementBytes,
  getDimensions,
  isBoolean,
  isInteger,
  validateArray,
} from "./utils";
import type { TimestampUnit } from "./utils";
import {
  validateColumnName,
  validateDecimalText,
  validateTableName,
} from "./validation";

const DEFAULT_AUTO_FLUSH_INTERVAL = 1000; // 1 sec
const DEFAULT_BUFFER_SIZE = 65536; // 64 KiB
const DEFAULT_MAX_BUFFER_SIZE = 104857600; // 100 MiB
const MAX_STALE_TABLE_RETRIES = 3; // measured worst case needs 2 retries
const DEFAULT_REPLAY_BACKOFF_MS = 100;
const MIN_REPLAY_BUDGET_MS = 1;

/**
 * The QuestDB client's API provides methods to connect to the database, ingest data, and close the connection.
 * <p>
 * The client uses the QuestDB Wire Protocol (QWP) over a WebSocket connection.
 * <ul>
 * <li><b>ws</b>: Plain WebSocket connection to the QuestDB wire protocol endpoint (/write/v4).</li>
 * <li><b>wss</b>: TLS-secured WebSocket connection.</li>
 * </ul>
 * <p>
 * The client supports Basic username/password and Bearer token authentication,
 * passed in the <i>Authorization</i> header during the WebSocket upgrade handshake.
 * Note that authentication is enabled by default in QuestDB Enterprise only.
 * </p>
 * <p>
 * The client buffers rows in a columnar format and sends them to the server as binary
 * QWP messages. Auto-flushing can be controlled via the configuration options.
 * </p>
 * <p>
 * It is recommended that the Sender is created by using one of the static factory methods,
 * <i>Sender.fromConfig(configString, extraOptions)</i> or <i>Sender.fromEnv(extraOptions)</i>.
 * </p>
 * <p>
 * <b>Configuration Examples:</b>
 * <ul>
 * <li>ws::addr=localhost:9000</li>
 * <li>wss::addr=localhost:9000;username=admin;password=secret</li>
 * <li>ws::addr=localhost:9000;auto_flush=off;auto_flush_rows=1000</li>
 * </ul>
 * </p>
 * <p>
 * Extra options can be provided to the Sender in the <i>extraOptions</i> configuration object.
 * A custom logging function can be passed in this object.
 * </p>
 */
class Sender {
  private transport: QwpTransport;
  private readonly options: SenderOptions;
  private readonly encoder: QwpEncoder;
  private readonly symbolDict = new GlobalSymbolDictionary();
  private readonly tables = new Map<string, QwpTableBuffer>();
  /**
   * Per-table acknowledged transaction sequence numbers, keyed by lower-case
   * table name (QuestDB identifiers are case-insensitive).
   */
  private readonly acknowledgedSeqTxns = new Map<string, bigint>();
  /**
   * Tables whose writes were silently dropped after a server-side DROP and
   * recreate and whose retry budget was exhausted. Their data is re-sent
   * first on the next flush, so nothing is ever lost.
   */
  private readonly staleRetryQueue = new Map<string, QwpTableBuffer>();
  /**
   * The last frame whose delivery could not be determined (ack timeout or
   * connection loss). It is retained and replayed byte-for-byte before newer
   * rows, so a timed-out write is never silently discarded.
   */
  private pendingWrite: { frame: Uint8Array } | null = null;
  private currentTable: QwpTableBuffer | null = null;

  private readonly autoFlush: boolean;
  private readonly autoFlushRows: number;
  private readonly autoFlushInterval: number;
  private readonly staleRetries: number;
  private readonly resendOnUnknown: boolean;
  private readonly replayBackoffMs: number;
  private lastFlushTime = 0;
  private pendingRowCount = 0;
  /** Tail of the serialized flush queue; resolves when all queued flushes complete. */
  private flushTail: Promise<void> = Promise.resolve();
  private readonly maxNameLength: number;
  private readonly log: Logger;
  private closed = false;

  /**
   * Creates a new Sender. <br>
   * It is recommended to use the static factory methods <i>Sender.fromConfig()</i>
   * or <i>Sender.fromEnv()</i> instead, as they validate the configuration string.
   * @param options - Sender configuration options.
   */
  constructor(options: SenderOptions) {
    if (!options) {
      throw new Error("The 'protocol' option is mandatory");
    }
    SenderOptions.resolveDeprecated(options, log);

    if (!options.protocol) {
      throw new Error("The 'protocol' option is mandatory");
    }
    if (!options.host) {
      throw new Error("The 'host' option is mandatory");
    }

    const maxBufSize = isInteger(options.max_buf_size, 1)
      ? options.max_buf_size
      : DEFAULT_MAX_BUFFER_SIZE;
    const initBufSize = isInteger(options.init_buf_size, 1)
      ? options.init_buf_size
      : DEFAULT_BUFFER_SIZE;
    if (maxBufSize < initBufSize) {
      throw new Error(
        `Max buffer size is ${maxBufSize} bytes, requested buffer size: ${initBufSize}`,
      );
    }

    this.log = typeof options.log === "function" ? options.log : log;
    this.options = options;
    this.transport = new QwpTransport(options, this.log);
    this.encoder = new QwpEncoder(this.symbolDict);
    this.maxNameLength = isInteger(options.max_name_len, 1)
      ? options.max_name_len
      : 127;

    // auto-flush configuration with the same defaults as the Node.js client.
    this.autoFlush = isBoolean(options.auto_flush)
      ? options.auto_flush
      : true;
    this.autoFlushRows = isInteger(options.auto_flush_rows, 0)
      ? options.auto_flush_rows
      : this.transport.getDefaultAutoFlushRows();
    this.autoFlushInterval = isInteger(options.auto_flush_interval, 0)
      ? options.auto_flush_interval
      : DEFAULT_AUTO_FLUSH_INTERVAL;
    this.staleRetries = isInteger(options.stale_retries, 1)
      ? options.stale_retries
      : MAX_STALE_TABLE_RETRIES;
    this.resendOnUnknown = isBoolean(options.resend_on_unknown)
      ? options.resend_on_unknown
      : false;
    this.replayBackoffMs = isInteger(options.replay_backoff_ms, 0)
      ? options.replay_backoff_ms
      : DEFAULT_REPLAY_BACKOFF_MS;

    this.reset();
  }

  /**
   * Creates a Sender from a configuration string.
   * @param configurationString - Configuration string, e.g. "ws::addr=localhost:9000;".
   * @param extraOptions - Optional extra configuration.
   */
  static async fromConfig(
    configurationString: string,
    extraOptions?: ExtraOptions,
  ): Promise<Sender> {
    const options = await SenderOptions.fromConfig(
      configurationString,
      extraOptions,
    );
    return new Sender(options);
  }

  /**
   * Creates a Sender from the configuration string set in the
   * <b>QDB_CLIENT_CONF</b> environment variable.
   */
  static async fromEnv(extraOptions?: ExtraOptions): Promise<Sender> {
    const options = await SenderOptions.fromEnv(extraOptions);
    return new Sender(options);
  }

  /**
   * Resets the internal buffer and auto-flush state.
   * @returns this Sender for chaining
   */
  reset(): Sender {
    for (const table of this.tables.values()) {
      table.clear();
    }
    this.tables.clear();
    this.currentTable = null;
    this.resetAutoFlush();
    return this;
  }

  /**
   * Establishes the WebSocket connection to the database server.
   * @returns Promise resolving to true if the connection was established
   */
  async connect(): Promise<boolean> {
    this.ensureOpen();
    return this.transport.connect();
  }

  /**
   * Flushes all buffered rows by sending them to the server in a single QWP
   * message, waiting for the server's acknowledgement.
   *
   * Flushes are serialized: a flush that arrives while another one is in
   * flight waits for it to finish, so rows buffered by an in-flight flush
   * are never collected twice.
   *
   * When delivery cannot be determined (ack timeout or connection loss), the
   * frame is retained and re-thrown as a {@link QwpError} with
   * `delivery === "unknown"`. With `resend_on_unknown=on`, the same frame is
   * replayed once on a fresh connection before giving up.
   *
   * @param deadlineMs optional total budget for this flush, including replay
   *        and stale-table attempts
   * @returns Promise resolving to true if data was sent, false if the buffer was empty
   */
  async flush(deadlineMs?: number): Promise<boolean> {
    this.ensureOpen();
    this.ensureNoInProgressRow();

    return this.withFlushLock(async () => {
      const deadlineAt = deadlineFrom(deadlineMs);
      let sent = false;

      // Tables that exhausted their retry budget on a previous flush are
      // re-sent first, so they are never overwritten by a table recreation
      // and never lost while new rows keep arriving.
      if (this.staleRetryQueue.size > 0) {
        const queued = [...this.staleRetryQueue];
        this.staleRetryQueue.clear();
        for (let i = 0; i < queued.length; i++) {
          const [tableName, buffer] = queued[i]!;
          try {
            await this.resendStaleTable(tableName, buffer, deadlineAt);
          } catch (error) {
            for (let j = i; j < queued.length; j++) {
              const [name, pending] = queued[j]!;
              this.staleRetryQueue.set(name, pending);
            }
            throw error;
          }
          sent = true;
        }
      }

      // A retained unacknowledged frame is replayed byte-for-byte before any
      // newer rows, so a timed-out write is neither dropped nor reordered.
      if (this.pendingWrite) {
        this.ensureBudget(deadlineAt, "unknown");
        try {
          await this.sendFrame(this.pendingWrite.frame, deadlineAt);
        } catch (error) {
          if (!shouldRetain(error)) {
            this.pendingWrite = null;
          }
          throw error;
        }
        this.pendingWrite = null;
        sent = true;
      }

      // Collect the tables with committed rows and swap in a fresh buffer for
      // each of them. Rows written while the flush is in flight go to the new
      // buffers and are never cleared by this flush.
      const tablesToSend: QwpTableBuffer[] = [];
      for (const [name, table] of this.tables) {
        if (table.rowCount > 0) {
          tablesToSend.push(table);
          // Swap in a fresh buffer. The next table() call picks it up; rows
          // written while this flush is in flight go there instead of the
          // buffer being sent, so they are never cleared by this flush.
          this.tables.set(name, new QwpTableBuffer(name));
        }
      }
      if (tablesToSend.length === 0) {
        return sent;
      }

      const frame = this.encoder.encode(tablesToSend);
      this.log(
        "debug",
        `Flushing ${this.pendingRowCount} rows, frame size: ${frame.length} bytes`,
      );
      this.resetAutoFlush();

      let response: QwpResponse;
      try {
        response = await this.sendFrame(frame, deadlineAt);
      } catch (error) {
        if (shouldRetain(error)) {
          this.pendingWrite = { frame };
        }
        throw error;
      }
      await this.verifyAcks(tablesToSend, response, deadlineAt);
      return true;
    });
  }

  /** True when a frame from a previous flush is still awaiting a decision. */
  hasPendingWrite(): boolean {
    return this.pendingWrite !== null;
  }

  /**
   * Retries the retained unacknowledged frame, if any.
   * @returns true when a frame was retried, false when nothing was pending
   */
  async retryPending(deadlineMs?: number): Promise<boolean> {
    this.ensureOpen();
    return this.withFlushLock(async () => {
      if (!this.pendingWrite) {
        return false;
      }
      const deadlineAt = deadlineFrom(deadlineMs);
      this.ensureBudget(deadlineAt, "unknown");
      try {
        await this.sendFrame(this.pendingWrite.frame, deadlineAt);
      } catch (error) {
        if (!shouldRetain(error)) {
          this.pendingWrite = null;
        }
        throw error;
      }
      this.pendingWrite = null;
      return true;
    });
  }

  /**
   * Discards the retained unacknowledged frame.
   * @returns true when a frame was discarded, false when nothing was pending
   */
  async discardPending(): Promise<boolean> {
    return this.withFlushLock(async () => {
      const hadPending = this.pendingWrite !== null;
      this.pendingWrite = null;
      return hadPending;
    });
  }

  /**
   * Serializes a write operation behind any in-flight flush.
   */
  private async withFlushLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.flushTail;
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.flushTail = current;
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  /**
   * Sends a frame and, when the error permits it, replays the exact same
   * bytes once on a fresh connection.
   */
  private async sendFrame(
    frame: Uint8Array,
    deadlineAt: number,
  ): Promise<QwpResponse> {
    const timeoutMs = this.remainingBudget(deadlineAt);
    if (timeoutMs <= 0) {
      throw deadlineError(false);
    }

    try {
      return await this.transport.send(frame, timeoutMs);
    } catch (error) {
      const qwpError = toQwpError(error);
      if (!this.shouldReplay(qwpError, deadlineAt)) {
        throw qwpError;
      }

      await this.resetTransport();
      await this.backoff(deadlineAt);
      if (this.remainingBudget(deadlineAt) <= MIN_REPLAY_BUDGET_MS) {
        throw qwpError;
      }

      this.log(
        "warn",
        `Replaying unacknowledged frame after ${qwpError.code}: ${qwpError.message}`,
      );
      try {
        return await this.transport.send(
          frame,
          this.remainingBudget(deadlineAt),
        );
      } catch (replayError) {
        throw toQwpError(replayError);
      }
    }
  }

  private shouldReplay(error: QwpError, deadlineAt: number): boolean {
    if (!error.retryable) {
      return false;
    }
    // A re-send after an unknown outcome can duplicate rows unless the target
    // tables deduplicate on the timestamp, so it is opt-in.
    if (error.delivery === "unknown" && !this.resendOnUnknown) {
      return false;
    }
    return this.remainingBudget(deadlineAt) > MIN_REPLAY_BUDGET_MS;
  }

  private remainingBudget(deadlineAt: number): number {
    if (!Number.isFinite(deadlineAt)) {
      return Number.POSITIVE_INFINITY;
    }
    return deadlineAt - Date.now();
  }

  private ensureBudget(
    deadlineAt: number,
    delivery: "unknown" | "not_sent",
  ): void {
    if (this.remainingBudget(deadlineAt) <= 0) {
      throw deadlineError(delivery === "unknown");
    }
  }

  private async backoff(deadlineAt: number): Promise<void> {
    if (this.replayBackoffMs <= 0) {
      return;
    }
    const waitMs = Math.min(
      this.replayBackoffMs,
      Math.max(0, this.remainingBudget(deadlineAt)),
    );
    if (waitMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    }
  }

  /**
   * Drops the current connection and creates a fresh transport, so a replay
   * does not sit behind the same server-side ack queue that just timed out.
   */
  private async resetTransport(): Promise<void> {
    const failed = this.transport;
    this.transport = new QwpTransport(this.options, this.log);
    try {
      await failed.close();
    } catch {
      // the original write error is more useful
    }
  }

  /**
   * Closes the connection to the database server.
   * Buffered data that has not been flushed is discarded.
   * In-flight flushes are allowed to finish before the connection closes.
   */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    // Drain in-flight flushes so buffered rows are not lost mid-send.
    await this.flushTail;
    if (this.hasBufferedRows()) {
      this.log(
        "warn",
        "Buffer contains data which has not been flushed, this data will be lost",
      );
    }
    if (this.staleRetryQueue.size > 0) {
      this.log(
        "warn",
        "Retry queue contains data which has not been acknowledged, this data will be lost",
      );
    }
    if (this.pendingWrite) {
      this.log(
        "warn",
        "A pending unacknowledged frame is still retained, this data will be lost",
      );
    }
    await this.transport.close();
  }

  /**
   * Adds a table to the message.
   * @param table - Table name.
   * @returns this Sender for method chaining
   */
  table(table: string): Sender {
    this.ensureOpen();
    if (typeof table !== "string") {
      throw new Error("Table name must be a string");
    }
    validateTableName(table, this.maxNameLength);

    if (this.currentTable) {
      if (this.currentTable.hasInProgressRow() || this.currentTable.isEmpty()) {
        throw new Error("Table name has already been set");
      }
    }
    let tableBuffer = this.tables.get(table);
    if (!tableBuffer) {
      tableBuffer = new QwpTableBuffer(table);
      this.tables.set(table, tableBuffer);
    }
    this.currentTable = tableBuffer;
    return this;
  }

  /**
   * Adds a symbol to the message. <br>
   * Must be added before any columns of the same row.
   * @param name - Symbol name.
   * @param value - Symbol value, converted to a string.
   * @returns this Sender for method chaining
   */
  symbol(name: string, value: unknown): Sender {
    this.ensureOpen();
    this.ensureCurrentTable(name);
    if (this.currentTableHasNonSymbolValue()) {
      throw new Error(
        "Symbol can be added only after table name is set and before any column added",
      );
    }
    // Register the symbol in the global dictionary immediately, so the
    // message-level delta dictionary (encoded before the tables) is complete.
    const globalId = this.symbolDict.getOrAddSymbol(String(value));
    this.addValue(name, TYPE_SYMBOL, globalId);
    return this;
  }

  /**
   * Adds a string column to the message.
   * @param name - Column name.
   * @param value - Column value.
   * @returns this Sender for method chaining
   */
  stringColumn(name: string, value: string): Sender {
    this.ensureOpen();
    this.ensureCurrentTable(name);
    if (typeof value !== "string") {
      throw new Error("String column value must be a string");
    }
    this.addValue(name, TYPE_VARCHAR, value);
    return this;
  }

  /**
   * Adds a boolean column to the message.
   * @param name - Column name.
   * @param value - Column value.
   * @returns this Sender for method chaining
   */
  booleanColumn(name: string, value: boolean): Sender {
    this.ensureOpen();
    this.ensureCurrentTable(name);
    if (typeof value !== "boolean") {
      throw new Error("Boolean column value must be a boolean");
    }
    this.addValue(name, TYPE_BOOLEAN, value);
    return this;
  }

  /**
   * Adds a floating point (double) column to the message.
   * @param name - Column name.
   * @param value - Column value.
   * @returns this Sender for method chaining
   */
  floatColumn(name: string, value: number): Sender {
    this.ensureOpen();
    this.ensureCurrentTable(name);
    if (typeof value !== "number") {
      throw new Error("Float column value must be a number");
    }
    this.addValue(name, TYPE_DOUBLE, value);
    return this;
  }

  /**
   * Adds an integer (long) column to the message.
   * @param name - Column name.
   * @param value - Column value.
   * @returns this Sender for method chaining
   */
  intColumn(name: string, value: number): Sender {
    this.ensureOpen();
    this.ensureCurrentTable(name);
    if (!Number.isInteger(value)) {
      throw new Error("Value must be an integer");
    }
    this.addValue(name, TYPE_LONG, BigInt(value));
    return this;
  }

  /**
   * Adds a timestamp column to the message.
   * @param name - Column name.
   * @param value - Timestamp value since the Unix epoch.
   * @param unit - Timestamp unit, defaults to microseconds.
   * @returns this Sender for method chaining
   */
  timestampColumn(
    name: string,
    value: number | bigint,
    unit: TimestampUnit = "us",
  ): Sender {
    this.ensureOpen();
    this.ensureCurrentTable(name);
    const converted = timestampToQwpValue(value, unit);
    this.addValue(name, converted.type, converted.value);
    return this;
  }

  /**
   * Adds an array column to the message (only number arrays are supported).
   * @param name - Column name.
   * @param value - Column value, a (possibly multi-dimensional) number array.
   * @returns this Sender for method chaining
   */
  arrayColumn(name: string, value: unknown[]): Sender {
    this.ensureOpen();
    this.ensureCurrentTable(name);
    if (!Array.isArray(value)) {
      throw new Error(
        `The value must be an array [value=${JSON.stringify(value)}, type=${typeof value}]`,
      );
    }
    const dimensions = getDimensions(value);
    const elementType = validateArray(value, dimensions);
    if (elementType !== "number" && elementType !== null) {
      throw new Error(`Unsupported array type [type=${elementType}]`);
    }
    this.addValue(name, TYPE_DOUBLE_ARRAY, value);
    return this;
  }

  /**
   * Adds a decimal column to the message using its text representation.
   * @param name - Column name.
   * @param value - Decimal value, e.g. "1.234" or 42.5.
   * @returns this Sender for method chaining
   */
  decimalColumnText(name: string, value: string | number): Sender {
    this.ensureOpen();
    this.ensureCurrentTable(name);
    const text = typeof value === "number" ? String(value) : value;
    validateDecimalText(text);
    if (/^[+-]?(Infinity|NaN)$/.test(text)) {
      throw new Error(`Unsupported decimal value: ${text}`);
    }
    const { unscaled, scale } = parseDecimalText(text);
    return this.decimalColumn(name, unscaled, scale);
  }

  /**
   * Adds a decimal column to the message using the binary representation.
   * @param name - Column name.
   * @param unscaled - Unscaled value as a bigint or a big-endian two's complement Int8Array.
   * @param scale - Number of fractional digits, between 0 and 76.
   * @returns this Sender for method chaining
   */
  decimalColumn(
    name: string,
    unscaled: bigint | Int8Array,
    scale: number,
  ): Sender {
    this.ensureOpen();
    this.ensureCurrentTable(name);

    if (!Number.isInteger(scale) || scale < 0 || scale > 76) {
      throw new RangeError("Scale must be between 0 and 76");
    }

    let bytes: number[];
    if (typeof unscaled === "bigint") {
      bytes = bigintToTwosComplementBytes(unscaled);
    } else if (unscaled instanceof Int8Array) {
      bytes = Array.from(unscaled);
    } else {
      throw new TypeError(
        "Unscaled value must be a bigint or an Int8Array",
      );
    }
    if (bytes.length > 32) {
      throw new RangeError(
        "Unscaled value length must be between 0 and 32 bytes",
      );
    }

    let type: number;
    if (bytes.length <= 8) {
      type = TYPE_DECIMAL64;
    } else if (bytes.length <= 16) {
      type = TYPE_DECIMAL128;
    } else {
      type = TYPE_DECIMAL256;
    }

    const column = this.getOrCreateColumn(name, type);
    column.scale = scale;
    if (this.columnHasValue(column)) {
      throw new Error(`Column '${name}' has already been set for the current row`);
    }
    column.values.push(unscaled as bigint);
    return this;
  }

  /**
   * Closes the current row with an explicit timestamp.
   * @param timestamp - Timestamp value since the Unix epoch.
   * @param unit - Timestamp unit, defaults to microseconds.
   */
  async at(
    timestamp: number | bigint,
    unit: TimestampUnit = "us",
  ): Promise<void> {
    this.ensureOpen();
    this.ensureRowToClose();
    const converted = timestampToQwpValue(timestamp, unit);
    const table = this.currentTable!;
    const column = table.getOrCreateColumn("", converted.type);
    if (this.columnHasValue(column)) {
      throw new Error(
        "Designated timestamp has already been set for the current row",
      );
    }
    column.values.push(converted.value);
    this.commitCurrentRow();
    this.log("debug", `Row added, pending rows: ${this.pendingRowCount}`);
    await this.tryFlush();
  }

  /**
   * Closes the current row and lets the server assign the timestamp.
   */
  async atNow(): Promise<void> {
    this.ensureOpen();
    this.ensureRowToClose();
    this.commitCurrentRow();
    this.log("debug", `Row added, pending rows: ${this.pendingRowCount}`);
    await this.tryFlush();
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new Error("Sender is closed");
    }
  }

  private ensureCurrentTable(name: string): void {
    if (!this.currentTable) {
      throw new Error("Column can be set only after table name is set");
    }
    validateColumnName(name, this.maxNameLength);
  }

  private currentTableHasNonSymbolValue(): boolean {
    const table = this.currentTable;
    if (!table) {
      return false;
    }
    for (const column of table.columns) {
      if (
        column.type !== TYPE_SYMBOL &&
        column.values.length > table.rowCount
      ) {
        return true;
      }
    }
    return false;
  }

  private getOrCreateColumn(name: string, type: number) {
    return this.currentTable!.getOrCreateColumn(name, type);
  }

  private addValue(name: string, type: number, value: unknown): void {
    const column = this.getOrCreateColumn(name, type);
    if (this.columnHasValue(column)) {
      throw new Error(`Column '${name}' has already been set for the current row`);
    }
    column.values.push(value as QwpValue);
  }

  private columnHasValue(column: { values: unknown[] }): boolean {
    return (
      this.currentTable !== null &&
      column.values.length === this.currentTable.rowCount + 1
    );
  }

  private ensureRowToClose(): void {
    const table = this.currentTable;
    if (!table || !table.hasInProgressRow()) {
      throw new Error("The row must have a symbol or column set before it is closed");
    }
  }

  private commitCurrentRow(): void {
    this.currentTable!.commitRow();
    this.pendingRowCount++;
  }

  private hasBufferedRows(): boolean {
    for (const table of this.tables.values()) {
      if (!table.isEmpty()) {
        return true;
      }
    }
    return false;
  }

  private ensureNoInProgressRow(): void {
    for (const table of this.tables.values()) {
      if (table.hasInProgressRow()) {
        throw new Error(
          "Cannot flush, the current row is not closed, call 'at' or 'atNow' first",
        );
      }
    }
  }

  private resetAutoFlush(): void {
    this.lastFlushTime = Date.now();
    this.pendingRowCount = 0;
  }

  private async tryFlush(): Promise<void> {
    if (
      this.autoFlush &&
      this.pendingRowCount > 0 &&
      ((this.autoFlushRows > 0 && this.pendingRowCount >= this.autoFlushRows) ||
        (this.autoFlushInterval > 0 &&
          Date.now() - this.lastFlushTime >= this.autoFlushInterval))
    ) {
      await this.flush();
    }
  }

  /**
   * Verifies the per-table acknowledgements of a just-sent frame and re-sends
   * any table whose seqTxn did not advance. The server silently drops rows
   * for a while after a table is DROPped and recreated, without returning an
   * error; the missing or non-advancing seqTxn is the only signal.
   */
  private async verifyAcks(
    tables: QwpTableBuffer[],
    response: QwpResponse,
    deadlineAt: number,
  ): Promise<void> {
    for (let i = 0; i < tables.length; i++) {
      const table = tables[i]!;
      const key = table.tableName.toLowerCase();
      const known = this.acknowledgedSeqTxns.get(key) ?? 0n;
      const ack = response.tables.find(
        (t) => t.name.toLowerCase() === key,
      );
      if (ack && ack.seqTxn > known) {
        this.acknowledgedSeqTxns.set(key, ack.seqTxn);
        continue;
      }
      try {
        await this.resendStaleTable(key, table, deadlineAt);
      } catch (error) {
        // Keep the current and all not-yet-verified tables for the next flush.
        for (let j = i; j < tables.length; j++) {
          const pending = tables[j]!;
          this.staleRetryQueue.set(pending.tableName.toLowerCase(), pending);
        }
        throw error;
      }
    }
  }

  /**
   * Re-sends a single table as its own frame until the server ack advances
   * the table's seqTxn or the retry budget is exhausted. On exhaustion the
   * table's data is retained in the stale retry queue for the next flush and
   * a self-explanatory error is thrown.
   */
  private async resendStaleTable(
    key: string,
    table: QwpTableBuffer,
    deadlineAt: number,
  ): Promise<void> {
    const known = this.acknowledgedSeqTxns.get(key) ?? 0n;
    for (let attempt = 1; attempt <= this.staleRetries; attempt++) {
      if (this.remainingBudget(deadlineAt) <= 0) {
        this.staleRetryQueue.set(key, table);
        throw new QwpError(
          `Table '${table.tableName}' could not be retried before the write deadline; the data has been retained and will be retried on the next flush.`,
          {
            code: "WRITE_DEADLINE",
            delivery: "unknown",
            retryable: true,
            table: table.tableName,
          },
        );
      }
      this.log(
        "warn",
        `Table '${table.tableName}' was not acknowledged with an advancing seqTxn, retrying (${attempt}/${this.staleRetries})`,
      );
      const frame = this.encoder.encode([table]);
      let response: QwpResponse;
      try {
        response = await this.sendFrame(frame, deadlineAt);
      } catch (error) {
        this.staleRetryQueue.set(key, table);
        throw error;
      }
      const ack = response.tables.find(
        (t) => t.name.toLowerCase() === key,
      );
      if (ack && ack.seqTxn > known) {
        this.acknowledgedSeqTxns.set(key, ack.seqTxn);
        return;
      }
    }
    this.staleRetryQueue.set(key, table);
    throw new QwpError(
      `Table '${table.tableName}' was not acknowledged with an advancing seqTxn after ${this.staleRetries} retries; the table may have just been DROPped and recreated. The data has been retained and will be retried on the next flush.`,
      {
        code: "STALE_TABLE",
        delivery: "unknown",
        retryable: true,
        table: table.tableName,
      },
    );
  }
}

function deadlineFrom(deadlineMs: number | undefined): number {
  return deadlineMs !== undefined && deadlineMs > 0
    ? Date.now() + deadlineMs
    : Number.POSITIVE_INFINITY;
}

function deadlineError(wasSent: boolean): QwpError {
  return new QwpError("Write deadline exceeded before sending the frame", {
    code: "WRITE_DEADLINE",
    delivery: wasSent ? "unknown" : "not_sent",
    retryable: true,
  });
}

function shouldRetain(error: unknown): boolean {
  if (!(error instanceof QwpError)) {
    return true;
  }
  return error.delivery !== "rejected" || error.retryable;
}

/**
 * Converts a timestamp value in the given unit to the QWP wire representation.
 */
function timestampToQwpValue(
  timestamp: number | bigint,
  unit: TimestampUnit,
): { type: number; value: bigint } {
  if (typeof timestamp !== "number" && typeof timestamp !== "bigint") {
    throw new Error("Timestamp value must be a number or a BigInt");
  }
  switch (unit) {
    case "ns":
      if (typeof timestamp !== "bigint") {
        throw new Error(
          "Timestamp value must be a BigInt if it is set in nanoseconds",
        );
      }
      return { type: TYPE_TIMESTAMP_NANOS, value: timestamp };
    case "us":
      return { type: TYPE_TIMESTAMP, value: BigInt(timestamp) };
    case "ms":
      return { type: TYPE_TIMESTAMP, value: BigInt(timestamp) * 1000n };
    default:
      throw new Error(`Unknown timestamp unit: ${unit}`);
  }
}

/**
 * Parses a decimal text like "1.234" or "-42.5e2" into an unscaled bigint
 * and a scale.
 */
export function parseDecimalText(
  value: string,
): { unscaled: bigint; scale: number } {
  const match = value.match(
    /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/,
  );
  if (!match) {
    throw new Error(`Invalid decimal text: ${value}`);
  }
  const sign = match[1] === "-" ? -1n : 1n;
  const intPart = match[2] ?? "";
  const fracPart = match[3] ?? "";
  const exponent = match[4] ? Number(match[4]) : 0;

  const digits = (intPart + fracPart).replace(/^0+/, "");
  let unscaled = digits.length > 0 ? BigInt(digits) : 0n;
  unscaled *= sign;
  const scale = Math.max(0, fracPart.length - exponent);
  return { unscaled, scale };
}

export { Sender };
