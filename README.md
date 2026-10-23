# questdb-qwp-bunclient

> [English](README.md) | [中文](README.zh.md)

A QuestDB Wire Protocol (QWP) client built on **Bun's native WebSocket**, with a public API compatible with
[`@questdb/nodejs-client`](https://questdb.github.io/nodejs-questdb-client).

QWP is QuestDB's binary ingestion protocol (WebSocket transport, `/write/v4` endpoint). The protocol
implementation in this project is based on the `io.questdb.client.cutlass.qwp` package from the
[Java client](https://github.com/questdb/java-questdb-client) and the
[QWP protocol documentation](https://questdb.com/docs/connect/wire-protocols/qwp-ingress-websocket).

## Features

- **Zero dependencies**: uses Bun's built-in `WebSocket` client, no `ws` package required
- **API compatible**: `Sender.fromConfig` / `table` / `symbol` / `stringColumn` / `intColumn` /
  `floatColumn` / `booleanColumn` / `timestampColumn` / `arrayColumn` / `decimalColumn` /
  `at` / `atNow` / `flush` / `close` match the nodejs client
- **Columnar binary encoding**: 12-byte message header (`QWP1`), incremental symbol dictionary,
  null bitmap, VARCHAR offset arrays, bit-packed BOOLEAN, TIMESTAMP (micros/nanos), DOUBLE/LONG
  arrays, DECIMAL64/128/256
- **Synchronous acknowledgement model**: `flush()` resolves after the server ACK; one flush =
  one server transaction
- **Explicit delivery outcome**: ack timeouts and connection loss are reported as `QwpError`
  with `delivery: 'unknown'`; the unacknowledged frame is retained, never silently dropped
- **Optional idempotent replay**: `resend_on_unknown=on` replays the exact frame once on a fresh
  connection (requires `DEDUP UPSERT KEYS(ts)` on every target table)
- **Auto flush**: `auto_flush_rows` (default 1000) / `auto_flush_interval` (default 1000ms)
- **Authentication**: Basic (`username` + `password`) or Bearer (`token`) sent during the
  WebSocket upgrade handshake
- **Ordered, non-lossy buffering**: serialized flushes plus table-buffer swap during sends keep
  rows intact and unique under high load

## Installation

```bash
bun add questdb-qwp-bunclient
```

Or use it directly from source (this repository):

```bash
bun install
bun test ./test        # run all tests
bunx tsc --noEmit      # type check
```

The integration tests (`test/sender.integration.test.ts`) require a local QuestDB instance
(default `localhost:9000`). Those cases are skipped automatically when QuestDB is unavailable.

## Basic usage

```typescript
import { Sender } from "questdb-qwp-bunclient";

async function run() {
  // Create a Sender with the ws protocol (QWP over WebSocket)
  const sender = await Sender.fromConfig("ws::addr=127.0.0.1:9000");

  // Add a row to the Sender's buffer
  await sender
    .table("trades")
    .symbol("symbol", "BTC-USD")
    .symbol("side", "sell")
    .floatColumn("price", 39269.98)
    .floatColumn("amount", 0.011)
    .at(Date.now(), "ms");

  // Flush the buffer and send the data to QuestDB
  // The buffer is cleared after sending, so the Sender can keep accepting new data
  await sender.flush();

  // Close the connection (unflushed data is lost)
  await sender.close();
}

run().then(console.log).catch(console.error);
```

## Authentication

#### Username/password authentication (Basic)

```typescript
import { Sender } from "questdb-qwp-bunclient";

async function run() {
  const USER = "admin";
  const PWD = "quest";

  // Credentials are sent as an Authorization: Basic header during the WebSocket upgrade handshake
  // Use the 'wss' protocol instead of 'ws' for secure connections
  const sender = await Sender.fromConfig(
    `ws::addr=127.0.0.1:9000;username=${USER};password=${PWD}`,
  );

  await sender
    .table("trades")
    .symbol("symbol", "ETH-USD")
    .symbol("side", "sell")
    .floatColumn("price", 2615.54)
    .floatColumn("amount", 0.00044)
    .at(Date.now(), "ms");

  await sender.flush();
  await sender.close();
}

run().catch(console.error);
```

#### Bearer token authentication

```typescript
import { Sender } from "questdb-qwp-bunclient";

async function run() {
  const TOKEN = "Xyvd3er6GF87ysaHk";

  // The token is sent as an Authorization: Bearer header during the WebSocket upgrade handshake
  // Note: token authentication is only supported by QuestDB Enterprise
  const sender = await Sender.fromConfig(
    `ws::addr=127.0.0.1:9000;token=${TOKEN}`,
  );

  await sender
    .table("trades")
    .symbol("symbol", "ETH-USD")
    .symbol("side", "sell")
    .floatColumn("price", 2615.54)
    .floatColumn("amount", 0.00044)
    .at(Date.now(), "ms");

  await sender.flush();
  await sender.close();
}

run().catch(console.error);
```

## Array columns

```typescript
import { Sender } from "questdb-qwp-bunclient";

async function run() {
  const sender = await Sender.fromConfig("ws::addr=localhost:9000");

  // Order book snapshots to ingest
  const orderBooks = [
    {
      symbol: "BTC-USD",
      exchange: "Coinbase",
      timestamp: Date.now(),
      bidPrices: [50100.25, 50100.20, 50100.15, 50100.10, 50100.05],
      bidSizes: [0.5, 1.2, 2.1, 0.8, 3.5],
      askPrices: [50100.30, 50100.35, 50100.40, 50100.45, 50100.50],
      askSizes: [0.6, 1.5, 1.8, 2.2, 4.0],
    },
    {
      symbol: "ETH-USD",
      exchange: "Coinbase",
      timestamp: Date.now(),
      bidPrices: [2850.5, 2850.45, 2850.4, 2850.35, 2850.3],
      bidSizes: [5.0, 8.2, 12.5, 6.8, 15.0],
      askPrices: [2850.55, 2850.6, 2850.65, 2850.7, 2850.75],
      askSizes: [4.5, 7.8, 10.2, 8.5, 20.0],
    },
  ];

  try {
    for (const orderBook of orderBooks) {
      await sender
        .table("order_book_l2")
        .symbol("symbol", orderBook.symbol)
        .symbol("exchange", orderBook.exchange)
        .arrayColumn("bid_prices", orderBook.bidPrices)
        .arrayColumn("bid_sizes", orderBook.bidSizes)
        .arrayColumn("ask_prices", orderBook.askPrices)
        .arrayColumn("ask_sizes", orderBook.askSizes)
        .at(orderBook.timestamp, "ms");
    }

    await sender.flush();
  } finally {
    await sender.close();
  }
}

run().then(console.log).catch(console.error);
```

## DECIMAL columns

QuestDB supports the `DECIMAL` data type, which can be ingested with `decimalColumnText` (text)
or `decimalColumn` (binary).

#### Text representation

```typescript
import { Sender } from "questdb-qwp-bunclient";

async function runDecimals() {
  const sender = await Sender.fromConfig("ws::addr=127.0.0.1:9000");

  await sender
    .table("fx")
    // Text preserves the literal and the exact number of decimal places
    .decimalColumnText("mid", "1.234500")
    .atNow();

  await sender.flush();
  await sender.close();
}

runDecimals().catch(console.error);
```

#### Binary representation

The binary representation is recommended for better ingestion performance and smaller payloads
(especially noticeable with large numbers).

```typescript
import { Sender } from "questdb-qwp-bunclient";

async function runDecimals() {
  const sender = await Sender.fromConfig("ws::addr=127.0.0.1:9000");

  await sender
    .table("fx")
    // The decimal value is sent in binary form
    // 123.456 = 123456 * 10^-3
    .decimalColumn("mid", 123456n, 3)
    .atNow();

  await sender.flush();
  await sender.close();
}

runDecimals().catch(console.error);
```

## Explicit timestamps

```typescript
import { Sender } from "questdb-qwp-bunclient";

async function run() {
  const sender = await Sender.fromConfig("ws::addr=localhost:9000");

  // Nanosecond timestamp (TIMESTAMP_NS column, range 1677-2262)
  await sender
    .table("events")
    .stringColumn("name", "startup")
    .at(1658484765000000000n, "ns");

  // Millisecond timestamp (TIMESTAMP column, microsecond precision, range beyond 2262)
  await sender
    .table("events")
    .stringColumn("name", "ingest")
    .at(Date.now(), "ms");

  await sender.flush();
  await sender.close();
}

run().catch(console.error);
```

## Write delivery and retries

An ACK timeout does not mean the write failed: the server may have committed the frame and
merely failed to answer in time. The client therefore distinguishes three outcomes on
`QwpError`:

| `delivery` | meaning | safe to retry? |
|------------|---------|----------------|
| `not_sent` | the frame never reached the server (for example a connect failure) | yes, always |
| `rejected` | the server answered with an error status; inspect `status` / `retryable` | only when `retryable` |
| `unknown` | the frame was sent but no ACK arrived; it may or may not be committed | only with table dedup |

On `unknown`, the exact frame is retained. The next `flush()` (or `retryPending()`) sends it
byte-for-byte before any newer rows. Nothing is dropped silently.

```typescript
import { Sender, QwpError } from "questdb-qwp-bunclient";

const sender = await Sender.fromConfig(
  // resend_on_unknown=on asserts that the target tables use
  // DEDUP UPSERT KEYS(ts), so a replay is idempotent.
  "ws::addr=127.0.0.1:9000;auto_flush=off;ack_timeout=15000;resend_on_unknown=on",
);

try {
  // optional total budget for this flush, including a replay attempt
  await sender.flush(20_000);
} catch (error) {
  if (error instanceof QwpError && error.delivery === "unknown") {
    // retained; retry later or discard explicitly
    // await sender.retryPending();
    // await sender.discardPending();
  }
}
```

Replay is opt-in because the client cannot verify the table schema. Without
`DEDUP UPSERT KEYS(ts)`, replaying an `unknown` frame can duplicate rows. Deterministic
rejections (`SCHEMA_MISMATCH`, `PARSE_ERROR`, `SECURITY_ERROR`, ...) are never replayed. A
`NOT_WRITABLE` or `DICTIONARY_GAP` rejection is safe to replay and is retried once even when
`resend_on_unknown` is off.



## Configuration options

Format: `protocol::key=value;key=value;` (parsing rules match the nodejs client: keys are
case-sensitive, `;;` escapes semicolons, booleans accept only `on`/`off`, numeric values
must be integers).

| key | description | default |
|-----|-------------|---------|
| `protocol` | `ws` (plaintext) or `wss` (TLS), required | - |
| `addr` | `host:port`, required; defaults to port 9000 when omitted | 9000 |
| `username` / `password` | Basic authentication | - |
| `token` | Bearer authentication (Enterprise only) | - |
| `auto_flush` | `on` / `off` | `on` |
| `auto_flush_rows` | flush when this many rows accumulate, 0 disables | 1000 |
| `auto_flush_interval` | flush interval in milliseconds, 0 disables | 1000 |
| `request_timeout` | connection and ACK wait timeout (ms) | 10000 |
| `ack_timeout` | overrides `request_timeout` for ACK waits only | `request_timeout` |
| `resend_on_unknown` | `on` / `off`; replay an unacknowledged frame once on a fresh connection (requires table dedup) | `off` |
| `replay_backoff_ms` | delay between reconnecting and replaying (ms) | 100 |
| `stale_retries` | retries for a table whose ACK does not advance its `seqTxn` | 3 |
| `init_buf_size` / `max_buf_size` | buffer sizes (compatibility options) | 64KiB / 100MiB |
| `max_name_len` | maximum table/column name length | 127 |
| `tls_verify` / `tls_ca` | accepted for config compatibility; custom CA is not yet supported by Bun WebSocket | - |

## Architecture

```
src/
├── index.ts          # public exports (aligned with the nodejs client)
├── sender.ts         # Sender: row-building API, auto-flush, flush serialization
├── options.ts        # config string parsing (nodejs rules + ws/wss)
├── utils.ts          # helpers (isInteger/timestampToMicros/bigintToTwosComplementBytes, etc.)
├── logging.ts        # Logger
├── validation.ts     # table/column name validation
└── qwp/
    ├── constants.ts  # QWP protocol constants (type codes/flags/status)
    ├── varint.ts     # LEB128 + ByteWriter/ByteReader
    ├── symboldict.ts # global symbol dictionary
    ├── tablebuffer.ts# columnar table buffer (row commit/null padding)
    ├── encoder.ts    # QWP message encoding
    ├── decoder.ts    # server response decoding (OK/error)
    ├── errors.ts     # QwpError: code / delivery / retryable / status
    └── transport.ts  # Bun WebSocket transport (handshake/send/ACK matching)
```

## Differences from the nodejs client

- **Protocol**: the nodejs client uses ILP (HTTP/TCP); this project uses QWP (WebSocket)
- **Protocol identifiers**: adds `ws`/`wss`; `http`/`https`/`tcp`/`tcps` are not accepted
- **Protocol version**: QWP supports v1 only, so `protocol_version` is always `1`
- **Type mapping**: `stringColumn`→VARCHAR, `intColumn`→LONG, `floatColumn`→DOUBLE,
  `timestampColumn(unit="ns")`→TIMESTAMP_NS; all other methods map one-to-one by type code
- **Limitations**: Bun's WebSocket client cannot configure a custom CA or disable certificate
  verification (`tls_ca`/`tls_verify` are kept only for config compatibility); handshake response
  headers (`X-QWP-Version`/`X-QWP-Max-Batch-Size`) are not readable, so the byte budget uses
  local defaults

## Testing

| file | content | dependency |
|------|---------|------------|
| `options.test.ts` | config string parsing (30 cases) | none |
| `sender.config.test.ts` | Sender construction validation (21 cases) | none |
| `sender.buffer.test.ts` | QWP encoding byte assertions + row-building validation (28 cases) | none |
| `sender.transport.test.ts` | handshake/auth/ACK/error handling (12 cases, mock WS server) | none |
| `sender.delivery.test.ts` | delivery outcome, retention, replay and deadlines (13 cases, mock WS server) | none |
| `logging.test.ts` | default logging (5 cases) | none |
| `utils.decimal.test.ts` | two's-complement encoding (4 cases) | none |
| `sender.integration.test.ts` | end-to-end against a local QuestDB (9 cases) | QuestDB |

> Relationship to the nodejs client tests: protocol-independent tests (config parsing, construction
> validation, logging, utilities) are ported as-is; ILP-specific byte assertions were rewritten as
> QWP encoding assertions; TCP/HTTP transport tests were rewritten as mock WebSocket server tests;
> TestContainers integration tests were rewritten to target a local QuestDB.

## License

[Apache-2.0](LICENSE). The implementation references
[questdb/java-questdb-client](https://github.com/questdb/java-questdb-client) and
[questdb/nodejs-questdb-client](https://github.com/questdb/nodejs-questdb-client).
