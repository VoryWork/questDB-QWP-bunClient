import { HEADER_SIZE } from "./constants";

/**
 * A growable byte buffer with QWP wire-format writers.
 * All multi-byte values are written little-endian.
 */
export class ByteWriter {
  private buffer: Uint8Array;
  private view: DataView;
  private pos: number;

  constructor(initialSize = 1024) {
    this.buffer = new Uint8Array(initialSize);
    this.view = new DataView(this.buffer.buffer);
    this.pos = 0;
  }

  get position(): number {
    return this.pos;
  }

  private ensureCapacity(extra: number): void {
    if (this.pos + extra <= this.buffer.length) {
      return;
    }
    let newSize = this.buffer.length * 2;
    while (newSize < this.pos + extra) {
      newSize *= 2;
    }
    const newBuffer = new Uint8Array(newSize);
    newBuffer.set(this.buffer.subarray(0, this.pos));
    this.buffer = newBuffer;
    this.view = new DataView(newBuffer.buffer);
  }

  writeByte(value: number): void {
    this.ensureCapacity(1);
    this.buffer[this.pos++] = value & 0xff;
  }

  writeBytes(bytes: Uint8Array): void {
    this.ensureCapacity(bytes.length);
    this.buffer.set(bytes, this.pos);
    this.pos += bytes.length;
  }

  writeInt16LE(value: number): void {
    this.ensureCapacity(2);
    this.view.setInt16(this.pos, value, true);
    this.pos += 2;
  }

  writeUint16LE(value: number): void {
    this.ensureCapacity(2);
    this.view.setUint16(this.pos, value, true);
    this.pos += 2;
  }

  writeInt32LE(value: number): void {
    this.ensureCapacity(4);
    this.view.setInt32(this.pos, value, true);
    this.pos += 4;
  }

  writeUint32LE(value: number): void {
    this.ensureCapacity(4);
    this.view.setUint32(this.pos, value >>> 0, true);
    this.pos += 4;
  }

  writeInt64LE(value: bigint): void {
    this.ensureCapacity(8);
    this.view.setBigInt64(this.pos, value, true);
    this.pos += 8;
  }

  writeUint64LE(value: bigint): void {
    this.ensureCapacity(8);
    this.view.setBigUint64(this.pos, value, true);
    this.pos += 8;
  }

  writeFloat32LE(value: number): void {
    this.ensureCapacity(4);
    this.view.setFloat32(this.pos, value, true);
    this.pos += 4;
  }

  writeFloat64LE(value: number): void {
    this.ensureCapacity(8);
    this.view.setFloat64(this.pos, value, true);
    this.pos += 8;
  }

  /**
   * Writes an unsigned LEB128 varint.
   * @throws Error if value is negative or not a safe integer
   */
  writeVarint(value: number): void {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`Cannot encode a negative or non-integer varint: ${value}`);
    }
    let v = value;
    while (v > 0x7f) {
      this.writeByte((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    this.writeByte(v);
  }

  /**
   * Writes a UTF-8 string prefixed with its byte length as a varint.
   */
  writeString(value: string): void {
    const bytes = new TextEncoder().encode(value);
    this.writeVarint(bytes.length);
    this.writeBytes(bytes);
  }

  /**
   * Writes a raw (unprefixed) UTF-8 string, returning its byte length.
   */
  writeUtf8(value: string): number {
    const bytes = new TextEncoder().encode(value);
    this.writeBytes(bytes);
    return bytes.length;
  }

  /**
   * Patches a 32-bit little-endian integer at the given offset.
   * Used to back-fill the payload length in the message header.
   */
  patchInt32LE(offset: number, value: number): void {
    this.view.setInt32(offset, value, true);
  }

  /** Returns a copy of the written bytes. */
  toUint8Array(): Uint8Array {
    return this.buffer.slice(0, this.pos);
  }
}

/** Number of bytes an unsigned LEB128 varint occupies for the given value. */
export function varintSize(value: number): number {
  if (value <= 0x7f) {
    return 1;
  }
  let size = 1;
  let v = value;
  while (v > 0x7f) {
    v = Math.floor(v / 128);
    size++;
  }
  return size;
}

/**
 * A read cursor over the received frame bytes with QWP wire-format readers.
 */
export class ByteReader {
  private readonly data: Uint8Array;
  private readonly view: DataView;
  private pos: number;

  constructor(data: Uint8Array) {
    this.data = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.pos = 0;
  }

  get position(): number {
    return this.pos;
  }

  get remaining(): number {
    return this.data.length - this.pos;
  }

  readByte(): number {
    if (this.pos >= this.data.length) {
      throw new Error("Buffer underflow while reading a byte");
    }
    return this.data[this.pos++]!;
  }

  readUint16LE(): number {
    if (this.pos + 2 > this.data.length) {
      throw new Error("Buffer underflow while reading uint16");
    }
    const value = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return value;
  }

  readUint32LE(): number {
    if (this.pos + 4 > this.data.length) {
      throw new Error("Buffer underflow while reading uint32");
    }
    const value = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return value;
  }

  readUint64LE(): bigint {
    if (this.pos + 8 > this.data.length) {
      throw new Error("Buffer underflow while reading uint64");
    }
    const value = this.view.getBigUint64(this.pos, true);
    this.pos += 8;
    return value;
  }

  /**
   * Reads an unsigned LEB128 varint.
   * @throws Error on malformed input or if the value exceeds Number.MAX_SAFE_INTEGER
   */
  readVarint(): number {
    let result = 0;
    let shift = 0;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.data.length) {
        throw new Error("Buffer underflow while reading varint");
      }
      const byte = this.data[this.pos++]!;
      result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) {
        if (result > Number.MAX_SAFE_INTEGER) {
          throw new Error("Varint exceeds Number.MAX_SAFE_INTEGER");
        }
        return result;
      }
      shift += 7;
    }
    throw new Error("Varint is too long");
  }

  /** Reads a UTF-8 string prefixed with its byte length as a varint. */
  readString(): string {
    const length = this.readVarint();
    if (this.pos + length > this.data.length) {
      throw new Error("Buffer underflow while reading a string");
    }
    const value = new TextDecoder().decode(
      this.data.subarray(this.pos, this.pos + length),
    );
    this.pos += length;
    return value;
  }

  skip(bytes: number): void {
    if (this.pos + bytes > this.data.length) {
      throw new Error("Buffer underflow while skipping bytes");
    }
    this.pos += bytes;
  }
}

export { HEADER_SIZE };
