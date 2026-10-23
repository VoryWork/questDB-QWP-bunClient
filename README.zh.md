# questdb-qwp-bunclient

> [English](README.md) | [中文](README.zh.md)

QuestDB Wire Protocol (QWP) 客户端，基于 **Bun 原生 WebSocket**，公共 API 与
[`@questdb/nodejs-client`](https://questdb.github.io/nodejs-questdb-client) 兼容。

QWP 是 QuestDB 的二进制数据摄入协议（WebSocket 传输，`/write/v4` 端点）。本项目的协议实现参考了
[Java 客户端](https://github.com/questdb/java-questdb-client) 的 `io.questdb.client.cutlass.qwp` 包与
[QWP 协议文档](https://questdb.com/docs/connect/wire-protocols/qwp-ingress-websocket)。

## 特性

- **零依赖**：使用 Bun 内置的 `WebSocket` 客户端，无需 `ws` 包
- **API 兼容**：`Sender.fromConfig` / `table` / `symbol` / `stringColumn` / `intColumn` /
  `floatColumn` / `booleanColumn` / `timestampColumn` / `arrayColumn` / `decimalColumn` /
  `at` / `atNow` / `flush` / `close` 与 nodejs 客户端一致
- **列式二进制编码**：12 字节消息头（`QWP1`）、增量符号字典、null 位图、VARCHAR 偏移数组、
  位打包 BOOLEAN、TIMESTAMP（微秒/纳秒）、DOUBLE/LONG 数组、DECIMAL64/128/256
- **同步确认模型**：`flush()` 在服务器确认（ACK）后返回，单次 flush = 服务器单事务
- **写入结果显式化**：ACK 超时/连接断会抛 `QwpError`（`delivery: 'unknown'`），未确认的帧会保留，不再静默丢失
- **可选幂等重发**：`resend_on_unknown=on` 时换新建连、按原帧重放一次（要求所有目标表使用 `DEDUP UPSERT KEYS(ts)`）
- **自动 flush**：`auto_flush_rows`（默认 1000）/ `auto_flush_interval`（默认 1000ms）
- **认证**：Basic（`username`+`password`）或 Bearer（`token`）在 WebSocket 升级握手时发送
- **有序缓冲**：flush 串行化 + 发送期间表缓冲替换，高负载下不丢行、不重复

## 安装

```bash
bun add questdb-qwp-bunclient
```

或直接以源码方式使用（本仓库）：

```bash
bun install
bun test ./test        # 运行全部测试
bunx tsc --noEmit      # 类型检查
```

集成测试（`test/sender.integration.test.ts`）需要本机 QuestDB（默认 `localhost:9000`）。
无 QuestDB 时这些用例会自动跳过。

## 基本用法

```typescript
import { Sender } from "questdb-qwp-bunclient";

async function run() {
  // 使用 ws 协议创建 Sender（QWP over WebSocket）
  const sender = await Sender.fromConfig("ws::addr=127.0.0.1:9000");

  // 向 Sender 的缓冲中添加行
  await sender
    .table("trades")
    .symbol("symbol", "BTC-USD")
    .symbol("side", "sell")
    .floatColumn("price", 39269.98)
    .floatColumn("amount", 0.011)
    .at(Date.now(), "ms");

  // flush 缓冲，将数据发送到 QuestDB
  // 数据发送后缓冲被清空，Sender 可继续接受新数据
  await sender.flush();

  // 关闭连接（未 flush 的数据将丢失）
  await sender.close();
}

run().then(console.log).catch(console.error);
```

## 认证

#### 用户名密码认证（Basic）

```typescript
import { Sender } from "questdb-qwp-bunclient";

async function run() {
  const USER = "admin";
  const PWD = "quest";

  // 认证信息在 WebSocket 升级握手时通过 Authorization: Basic 头发送
  // 安全连接使用 'wss' 协议而非 'ws'
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

#### Bearer token 认证

```typescript
import { Sender } from "questdb-qwp-bunclient";

async function run() {
  const TOKEN = "Xyvd3er6GF87ysaHk";

  // 认证信息在 WebSocket 升级握手时通过 Authorization: Bearer 头发送
  // 注意：token 认证仅 QuestDB 企业版支持
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

## 数组列

```typescript
import { Sender } from "questdb-qwp-bunclient";

async function run() {
  const sender = await Sender.fromConfig("ws::addr=localhost:9000");

  // 待摄入的订单簿快照
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

## DECIMAL 列

QuestDB 支持 `DECIMAL` 数据类型，可通过 `decimalColumnText`（文本）或 `decimalColumn`（二进制）摄入。

#### 文本表示

```typescript
import { Sender } from "questdb-qwp-bunclient";

async function runDecimals() {
  const sender = await Sender.fromConfig("ws::addr=127.0.0.1:9000");

  await sender
    .table("fx")
    // 文本形式保留字面量和精确的小数位数
    .decimalColumnText("mid", "1.234500")
    .atNow();

  await sender.flush();
  await sender.close();
}

runDecimals().catch(console.error);
```

#### 二进制表示

推荐使用二进制表示，可获得更好的摄入性能和更小的负载（对大数值尤为明显）。

```typescript
import { Sender } from "questdb-qwp-bunclient";

async function runDecimals() {
  const sender = await Sender.fromConfig("ws::addr=127.0.0.1:9000");

  await sender
    .table("fx")
    // 十进制数值以二进制形式发送
    // 123.456 = 123456 * 10^-3
    .decimalColumn("mid", 123456n, 3)
    .atNow();

  await sender.flush();
  await sender.close();
}

runDecimals().catch(console.error);
```

## 显式时间戳

```typescript
import { Sender } from "questdb-qwp-bunclient";

async function run() {
  const sender = await Sender.fromConfig("ws::addr=localhost:9000");

  // 纳秒时间戳（TIMESTAMP_NS 列，范围 1677-2262 年）
  await sender
    .table("events")
    .stringColumn("name", "startup")
    .at(1658484765000000000n, "ns");

  // 毫秒时间戳（TIMESTAMP 列，微秒精度，范围可超过 2262 年）
  await sender
    .table("events")
    .stringColumn("name", "ingest")
    .at(Date.now(), "ms");

  await sender.flush();
  await sender.close();
}

run().catch(console.error);
```

## 写入结果与重发

ACK 超时不等于写入失败：服务器可能已经提交了该帧，只是回执没有按时到达。客户端因此把
`QwpError` 的结果分成三类：

| `delivery` | 含义 | 能否重试 |
|------------|------|----------|
| `not_sent` | 帧没有到达服务器（例如建连失败） | 总是可以 |
| `rejected` | 服务器返回错误状态，看 `status` / `retryable` | 仅 `retryable=true` |
| `unknown` | 帧已发出但没收到 ACK，可能已提交也可能没有 | 仅在表使用 DEDUP 时 |

`unknown` 时客户端会保留原帧。下一次 `flush()`（或 `retryPending()`）会先按原字节重放它，
再发送新行，不会静默丢数据。

```typescript
import { Sender, QwpError } from "questdb-qwp-bunclient";

const sender = await Sender.fromConfig(
  // resend_on_unknown=on 表示目标表使用 DEDUP UPSERT KEYS(ts)，重放是幂等的
  "ws::addr=127.0.0.1:9000;auto_flush=off;ack_timeout=15000;resend_on_unknown=on",
);

try {
  // 可选总预算，重连重放也计入
  await sender.flush(20_000);
} catch (error) {
  if (error instanceof QwpError && error.delivery === "unknown") {
    // 数据已保留；稍后重试或显式丢弃
    // await sender.retryPending();
    // await sender.discardPending();
  }
}
```

重发默认关闭，因为客户端无法校验表结构；没有 `DEDUP UPSERT KEYS(ts)` 时重放可能重复写入。
确定性错误（`SCHEMA_MISMATCH`、`PARSE_ERROR`、`SECURITY_ERROR` 等）不会重发；
`NOT_WRITABLE`、`DICTIONARY_GAP` 属于安全可重试的拒绝，即使未开启 `resend_on_unknown`
也会重放一次。

## 配置选项

格式：`protocol::key=value;key=value;`（解析规则与 nodejs 客户端一致：key 大小写敏感、
`;;` 转义分号、布尔只接受 `on`/`off`、数值必须为整数）。

| key | 说明 | 默认值 |
|-----|------|--------|
| `protocol` | `ws`（明文）或 `wss`（TLS），必填 | - |
| `addr` | `host:port`，必填；端口省略时默认 9000 | 9000 |
| `username` / `password` | Basic 认证 | - |
| `token` | Bearer 认证（仅企业版） | - |
| `auto_flush` | `on` / `off` | `on` |
| `auto_flush_rows` | 行数触发 flush，0 禁用 | 1000 |
| `auto_flush_interval` | 毫秒触发 flush，0 禁用 | 1000 |
| `request_timeout` | 连接与 ACK 等待超时（ms） | 10000 |
| `ack_timeout` | 仅覆盖 ACK 等待超时（ms） | 同 `request_timeout` |
| `resend_on_unknown` | `on` / `off`；ACK 超时后换连接按原帧重放一次（要求表 DEDUP） | `off` |
| `replay_backoff_ms` | 重连后到重放之间的等待（ms） | 100 |
| `stale_retries` | 某表 ACK 的 `seqTxn` 未前进时的重试次数 | 3 |
| `init_buf_size` / `max_buf_size` | 缓冲尺寸（兼容选项） | 64KiB / 100MiB |
| `max_name_len` | 表名/列名最大长度 | 127 |
| `tls_verify` / `tls_ca` | 解析兼容；Bun WebSocket 暂不支持自定义 CA | - |

## 架构

```
src/
├── index.ts          # 公共导出（与 nodejs 客户端对齐）
├── sender.ts         # Sender：行构建 API、auto-flush、flush 串行化
├── options.ts        # 配置字符串解析（nodejs 规则 + ws/wss）
├── utils.ts          # 工具函数（isInteger/timestampToMicros/bigintToTwosComplementBytes 等）
├── logging.ts        # Logger
├── validation.ts     # 表名/列名校验
└── qwp/
    ├── constants.ts  # QWP 协议常量（类型码/flags/status）
    ├── varint.ts     # LEB128 + ByteWriter/ByteReader
    ├── symboldict.ts # 全局符号字典
    ├── tablebuffer.ts# 列式表缓冲（行提交/null 填充）
    ├── encoder.ts    # QWP 消息编码
    ├── decoder.ts    # 服务器响应解码（OK/error）
    ├── errors.ts     # QwpError：code / delivery / retryable / status
    └── transport.ts  # Bun WebSocket 传输（握手/发送/ACK 匹配）
```

## 与 nodejs 客户端的差异

- **协议**：nodejs 客户端使用 ILP（HTTP/TCP）；本项目使用 QWP（WebSocket）
- **协议标识**：新增 `ws`/`wss`；`http`/`https`/`tcp`/`tcps` 不被接受
- **协议版本**：QWP 仅支持 v1，`protocol_version` 恒为 `1`
- **类型映射**：`stringColumn`→VARCHAR、`intColumn`→LONG、`floatColumn`→DOUBLE、
  `timestampColumn(unit="ns")`→TIMESTAMP_NS，其余方法类型码一一对应
- **限制**：Bun WebSocket 客户端无法配置自定义 CA 或禁用证书校验（`tls_ca`/`tls_verify`
  仅为配置兼容保留）；握手响应头（`X-QWP-Version`/`X-QWP-Max-Batch-Size`）不可读，
  字节预算使用本地默认值

## 测试

| 文件 | 内容 | 依赖 |
|------|------|------|
| `options.test.ts` | 配置字符串解析（30 例） | 无 |
| `sender.config.test.ts` | Sender 构造校验（21 例） | 无 |
| `sender.buffer.test.ts` | QWP 编码字节断言 + 行构建校验（28 例） | 无 |
| `sender.transport.test.ts` | 握手/认证/ACK/错误处理（12 例，mock WS 服务器） | 无 |
| `sender.delivery.test.ts` | 写入结果、数据保留、重放与 deadline（13 例，mock WS 服务器） | 无 |
| `logging.test.ts` | 默认日志（5 例） | 无 |
| `utils.decimal.test.ts` | 补码编码（4 例） | 无 |
| `sender.integration.test.ts` | 本机 QuestDB 端到端（9 例） | QuestDB |

> 与 nodejs 客户端的测试关系：与协议无关的测试（配置解析、构造校验、日志、工具函数）
> 原样移植；ILP 专属的字节断言改写为 QWP 编码断言；TCP/HTTP 传输测试改写为
> mock WebSocket 服务器测试；TestContainers 集成测试改写为本机 QuestDB。

## 许可证

[Apache-2.0](LICENSE)。实现参考了 [questdb/java-questdb-client](https://github.com/questdb/java-questdb-client)
与 [questdb/nodejs-questdb-client](https://github.com/questdb/nodejs-questdb-client)。
