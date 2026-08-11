/**
 * Constants for the QWP v1 binary protocol.
 *
 * All multi-byte values on the wire are little-endian: the least significant
 * byte is stored at the lowest address.
 */

/** Client identifier sent in the X-QWP-Client-Id upgrade header. */
export const CLIENT_ID = "bunjs/1.0.0";

/** Flag bit: defer WAL commit. */
export const FLAG_DEFER_COMMIT = 0x01;

/** Flag bit: Gorilla timestamp encoding enabled. */
export const FLAG_GORILLA = 0x04;

/** Flag bit: Delta symbol dictionary encoding enabled. */
export const FLAG_DELTA_SYMBOL_DICT = 0x08;

/** Offset of flags byte in header. */
export const HEADER_OFFSET_FLAGS = 5;

/** Size of the message header in bytes. */
export const HEADER_SIZE = 12;

/** Magic bytes for QWP v1 message: "QWP1". */
export const MAGIC_MESSAGE = 0x31505751; // "QWP1" in little-endian

/** The QWP protocol version carried in the per-frame header. */
export const VERSION = 1;

/** Maximum columns per table. */
export const MAX_COLUMNS_PER_TABLE = 2048;

/** Maximum column name length in bytes. */
export const MAX_COLUMN_NAME_LENGTH = 127;

/** Maximum table name length in bytes. */
export const MAX_TABLE_NAME_LENGTH = 127;

/** Maximum number of distinct symbol values a global symbol dictionary may hold. */
export const MAX_SYMBOL_DICTIONARY_SIZE = 1_000_000;

/** Column type: BOOLEAN (1 bit per value, packed). */
export const TYPE_BOOLEAN = 0x01;
/** Column type: BYTE (int8). */
export const TYPE_BYTE = 0x02;
/** Column type: SHORT (int16). */
export const TYPE_SHORT = 0x03;
/** Column type: INT (int32). */
export const TYPE_INT = 0x04;
/** Column type: LONG (int64). */
export const TYPE_LONG = 0x05;
/** Column type: FLOAT (IEEE 754 float32). */
export const TYPE_FLOAT = 0x06;
/** Column type: DOUBLE (IEEE 754 float64). */
export const TYPE_DOUBLE = 0x07;
/** Column type: SYMBOL (dictionary-encoded string). */
export const TYPE_SYMBOL = 0x09;
/** Column type: TIMESTAMP (int64 microseconds since epoch). */
export const TYPE_TIMESTAMP = 0x0a;
/** Column type: DATE (int64 milliseconds since epoch). */
export const TYPE_DATE = 0x0b;
/** Column type: UUID (16 bytes, little-endian). */
export const TYPE_UUID = 0x0c;
/** Column type: LONG256 (32 bytes, little-endian). */
export const TYPE_LONG256 = 0x0d;
/** Column type: GEOHASH (varint bits + packed geohash). */
export const TYPE_GEOHASH = 0x0e;
/** Column type: VARCHAR (length-prefixed UTF-8). */
export const TYPE_VARCHAR = 0x0f;
/** Column type: TIMESTAMP_NANOS (int64 nanoseconds since epoch). */
export const TYPE_TIMESTAMP_NANOS = 0x10;
/** Column type: DOUBLE_ARRAY (N-dimensional array of float64). */
export const TYPE_DOUBLE_ARRAY = 0x11;
/** Column type: LONG_ARRAY (N-dimensional array of int64). */
export const TYPE_LONG_ARRAY = 0x12;
/** Column type: DECIMAL64 (8 bytes). */
export const TYPE_DECIMAL64 = 0x13;
/** Column type: DECIMAL128 (16 bytes). */
export const TYPE_DECIMAL128 = 0x14;
/** Column type: DECIMAL256 (32 bytes). */
export const TYPE_DECIMAL256 = 0x15;
/** Column type: CHAR (2-byte UTF-16 code unit). */
export const TYPE_CHAR = 0x16;
/** Column type: BINARY (length-prefixed opaque bytes). */
export const TYPE_BINARY = 0x17;
/** Column type: IPv4 (32-bit address). */
export const TYPE_IPV4 = 0x18;

/** Status: OK - batch accepted. */
export const STATUS_OK = 0x00;
/** Status: DURABLE_ACK (Enterprise). */
export const STATUS_DURABLE_ACK = 0x02;
/** Status: SCHEMA_MISMATCH. */
export const STATUS_SCHEMA_MISMATCH = 0x03;
/** Status: PARSE_ERROR. */
export const STATUS_PARSE_ERROR = 0x05;
/** Status: INTERNAL_ERROR. */
export const STATUS_INTERNAL_ERROR = 0x06;
/** Status: SECURITY_ERROR. */
export const STATUS_SECURITY_ERROR = 0x08;
/** Status: WRITE_ERROR. */
export const STATUS_WRITE_ERROR = 0x09;
/** Status: NOT_WRITABLE (retryable). */
export const STATUS_NOT_WRITABLE = 0x0c;
/** Status: DICTIONARY_GAP (retryable). */
export const STATUS_DICTIONARY_GAP = 0x0d;

/** Minimal size of an OK response frame. */
export const MIN_OK_RESPONSE_SIZE = 11;
/** Minimal size of an error response frame. */
export const MIN_ERROR_RESPONSE_SIZE = 11;
/** Maximum error message length. */
export const MAX_ERROR_MESSAGE_LENGTH = 1024;

/** HTTP status codes that indicate an unrecoverable authentication failure. */
export const HTTP_STATUS_AUTH_FAILED = [401, 403];

/**
 * Returns the per-value size in bytes as encoded on the wire.
 * BOOLEAN returns 0 (bit-packed), variable-width types return -1.
 */
export function getFixedTypeSize(typeCode: number): number {
  switch (typeCode) {
    case TYPE_BOOLEAN:
      return 0; // bit-packed
    case TYPE_BYTE:
      return 1;
    case TYPE_SHORT:
    case TYPE_CHAR:
      return 2;
    case TYPE_INT:
    case TYPE_FLOAT:
    case TYPE_IPV4:
      return 4;
    case TYPE_LONG:
    case TYPE_DOUBLE:
    case TYPE_TIMESTAMP:
    case TYPE_TIMESTAMP_NANOS:
    case TYPE_DATE:
    case TYPE_DECIMAL64:
      return 8;
    case TYPE_UUID:
    case TYPE_DECIMAL128:
      return 16;
    case TYPE_LONG256:
    case TYPE_DECIMAL256:
      return 32;
    default:
      return -1; // variable width
  }
}

/** Returns true if the type code represents a fixed-width type. */
export function isFixedWidthType(typeCode: number): boolean {
  return getFixedTypeSize(typeCode) >= 0 || typeCode === TYPE_BOOLEAN;
}
