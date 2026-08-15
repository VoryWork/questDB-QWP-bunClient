// @ts-check
import type { Server } from "bun";
import {
  FLAG_DELTA_SYMBOL_DICT,
  TYPE_BINARY,
  TYPE_BOOLEAN,
  TYPE_BYTE,
  TYPE_CHAR,
  TYPE_DATE,
  TYPE_DECIMAL128,
  TYPE_DECIMAL256,
  TYPE_DECIMAL64,
  TYPE_DOUBLE,
  TYPE_DOUBLE_ARRAY,
  TYPE_FLOAT,
  TYPE_INT,
  TYPE_IPV4,
  TYPE_LONG,
  TYPE_LONG256,
  TYPE_LONG_ARRAY,
  TYPE_SHORT,
  TYPE_SYMBOL,
  TYPE_TIMESTAMP,
  TYPE_TIMESTAMP_NANOS,
  TYPE_UUID,
  TYPE_VARCHAR,
} from "../../src/qwp/constants";
import { ByteReader } from "../../src/qwp/varint";

/**
 * How a table in a received frame should be acknowledged.
 * - "advance": report an incremented seqTxn (default).
 * - "hold": report the current seqTxn without advancing it (the second
 *   swallowed frame of a stale table).
 * - "drop": omit the table from the ack (the first swallowed frame).
 * - { mode, name }: ack under a different (e.g. differently-cased) name.
 */
export type TableAckAction =
  | "advance"
  | "hold"
  | "drop"
  | { mode: "advance" | "hold"; name: string };

/** Per-frame ack script, keyed by lower-cased table name. */
export type AckScript = Record<string, TableAckAction>;

/**
 * A mock QWP WebSocket server built on Bun.serve.
 *
 * Captures the upgrade request headers and every binary frame sent by the
 * client, and can be configured to ack, reject, or ignore frames.
 */
export class MockQwpServer {
  server: Server<undefined> | null = null;
  upgradeHeaders: Headers | null = null;
  frames: Uint8Array[] = [];
  /** When true (default), every received frame is acknowledged with OK. */
  autoAck = true;
  /** When set, each received frame is answered with this status + message. */
  errorStatus: { status: number; message: string } | null = null;
  /** When true, received frames are not answered at all. */
  silent = false;
  /**
   * Scripted per-frame acknowledgement behavior. Entry i applies to the
   * i-th received frame; tables not mentioned advance normally. Once the
   * script is exhausted, every table advances normally.
   */
  script: AckScript[] = [];
  /** Per-table transaction counters, starting at 1 on the first advance. */
  private tableSeqTxn = new Map<string, number>();
  onFrame?: (frame: Uint8Array) => void;

  async start(port = 0): Promise<number> {
    this.server = Bun.serve({
      port,
      websocket: {
        open: () => {},
        message: (ws, data) => {
          const bytes =
            data instanceof Uint8Array
              ? data
              : new Uint8Array(data as unknown as ArrayBuffer);
          this.frames.push(bytes);
          if (this.onFrame) {
            this.onFrame(bytes);
          }
          if (this.silent) {
            return;
          }
          if (this.errorStatus) {
            ws.send(encodeErrorFrame(this.errorStatus.status, this.errorStatus.message));
            return;
          }
          if (this.autoAck) {
            const frameIndex = this.frames.length - 1;
            const scripted = this.script[frameIndex];
            const ackTables = parseFrameTableNames(bytes)
              .map((name) => {
                const key = name.toLowerCase();
                const action = scripted?.[key] ?? "advance";
                if (action === "drop") {
                  return null;
                }
                const current = this.tableSeqTxn.get(key) ?? 0;
                if (action === "hold") {
                  return { name, seqTxn: BigInt(current) };
                }
                const next = current + 1;
                this.tableSeqTxn.set(key, next);
                const ackName =
                  typeof action === "object" ? action.name : name;
                return { name: ackName, seqTxn: BigInt(next) };
              })
              .filter(
                (t): t is { name: string; seqTxn: bigint } => t !== null,
              );
            ws.send(encodeOkFrame(BigInt(frameIndex), ackTables));
          }
        },
        close: () => {},
      },
      fetch: (req, server2) => {
        this.upgradeHeaders = req.headers;
        if (server2.upgrade(req)) {
          return undefined;
        }
        return new Response("upgrade failed", { status: 400 });
      },
    });
    return this.server!.port as number;
  }

  async stop(): Promise<void> {
    this.server?.stop();
    this.server = null;
  }

  /** Resets captured state. */
  reset(): void {
    this.frames = [];
    this.upgradeHeaders = null;
    this.tableSeqTxn.clear();
  }
}

/**
 * Builds a QWP OK response frame.
 * [status:1][sequence:u64][tableCount:u16][(nameLen:u16 + name + seqTxn:u64)...]
 */
export function encodeOkFrame(
  sequence: bigint,
  tables: { name: string; seqTxn: bigint }[] = [],
): Uint8Array {
  const encoder = new TextEncoder();
  let size = 11;
  for (const table of tables) {
    size += 2 + encoder.encode(table.name).length + 8;
  }
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, 0x00);
  view.setBigUint64(1, sequence, true);
  view.setUint16(9, tables.length, true);
  let offset = 11;
  for (const table of tables) {
    const name = encoder.encode(table.name);
    view.setUint16(offset, name.length, true);
    bytes.set(name, offset + 2);
    view.setBigUint64(offset + 2 + name.length, table.seqTxn, true);
    offset += 2 + name.length + 8;
  }
  return bytes;
}

/**
 * Builds a QWP error response frame.
 * [status:1][sequence:u64][msgLen:u16][msg]
 */
export function encodeErrorFrame(status: number, message: string): Uint8Array {
  const msg = new TextEncoder().encode(message);
  const bytes = new Uint8Array(11 + msg.length);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, status);
  view.setBigUint64(1, 0n, true);
  view.setUint16(9, msg.length, true);
  bytes.set(msg, 11);
  return bytes;
}

/**
 * Extracts the table names from a QWP v1 message frame.
 *
 * Layout: 12-byte header, optional delta symbol dictionary, then per table:
 * varint name length + name, varint rowCount, varint columnCount, and for
 * each column: varint name length + name + 1 type byte, followed by that
 * table's column data block. Column values are skipped, only names are read.
 */
export function parseFrameTableNames(frame: Uint8Array): string[] {
  const reader = new ByteReader(frame);
  reader.skip(4); // magic "QWP1"
  reader.readByte(); // version
  const flags = reader.readByte();
  const tableCount = reader.readUint16LE();
  reader.readUint32LE(); // payload length, not needed

  if ((flags & FLAG_DELTA_SYMBOL_DICT) !== 0) {
    reader.readVarint(); // deltaStart
    const deltaCount = reader.readVarint();
    for (let i = 0; i < deltaCount; i++) {
      reader.readString();
    }
  }

  const names: string[] = [];
  for (let i = 0; i < tableCount; i++) {
    names.push(reader.readString());
    const rowCount = reader.readVarint();
    const columnCount = reader.readVarint();
    const columnTypes: number[] = [];
    for (let j = 0; j < columnCount; j++) {
      reader.readString(); // column name
      columnTypes.push(reader.readByte());
    }
    // The column data block follows immediately after each table's metadata.
    for (const type of columnTypes) {
      skipColumnData(reader, rowCount, type);
    }
  }
  return names;
}

/**
 * Skips the encoded data block of one column. The encoder writes a null flag
 * (and optional null bitmap), then the values of the non-null rows.
 */
function skipColumnData(
  reader: ByteReader,
  rowCount: number,
  type: number,
): void {
  const nullFlag = reader.readByte();
  let nonNull = rowCount;
  if (nullFlag !== 0) {
    const bitmapLength = Math.ceil(rowCount / 8);
    const bitmap: number[] = [];
    for (let i = 0; i < bitmapLength; i++) {
      bitmap.push(reader.readByte());
    }
    let count = 0;
    for (let i = 0; i < rowCount; i++) {
      if (((bitmap[i >> 3]! >> (i & 7)) & 1) === 0) {
        count++;
      }
    }
    nonNull = count;
  }

  switch (type) {
    case TYPE_BOOLEAN:
      // bit-packed, LSB first, only non-null values
      reader.skip(Math.ceil(nonNull / 8));
      break;
    case TYPE_BYTE:
      reader.skip(nonNull);
      break;
    case TYPE_SHORT:
    case TYPE_CHAR:
      reader.skip(nonNull * 2);
      break;
    case TYPE_INT:
    case TYPE_FLOAT:
    case TYPE_IPV4:
      reader.skip(nonNull * 4);
      break;
    case TYPE_LONG:
    case TYPE_DOUBLE:
    case TYPE_TIMESTAMP:
    case TYPE_TIMESTAMP_NANOS:
    case TYPE_DATE:
    case TYPE_DECIMAL64:
      reader.skip(nonNull * 8);
      break;
    case TYPE_UUID:
    case TYPE_DECIMAL128:
      reader.skip(nonNull * 16);
      break;
    case TYPE_LONG256:
    case TYPE_DECIMAL256:
      reader.skip(nonNull * 32);
      break;
    case TYPE_SYMBOL:
      for (let i = 0; i < nonNull; i++) {
        reader.readVarint();
      }
      break;
    case TYPE_VARCHAR:
    case TYPE_BINARY: {
      // offset array with (valueCount + 1) entries, then concatenated data
      let dataLength = 0;
      for (let i = 0; i <= nonNull; i++) {
        dataLength = reader.readUint32LE();
      }
      reader.skip(dataLength);
      break;
    }
    case TYPE_DOUBLE_ARRAY:
    case TYPE_LONG_ARRAY:
      for (let i = 0; i < nonNull; i++) {
        const dimensions = reader.readByte();
        let elementCount = 1;
        for (let d = 0; d < dimensions; d++) {
          elementCount *= reader.readUint32LE();
        }
        reader.skip(elementCount * 8);
      }
      break;
    default:
      throw new Error(`Unsupported column type while parsing frame: ${type}`);
  }
}
