// @ts-check
import type { Server } from "bun";

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
            ws.send(encodeOkFrame(BigInt(this.frames.length - 1)));
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
  }
}

/**
 * Builds a QWP OK response frame.
 * [status:1][sequence:u64][tableCount:u16]
 */
export function encodeOkFrame(sequence: bigint): Uint8Array {
  const bytes = new Uint8Array(11);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, 0x00);
  view.setBigUint64(1, sequence, true);
  view.setUint16(9, 0, true);
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
