import type { Logger } from "../logging";
import { SenderOptions, WS, WSS } from "../options";
import { isInteger } from "../utils";
import {
  CLIENT_ID,
  HEADER_SIZE,
  STATUS_DICTIONARY_GAP,
  STATUS_INTERNAL_ERROR,
  STATUS_NOT_WRITABLE,
  STATUS_PARSE_ERROR,
  STATUS_SCHEMA_MISMATCH,
  STATUS_SECURITY_ERROR,
  STATUS_WRITE_ERROR,
  VERSION,
} from "./constants";
import { decodeResponse } from "./decoder";

const DEFAULT_QWP_AUTO_FLUSH_ROWS = 1000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_ACK_TIMEOUT_MS = 10_000;
const WRITE_PATH = "/write/v4";

/** Default connect/ack timeout derived from request_timeout, when set. */

interface PendingRequest {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * QuestDB Wire Protocol transport over a Bun native WebSocket connection.
 *
 * Mirrors `io.questdb.client.cutlass.qwp.client.QwpWebSocketSender`'s I/O
 * loop, simplified to the synchronous-ack model of the Node.js client:
 * `send()` resolves only after the server has acknowledged the message.
 */
export class QwpTransport {
  private ws: WebSocket | null = null;
  private nextSeq = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private closed = false;
  private readonly connectTimeoutMs: number;
  private readonly ackTimeoutMs: number;
  private readonly log: Logger;
  private readonly url: string;
  private readonly authorizationHeader?: string;

  constructor(options: SenderOptions, logger: Logger) {
    if (!options.protocol) {
      throw new Error("The 'protocol' option is mandatory");
    }
    if (!options.host) {
      throw new Error("The 'host' option is mandatory");
    }
    const secure = options.protocol === WSS;
    if (!secure && options.protocol !== WS) {
      throw new Error(
        `Invalid protocol: '${options.protocol}', accepted protocols: 'ws', 'wss'`,
      );
    }
    this.url = `${secure ? "wss" : "ws"}://${options.host}:${options.port ?? 9000}${WRITE_PATH}`;
    this.log = logger;
    this.connectTimeoutMs = isInteger(options.request_timeout, 1)
      ? options.request_timeout
      : DEFAULT_CONNECT_TIMEOUT_MS;
    this.ackTimeoutMs = isInteger(options.request_timeout, 1)
      ? options.request_timeout
      : DEFAULT_ACK_TIMEOUT_MS;

    if (options.token) {
      this.authorizationHeader = `Bearer ${options.token}`;
    } else if (options.username && options.password) {
      this.authorizationHeader = `Basic ${btoa(`${options.username}:${options.password}`)}`;
    }
  }

  /** True when a WebSocket connection is established. */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Establishes the WebSocket connection.
   * @throws Error if already connected or the handshake fails
   */
  async connect(): Promise<boolean> {
    if (this.closed) {
      throw new Error("Sender is closed");
    }
    if (this.isConnected()) {
      throw new Error("Sender connected already");
    }

    const headers: Record<string, string> = {
      "X-QWP-Max-Version": String(VERSION),
      "X-QWP-Client-Id": CLIENT_ID,
    };
    if (this.authorizationHeader) {
      headers["Authorization"] = this.authorizationHeader;
    }

    const ws = new WebSocket(this.url, { headers });
    ws.binaryType = "arraybuffer";

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Failed to connect to ${this.url} [error=timeout]`));
        try {
          ws.close();
        } catch {
          // already closed
        }
      }, this.connectTimeoutMs);

      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(
          new Error(
            `Failed to connect to ${this.url} [error=websocket handshake failed]`,
          ),
        );
      };
      ws.onclose = () => {
        clearTimeout(timer);
        reject(new Error(`Failed to connect to ${this.url} [error=connection closed]`));
      };
    });

    this.ws = ws;
    ws.onopen = null;
    ws.onerror = () => {
      this.failAllPending(new Error("WebSocket connection error"));
    };
    ws.onclose = (event) => {
      this.failAllPending(
        new Error(
          `WebSocket connection closed [code=${event.code}, reason=${event.reason}]`,
        ),
      );
    };
    ws.onmessage = (event) => {
      this.handleMessage(event as unknown as MessageEvent);
    };
    this.log("info", `Successfully connected to ${this.url}`);
    return true;
  }

  /**
   * Sends an encoded QWP message and waits for the server's acknowledgement.
   * Establishes the connection first if it is not yet open.
   */
  async send(frame: Uint8Array): Promise<void> {
    if (!this.isConnected()) {
      await this.connect();
    }
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error("QWP transport is not connected");
    }

    const seq = this.nextSeq++;
    const response = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(
          new Error(
            `Timeout waiting for server acknowledgement [sequence=${seq}]`,
          ),
        );
      }, this.ackTimeoutMs);
      this.pending.set(seq, { resolve, reject, timer });
    });
    // Avoid unhandled rejections when the connection closes while a flush is
    // in flight and its promise is never awaited (e.g. un-awaited atNow()).
    response.catch(() => {});

    ws.send(frame);
    return response;
  }

  /**
   * Closes the WebSocket connection. Idempotent.
   * @param warnAboutUnflushed set to true when buffered rows may be lost
   */
  async close(warnAboutUnflushed = false): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.failAllPending(new Error("Sender is closed"));
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.onclose = null;
        ws.onerror = null;
        ws.onmessage = null;
        ws.close(1000, "client close");
      } catch {
        // ignore
      }
    }
    this.log("debug", "Connection closed");
  }

  getDefaultAutoFlushRows(): number {
    return DEFAULT_QWP_AUTO_FLUSH_ROWS;
  }

  private handleMessage(event: MessageEvent): void {
    const data = event.data;
    if (typeof data === "string") {
      this.log("warn", "Received unexpected text message from the server");
      return;
    }
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : data instanceof Uint8Array
          ? data
          : new Uint8Array(data as ArrayBuffer);

    let response;
    try {
      response = decodeResponse(bytes);
    } catch (error) {
      this.failAllPending(error as Error);
      return;
    }

    if (response.status === STATUS_DICTIONARY_GAP) {
      // The server lost its symbol dictionary; a reconnect with a full
      // dictionary catch-up frame would be required. Surface the error.
      this.failPending(
        response.sequence,
        new Error(
          `Server reported a symbol dictionary gap [message=${response.message}]`,
        ),
      );
      return;
    }

    if (response.status !== 0) {
      this.failPending(
        response.sequence,
        new Error(
          `Server rejected the batch [status=${response.status}, message=${response.message}]`,
        ),
      );
      return;
    }

    this.resolvePending(response.sequence);
  }

  private resolvePending(sequence: bigint): void {
    const seq = Number(sequence);
    const request = this.pending.get(seq);
    if (request) {
      this.pending.delete(seq);
      clearTimeout(request.timer);
      request.resolve();
    }
  }

  private failPending(sequence: bigint, error: Error): void {
    const seq = Number(sequence);
    const request = this.pending.get(seq);
    if (request) {
      this.pending.delete(seq);
      clearTimeout(request.timer);
      request.reject(error);
    }
  }

  private failAllPending(error: Error): void {
    for (const [, request] of this.pending) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
}

export { WRITE_PATH, DEFAULT_QWP_AUTO_FLUSH_ROWS, HEADER_SIZE };

// Re-exported status codes for tests and callers that inspect server errors.
export {
  STATUS_SCHEMA_MISMATCH,
  STATUS_PARSE_ERROR,
  STATUS_INTERNAL_ERROR,
  STATUS_SECURITY_ERROR,
  STATUS_WRITE_ERROR,
  STATUS_NOT_WRITABLE,
  STATUS_DICTIONARY_GAP,
};
