/**
 * A QuestDB client for Bun, using the QuestDB Wire Protocol (QWP) over WebSocket.
 *
 * The public API mirrors {@link https://questdb.github.io/nodejs-questdb-client | @questdb/nodejs-client}
 * so that existing code can switch transports by changing the configuration string.
 * @packageDocumentation
 */

export { Sender } from "./sender";
export { SenderOptions } from "./options";
export type { ExtraOptions } from "./options";
export type { TimestampUnit } from "./utils";
export { bigintToTwosComplementBytes } from "./utils";
export type { Logger } from "./logging";
export { QwpError, isQwpError } from "./qwp/errors";
export type { QwpErrorCode, QwpDelivery, QwpErrorOptions } from "./qwp/errors";
export { QwpTransport } from "./qwp/transport";
export { QwpEncoder } from "./qwp/encoder";
export { GlobalSymbolDictionary } from "./qwp/symboldict";
