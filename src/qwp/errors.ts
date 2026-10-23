import {
  STATUS_DICTIONARY_GAP,
  STATUS_INTERNAL_ERROR,
  STATUS_NOT_WRITABLE,
  STATUS_PARSE_ERROR,
  STATUS_SCHEMA_MISMATCH,
  STATUS_SECURITY_ERROR,
  STATUS_WRITE_ERROR,
} from "./constants";

/**
 * What the client knows about the fate of a frame that was not acknowledged.
 *
 * - `not_sent`: the frame never reached the server (e.g. connect failure).
 * - `rejected`: the server answered with an error status.
 * - `unknown`: the frame was sent but no acknowledgement arrived in time.
 *   The data may or may not have been committed.
 */
export type QwpDelivery = "not_sent" | "rejected" | "unknown";

export type QwpErrorCode =
  | "ACK_TIMEOUT"
  | "CONNECTION_CLOSED"
  | "CONNECTION_ERROR"
  | "CONNECT_FAILED"
  | "SERVER_REJECT"
  | "SCHEMA_MISMATCH"
  | "PARSE_ERROR"
  | "INTERNAL_ERROR"
  | "SECURITY_ERROR"
  | "WRITE_ERROR"
  | "NOT_WRITABLE"
  | "DICTIONARY_GAP"
  | "MALFORMED_RESPONSE"
  | "WRITE_DEADLINE"
  | "STALE_TABLE"
  | "UNKNOWN_ERROR";

export interface QwpErrorOptions {
  code: QwpErrorCode;
  delivery: QwpDelivery;
  retryable: boolean;
  status?: number;
  sequence?: bigint;
  table?: string;
  cause?: unknown;
}

/**
 * Transport-level write error with a structured delivery outcome.
 *
 * Callers should branch on `code` / `delivery` / `retryable` rather than
 * matching the error message.
 */
export class QwpError extends Error {
  readonly code: QwpErrorCode;
  readonly delivery: QwpDelivery;
  readonly retryable: boolean;
  readonly status?: number;
  readonly sequence?: bigint;
  readonly table?: string;

  constructor(message: string, options: QwpErrorOptions) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "QwpError";
    this.code = options.code;
    this.delivery = options.delivery;
    this.retryable = options.retryable;
    this.status = options.status;
    this.sequence = options.sequence;
    this.table = options.table;
  }
}

export function isQwpError(error: unknown): error is QwpError {
  return error instanceof QwpError;
}

/** Wraps an unknown error thrown by the transport into a QwpError. */
export function toQwpError(error: unknown): QwpError {
  if (error instanceof QwpError) {
    return error;
  }
  return new QwpError(String((error as Error)?.message ?? error), {
    code: "UNKNOWN_ERROR",
    delivery: "unknown",
    retryable: false,
    cause: error,
  });
}

/** Maps a server rejection status to a structured QwpError. */
export function serverStatusError(
  status: number,
  message: string,
  sequence?: bigint,
): QwpError {
  const text = `Server rejected the batch [status=${status}, message=${message}]`;
  const base = { delivery: "rejected" as const, status, sequence };
  switch (status) {
    case STATUS_SCHEMA_MISMATCH:
      return new QwpError(text, {
        ...base,
        code: "SCHEMA_MISMATCH",
        retryable: false,
      });
    case STATUS_PARSE_ERROR:
      return new QwpError(text, {
        ...base,
        code: "PARSE_ERROR",
        retryable: false,
      });
    case STATUS_INTERNAL_ERROR:
      return new QwpError(text, {
        ...base,
        code: "INTERNAL_ERROR",
        retryable: false,
      });
    case STATUS_SECURITY_ERROR:
      return new QwpError(text, {
        ...base,
        code: "SECURITY_ERROR",
        retryable: false,
      });
    case STATUS_WRITE_ERROR:
      return new QwpError(text, {
        ...base,
        code: "WRITE_ERROR",
        retryable: false,
      });
    case STATUS_NOT_WRITABLE:
      return new QwpError(text, {
        ...base,
        code: "NOT_WRITABLE",
        retryable: true,
      });
    case STATUS_DICTIONARY_GAP:
      return new QwpError(text, {
        ...base,
        code: "DICTIONARY_GAP",
        retryable: true,
      });
    default:
      return new QwpError(text, {
        ...base,
        code: "SERVER_REJECT",
        retryable: false,
      });
  }
}
