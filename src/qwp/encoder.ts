import {
  FLAG_DELTA_SYMBOL_DICT,
  HEADER_SIZE,
  MAGIC_MESSAGE,
  TYPE_BINARY,
  TYPE_BOOLEAN,
  TYPE_BYTE,
  TYPE_CHAR,
  TYPE_DECIMAL128,
  TYPE_DECIMAL256,
  TYPE_DECIMAL64,
  TYPE_DOUBLE,
  TYPE_DOUBLE_ARRAY,
  TYPE_FLOAT,
  TYPE_GEOHASH,
  TYPE_INT,
  TYPE_LONG,
  TYPE_LONG_ARRAY,
  TYPE_SHORT,
  TYPE_SYMBOL,
  TYPE_TIMESTAMP,
  TYPE_TIMESTAMP_NANOS,
  TYPE_UUID,
  TYPE_VARCHAR,
  VERSION,
} from "./constants";
import { GlobalSymbolDictionary } from "./symboldict";
import type { QwpTableBuffer, QwpValue } from "./tablebuffer";
import { ByteWriter } from "./varint";

/**
 * Encodes the buffered tables of a sender into a single QWP v1 message,
 * mirroring `io.questdb.client.cutlass.qwp.client.QwpWebSocketEncoder`.
 *
 * Message layout:
 *   [12-byte header][delta symbol dictionary][table block...]
 *
 * By default the message is self-sufficient: the symbol dictionary is sent
 * in full (deltaStart = 0), so any frame can be replayed safely after a
 * failed send.
 */
export class QwpEncoder {
  constructor(
    private readonly symbolDict: GlobalSymbolDictionary,
    private readonly flags = FLAG_DELTA_SYMBOL_DICT,
  ) {}

  /**
   * Encodes the given tables into one message.
   * @param tables non-empty table buffers, in insertion order
   * @param confirmedMaxSymbolId highest symbol ID the server has confirmed
   *        (-1 when no delta baseline exists, i.e. full dictionary mode)
   * @returns the encoded message bytes
   */
  encode(
    tables: QwpTableBuffer[],
    confirmedMaxSymbolId = -1,
  ): Uint8Array {
    const writer = new ByteWriter();
    const deltaEnabled = (this.flags & FLAG_DELTA_SYMBOL_DICT) !== 0;

    // 12-byte header; payload length is back-filled after the payload is written.
    writer.writeInt32LE(MAGIC_MESSAGE);
    writer.writeByte(VERSION);
    writer.writeByte(this.flags);
    writer.writeUint16LE(tables.length);
    writer.writeUint32LE(0);
    const payloadStart = writer.position;

    if (deltaEnabled) {
      const batchMaxSymbolId = this.symbolDict.getMaxId();
      const deltaStart = confirmedMaxSymbolId + 1;
      const deltaCount = Math.max(0, batchMaxSymbolId - confirmedMaxSymbolId);
      writer.writeVarint(deltaStart);
      writer.writeVarint(deltaCount);
      for (let id = deltaStart; id < deltaStart + deltaCount; id++) {
        const symbol = this.symbolDict.getSymbol(id);
        if (symbol === undefined) {
          throw new Error(`Symbol id ${id} is not present in the dictionary`);
        }
        writer.writeString(symbol);
      }
    }

    for (const table of tables) {
      this.encodeTable(writer, table);
    }

    writer.patchInt32LE(8, writer.position - payloadStart);
    return writer.toUint8Array();
  }

  private encodeTable(writer: ByteWriter, table: QwpTableBuffer): void {
    writer.writeString(table.tableName);
    writer.writeVarint(table.rowCount);
    writer.writeVarint(table.columns.length);
    for (const column of table.columns) {
      writer.writeString(column.name);
      writer.writeByte(column.type);
    }
    for (const column of table.columns) {
      this.encodeColumn(writer, table.rowCount, column);
    }
  }

  private encodeColumn(
    writer: ByteWriter,
    rowCount: number,
    column: { name: string; type: number; values: QwpValue[] },
  ): void {
    const nullBitmap = new Uint8Array(Math.ceil(rowCount / 8));
    let nullCount = 0;
    for (let i = 0; i < rowCount; i++) {
      if (column.values[i] === null) {
        nullBitmap[i >> 3] = (nullBitmap[i >> 3] ?? 0) | (1 << (i & 7));
        nullCount++;
      }
    }

    if (nullCount === 0) {
      writer.writeByte(0x00);
    } else {
      writer.writeByte(0x01);
      writer.writeBytes(nullBitmap);
    }

    const valueAt = (i: number): QwpValue => column.values[i] ?? null;

    switch (column.type) {
      case TYPE_BOOLEAN: {
        // Bit-packed, LSB first, only non-null values are packed.
        let packed = 0;
        let bitIndex = 0;
        for (let i = 0; i < rowCount; i++) {
          const value = valueAt(i);
          if (value !== null) {
            if (value === true) {
              packed |= 1 << (bitIndex & 7);
            }
            bitIndex++;
            if (bitIndex % 8 === 0) {
              writer.writeByte(packed);
              packed = 0;
            }
          }
        }
        if (bitIndex % 8 !== 0) {
          writer.writeByte(packed);
        }
        break;
      }
      case TYPE_BYTE:
        for (let i = 0; i < rowCount; i++) {
          const value = valueAt(i);
          if (value !== null) {
            writer.writeByte(value as number);
          }
        }
        break;
      case TYPE_SHORT:
      case TYPE_CHAR:
        for (let i = 0; i < rowCount; i++) {
          const value = valueAt(i);
          if (value !== null) {
            writer.writeInt16LE(value as number);
          }
        }
        break;
      case TYPE_INT:
        for (let i = 0; i < rowCount; i++) {
          const value = valueAt(i);
          if (value !== null) {
            writer.writeInt32LE(value as number);
          }
        }
        break;
      case TYPE_FLOAT:
        for (let i = 0; i < rowCount; i++) {
          const value = valueAt(i);
          if (value !== null) {
            writer.writeFloat32LE(value as number);
          }
        }
        break;
      case TYPE_LONG:
      case TYPE_TIMESTAMP:
      case TYPE_TIMESTAMP_NANOS:
        for (let i = 0; i < rowCount; i++) {
          const value = valueAt(i);
          if (value !== null) {
            writer.writeInt64LE(value as bigint);
          }
        }
        break;
      case TYPE_DOUBLE:
        for (let i = 0; i < rowCount; i++) {
          const value = valueAt(i);
          if (value !== null) {
            writer.writeFloat64LE(value as number);
          }
        }
        break;
      case TYPE_UUID: {
        // Values are 16 bytes as two little-endian int64 halves [lo, hi].
        for (let i = 0; i < rowCount; i++) {
          const value = valueAt(i);
          if (value !== null) {
            writer.writeBytes(value as unknown as Uint8Array);
          }
        }
        break;
      }
      case TYPE_SYMBOL:
        for (let i = 0; i < rowCount; i++) {
          const value = valueAt(i);
          if (value !== null) {
            writer.writeVarint(value as number);
          }
        }
        break;
      case TYPE_VARCHAR:
      case TYPE_BINARY:
        this.encodeOffsetsAndData(writer, rowCount, column);
        break;
      case TYPE_DOUBLE_ARRAY:
        for (let i = 0; i < rowCount; i++) {
          const value = valueAt(i);
          if (value !== null) {
            this.encodeDoubleArray(writer, value as unknown);
          }
        }
        break;
      case TYPE_LONG_ARRAY:
        for (let i = 0; i < rowCount; i++) {
          const value = valueAt(i);
          if (value !== null) {
            this.encodeLongArray(writer, value as unknown);
          }
        }
        break;
      case TYPE_DECIMAL64:
      case TYPE_DECIMAL128:
      case TYPE_DECIMAL256: {
        // Column-wide scale byte, then one fixed-width unscaled value per row.
        const scale =
          (column as unknown as { scale: number }).scale ?? 0;
        writer.writeByte(scale);
        const width = [8, 16, 32][column.type - TYPE_DECIMAL64] as
          | 8
          | 16
          | 32;
        for (let i = 0; i < rowCount; i++) {
          const value = valueAt(i);
          if (value !== null) {
            writer.writeBytes(
              this.toFixedWidthBytes(value as bigint, width),
            );
          }
        }
        break;
      }
      case TYPE_GEOHASH:
        throw new Error("GEOHASH columns are not supported by this client");
      default:
        throw new Error(`Unsupported column type: ${column.type}`);
    }
  }

  private encodeOffsetsAndData(
    writer: ByteWriter,
    rowCount: number,
    column: { type: number; values: QwpValue[] },
  ): void {
    // Offset array with (valueCount + 1) entries, then concatenated data.
    let valueCount = 0;
    for (let i = 0; i < rowCount; i++) {
      if (column.values[i] !== null) {
        valueCount++;
      }
    }
    const offsetsStart = writer.position;
    for (let i = 0; i <= valueCount; i++) {
      writer.writeUint32LE(0);
    }
    let offset = 0;
    let index = 0;
    for (let i = 0; i < rowCount; i++) {
      const value = column.values[i];
      if (value === null) {
        continue;
      }
      const bytes =
        column.type === TYPE_BINARY
          ? (value as unknown as Uint8Array)
          : new TextEncoder().encode(value as string);
      writer.writeBytes(bytes);
      offset += bytes.length;
      index++;
      writer.patchInt32LE(offsetsStart + index * 4, offset);
    }
  }

  private encodeDoubleArray(writer: ByteWriter, value: unknown): void {
    const dims = getArrayDimensions(value as unknown[]);
    writer.writeByte(dims.length);
    for (const dim of dims) {
      writer.writeInt32LE(dim);
    }
    for (const element of flattenArray(value as unknown[])) {
      writer.writeFloat64LE(element as number);
    }
  }

  private encodeLongArray(writer: ByteWriter, value: unknown): void {
    const dims = getArrayDimensions(value as unknown[]);
    writer.writeByte(dims.length);
    for (const dim of dims) {
      writer.writeInt32LE(dim);
    }
    for (const element of flattenArray(value as unknown[])) {
      writer.writeInt64LE(element as bigint);
    }
  }

  /** Converts a two's complement big-endian byte array to a fixed-width little-endian array. */
  private toFixedWidthBytes(value: bigint, width: 8 | 16 | 32): Uint8Array {
    const result = new Uint8Array(width);
    let v = value;
    for (let i = 0; i < width; i++) {
      result[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    return result;
  }
}

/** Computes the per-level lengths of a nested array. */
export function getArrayDimensions(data: unknown[]): number[] {
  const dimensions: number[] = [];
  let current: unknown = data;
  while (Array.isArray(current)) {
    dimensions.push(current.length);
    current = current[0];
  }
  return dimensions;
}

/** Flattens a nested array in row-major order. */
export function flattenArray(data: unknown[]): unknown[] {
  const result: unknown[] = [];
  const stack: unknown[] = [...data];
  while (stack.length > 0) {
    const item = stack.shift();
    if (Array.isArray(item)) {
      for (let i = item.length - 1; i >= 0; i--) {
        stack.unshift(item[i]);
      }
    } else {
      result.push(item);
    }
  }
  return result;
}

export { HEADER_SIZE };
