import {
  MAX_ERROR_MESSAGE_LENGTH,
  MIN_ERROR_RESPONSE_SIZE,
  MIN_OK_RESPONSE_SIZE,
  STATUS_DURABLE_ACK,
  STATUS_OK,
} from "./constants";
import { ByteReader } from "./varint";

/** Parsed server response to an ingested message. */
export interface QwpResponse {
  /** QWP status code (STATUS_OK, STATUS_*, ...). */
  status: number;
  /** The sequence number echoed by the server, or -1 when absent (durable ack). */
  sequence: bigint;
  /** Per-table transaction sequence numbers. */
  tables: { name: string; seqTxn: bigint }[];
  /** Error message, present only for error responses. */
  message: string;
}

/**
 * Decodes a server response frame, mirroring
 * `io.questdb.client.cutlass.qwp.client.WebSocketResponse`.
 *
 * OK:          [status:1][sequence:u64][tableCount:u16][(nameLen:u16 + name + seqTxn:u64)...]
 * DURABLE_ACK: [status:1][tableCount:u16][(nameLen:u16 + name + seqTxn:u64)...]  (no sequence)
 * Error:       [status:1][sequence:u64][msgLen:u16][UTF-8 msg]
 */
export function decodeResponse(data: Uint8Array): QwpResponse {
  const reader = new ByteReader(data);
  const status = reader.readByte();

  if (status === STATUS_OK) {
    if (reader.remaining < MIN_OK_RESPONSE_SIZE - 1) {
      throw new Error("Malformed server response: frame is too short");
    }
    const sequence = reader.readUint64LE();
    const tableCount = reader.readUint16LE();
    const tables: QwpResponse["tables"] = [];
    for (let i = 0; i < tableCount; i++) {
      const nameLen = reader.readUint16LE();
      if (nameLen === 0) {
        throw new Error("Malformed server response: empty table name");
      }
      if (reader.remaining < nameLen + 8) {
        throw new Error("Malformed server response: truncated table info");
      }
      const name = new TextDecoder().decode(
        data.subarray(reader.position, reader.position + nameLen),
      );
      reader.skip(nameLen);
      const seqTxn = reader.readUint64LE();
      tables.push({ name, seqTxn });
    }
    return { status, sequence, tables, message: "" };
  }

  if (status === STATUS_DURABLE_ACK) {
    // Durable ack (Enterprise): no sequence field.
    if (reader.remaining < 2) {
      throw new Error(
        "Malformed server response: durable ack frame is too short",
      );
    }
    const tableCount = reader.readUint16LE();
    const tables: QwpResponse["tables"] = [];
    for (let i = 0; i < tableCount; i++) {
      const nameLen = reader.readUint16LE();
      if (reader.remaining < nameLen + 8) {
        throw new Error("Malformed server response: truncated table info");
      }
      const name = new TextDecoder().decode(
        data.subarray(reader.position, reader.position + nameLen),
      );
      reader.skip(nameLen);
      const seqTxn = reader.readUint64LE();
      tables.push({ name, seqTxn });
    }
    return { status, sequence: -1n, tables, message: "" };
  }

  // Error response: [status:1][sequence:u64][msgLen:u16][msg].
  if (reader.remaining < MIN_ERROR_RESPONSE_SIZE - 1) {
    throw new Error("Malformed server response: error frame is too short");
  }
  const sequence = reader.readUint64LE();
  const msgLen = reader.readUint16LE();
  if (msgLen > MAX_ERROR_MESSAGE_LENGTH) {
    throw new Error("Malformed server response: error message is too long");
  }
  let message = "";
  if (msgLen > 0) {
    if (reader.remaining < msgLen) {
      throw new Error("Malformed server response: truncated error message");
    }
    message = new TextDecoder().decode(
      data.subarray(reader.position, reader.position + msgLen),
    );
    reader.skip(msgLen);
  }
  return { status, sequence, tables: [], message };
}

export { STATUS_OK, STATUS_DURABLE_ACK };
