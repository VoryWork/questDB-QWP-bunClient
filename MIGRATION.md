# questdb-qwp-bunclient 迁移指南（iotSystem）

适用对象：`F:\Repo\iotSystem` 的 recordStore 写入链路维护者。

本文对应客户端新增的“写入结果显式化 + 保留重放”能力。**API 是增量的**，现有 `table()/at()/flush()/close()` 调用不需要改签名；但失败语义和错误类型变了，下游需要按本文逐步切换。

---

## 1. 这次升级解决了什么

生产上的 ack 超时是“结果未知”，不是“写入失败”：

- QWP 一帧可能已经在服务端提交，只是回执被 REST 读风暴排在 `request_timeout` 之后；
- 旧客户端在超时时直接抛 `Error`，并且把发送缓冲丢掉；
- 下游只能靠字符串匹配 `Timeout waiting for server acknowledgement`，再按 `QueuedWrite` 重新编码整批；
- executor 还会把普通 `Error` 当成不可恢复错误，把设备调度置为 `error`。

新版本把这三件事拆开：

| 层 | 旧行为 | 新行为 |
|----|--------|--------|
| transport | 超时抛普通 `Error` | 抛 `QwpError`，带 `code` / `delivery` / `retryable` |
| Sender | flush 失败即丢行 | 未确认帧**按原字节保留**，下次 flush 先重放 |
| 重试 | transport 完全不重试 | 可选 `resend_on_unknown=on`，换新建连重放一次 |
| durable ack | 被误判为拒绝 | 正确视为成功 |

关键前提（本仓库已确认）：`buildCreateTableSql` 生成的所有 rec 表都带
`DEDUP UPSERT KEYS(ts)`（`packages/host/src/recordStore/blockPlan.ts:348-361`），
因此同 ts 重放会被幂等折叠。

---

## 2. 升级依赖

下游目前按 commit 固定版本：

```json
// packages/host/package.json:54
"questdb-qwp-bunclient": "git+https://github.com/VoryWork/questDB-QWP-bunClient.git#543c20e3f7a86827eb10c3bb3f9c5a23d5dc0205"
```

把 hash 换成包含 `QwpError` 的新提交/标签，然后：

```bash
bun install
```

本次改动没有删除任何导出，旧代码可以直接编译通过。

---

## 3. 行为变化清单

| 场景 | 旧行为 | 新行为 | 下游需要做什么 |
|------|--------|--------|----------------|
| ack 超时 | `Error`，行已丢 | `QwpError(code=ACK_TIMEOUT, delivery=unknown, retryable=true)`，帧保留 | 删除字符串匹配和重新编码 |
| 连接断/建连失败 | `Error` | `QwpError(CONNECTION_*, delivery=unknown/not_sent)` | 同上 |
| schema/parse/security 拒绝 | `Error` | `QwpError(delivery=rejected, retryable=false)` | 可继续按“永久错误”处理 |
| NOT_WRITABLE(12) | `Error` | `QwpError(code=NOT_WRITABLE, retryable=true)` | 默认 delay |
| durable ack(2) | 误判为拒绝 | 成功 | 无需改动 |
| `flush()` | 无参数 | 可传总预算 `flush(deadlineMs?)` | 建议传调度剩余预算 |
| `close()` 时还有保留帧 | 无提示 | 打 warn，数据丢弃 | 不要用 close 来“清理”失败状态 |
| 新配置键 | 未知键报错 | 接受 `ack_timeout` / `resend_on_unknown` / `replay_backoff_ms` | 更新配置串 |

**最重要的一条**：`unknown` 时库会保留帧。此时如果你调用 `sender.close()`，保留帧会被丢弃；所以迁移后**不要**在传输层失败时 `resetSender`。

---

## 4. 推荐分三步迁移

### 第 1 步：只升级依赖，不改代码

目标：确认编译和现有行为不回归。

- 依赖 hash 更新，`bun install`；
- 暂不打开 `resend_on_unknown`；
- 现有 `isResendableTransportError` 和重新编码重试保留（仍然能工作）；
- 跑 `packages/host` 的测试。注意：`questdbStore.test.ts` 里注入的 `flushError` 是普通 `Error`，第 1 步仍然兼容。

这一步的行为差异只有两点：超时错误类型变成 `QwpError`（仍是 `Error` 子类，`message` 文案不变），以及 `close()` 可能多一条 warn。

### 第 2 步：把重放交给库，删掉下游的传输层重试

目标：删掉 `isResendableTransportError` 和整批重新 `encodeJob`。

#### 2.1 配置串

`packages/host/src/recordStore/questdb/store.ts` 的 `buildQwpSenderConfig` 改成：

```ts
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_ACK_TIMEOUT_MS = 8_000;
const REPLAY_BACKOFF_MS = 100;

export function buildQwpSenderConfig(
  endpoint: URL,
  creds: {
    user: string;
    password: string;
    requestTimeoutMs?: number; // 建连上限
    ackTimeoutMs?: number;     // 单次 ack 上限
  }
): string {
  const connectTimeout = creds.requestTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const ackTimeout = creds.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
  const wsProtocol = endpoint.protocol === "https:" ? "wss" : "ws";
  return (
    `${wsProtocol}::addr=${endpoint.hostname}:${endpoint.port}` +
    `;username=${creds.user};password=${creds.password}` +
    `;request_timeout=${connectTimeout};ack_timeout=${ackTimeout}` +
    `;resend_on_unknown=on;replay_backoff_ms=${REPLAY_BACKOFF_MS}` +
    `;auto_flush=off`
  );
}
```

建议同时加一个总预算配置，透传到 `flush()`：

```ts
const DEFAULT_FLUSH_DEADLINE_MS = 18_000;

// QuestDbStoreConfig 增加：
ackTimeoutMs?: number;
flushDeadlineMs?: number;
```

env 派生处（`packages/host/src/recordStore/index.ts:69-91`）增加：

```ts
const ackTimeout = Number(process.env.QUESTDB_ACK_TIMEOUT_MS);        // 默认 8000
const flushDeadlineMs = Number(process.env.QUESTDB_FLUSH_DEADLINE_MS); // 默认 18000
```

为什么是 8s / 18s：调度整体超时多数是 20s。旧配置 `ack_timeout=15s + 一次重放 15s = 30s`，第二次 ack 永远等不到。改成 8s 后，首次 8s + 退避 0.1s + 重放 8s ≈ 16.1s，给编码和 `verifyAcks` 留出余量。如果某类调度预算不是 20s，按 `ack_timeout ≈ (总预算 - 2s) / 2` 调整。

#### 2.2 flushBatch

删除 `isResendableTransportError`（`store.ts:66-75`）和 `flushBatch` 里的传输层重试分支（`store.ts:521-529`）。缺表自愈保留。

```ts
private async flushBatch(lane: WriteLane, batch: QueuedWrite[]): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const sender = await this.getSender(lane);
      for (const job of batch) await this.encodeJob(sender, job);
      // 总预算包含库内部的重连重放
      await sender.flush(this.flushDeadlineMs);
      for (const job of batch) job.resolve();
      return;
    } catch (error) {
      // 缺表自愈：保持不变
      const missingTables =
        attempt === 0
          ? batch.filter(
              (job) =>
                isMissingTableError(error) ||
                String((error as Error)?.message ?? "").includes(job.table)
            )
          : [];
      if (missingTables.length > 0) {
        await this.resetSender(lane, lane.sender);
        try {
          for (const job of missingTables) {
            this.knownTables.delete(job.table);
            await this.ensureTableWithPlan(job.table, job.plan, job.model, job.block);
          }
          continue;
        } catch (retryError) {
          for (const job of batch) job.reject(retryError);
          return;
        }
      }

      // 关键：unknown / not_sent / 可重试拒绝时，库还持有原帧。
      // 此时 close(Sender) 会把保留帧丢掉，所以不能 reset。
      const keepSender =
        error instanceof QwpError &&
        (error.delivery !== "rejected" || error.retryable);
      if (!keepSender) {
        await this.resetSender(lane, lane.sender);
      }
      for (const job of batch) job.reject(error);
      return;
    }
  }
}
```

这段的语义：

- 本次 `flush()` 失败，但原帧还在 Sender 里；
- 这一批的 `job` 仍然 reject 给调度（保持现有“本轮失败”语义）；
- lane 继续使用同一个 Sender，下一批 `flush()` 会**先重放**保留帧，再发新行；
- 只有确定性拒绝（schema/parse/security）才 reset，因为库已经把这种帧清掉了。

注意：`job.reject` 之后，这些行的数据仍然可能随后被库补发。调度侧看到的是 `delay`，下一轮采集会生成新的 ts；`DEDUP` 不会把“新 ts 的样本”和“补发的旧 ts 样本”折叠。如果业务不能接受补发，可以在 `unknown` 时先在同一预算内调用 `sender.retryPending(remaining)`，成功则 `job.resolve()`，见第 6 节。

### 第 3 步：错误分类改为读 QwpError

`packages/host/src/recordStore/index.ts` 的 `asRecordStoreError`（269-289 行）改成：

```ts
import { QwpError } from "questdb-qwp-bunclient";

export function asRecordStoreError(
  error: unknown,
  ctx: { op: string; model: string; deviceId: number },
  kind: RecordStoreOpKind = "write"
): Error {
  if (error instanceof EnhancedError) return error;
  const cause = error instanceof Error ? error : new Error(String(error));

  // 保守策略：QWP 错误一律 delay，绝不停设备。
  // 确定性 schema 问题先靠告警暴露，确认 DDL 自愈已覆盖后再考虑归 error。
  const permanent =
    !(error instanceof QwpError) &&
    PERMANENT_WRITE_ERROR_PATTERNS.some((re) => re.test(cause.message));

  const label = kind === "read" ? "记录读取失败" : "记录写入失败";
  return new EnhancedError(
    `${label} op=${ctx.op} model=${ctx.model} deviceId=${ctx.deviceId}: ${cause.message}`,
    {
      cause,
      scheduleAction: permanent ? "error" : "delay",
      noticeLevel: "warning",
      noticeType: kind === "read" ? "recordReadFail" : "recordWriteFail",
      title: label,
    }
  );
}
```

`maxDemandSampleRepo.ts:55,80` 已经走这个函数，不需要单独改。

如果后续要收紧，可按下面的映射，但**先确认缺表自愈已经跑过**：

| QwpError.code | 建议 scheduleAction |
|---------------|---------------------|
| `ACK_TIMEOUT` / `CONNECTION_CLOSED` / `CONNECTION_ERROR` / `CONNECT_FAILED` | `delay` |
| `WRITE_DEADLINE` / `STALE_TABLE` | `delay` |
| `NOT_WRITABLE` / `DICTIONARY_GAP` | `delay` |
| `SCHEMA_MISMATCH` / `PARSE_ERROR` / `SECURITY_ERROR` | 可考虑 `error`（配置/权限/类型问题） |
| `WRITE_ERROR` / `INTERNAL_ERROR` | `delay`（可能是磁盘/WAL 暂时不可用） |

---

## 5. 测试需要同步改的地方

### `packages/host/src/recordStore/__tests__/questdbStore.test.ts`

- `FakeSender` 注入处是 `as unknown as Sender`（`questdbStore.test.ts:158`），所以只传 `flush(deadline)` 不需要补类型。但如果你在 `flushBatch` 里用到了 `retryPending()` / `hasPendingWrite()` / `discardPending()`，FakeSender 需要补上对应方法：

```ts
hasPendingWrite() { return false; }
async retryPending() { return false; }
async discardPending() { return false; }
```

- 218-246 行那两个“ack 超时重发 / NOT_WRITABLE 重发”用例应当**删除**：重放已经是库的能力，由本仓库的 `test/sender.delivery.test.ts` 覆盖；下游只需要测试“unknown 时不 reset Sender”。
- `flushError` 的类型是 `Error | null`，`QwpError` 是 `Error` 子类，直接赋值即可。把字符串错误改成真实的 `QwpError`：

```ts
sender.flushError = new QwpError(
  "Timeout waiting for server acknowledgement [sequence=1]",
  { code: "ACK_TIMEOUT", delivery: "unknown", retryable: true }
);
```

### `packages/host/src/recordStore/__tests__/writeFailure.test.ts`

- 用 `QwpError` 替换字符串错误，断言 `scheduleAction === "delay"`；
- 保留原有“确定性业务错误 → error”的用例。

### 新增一个回归用例

```ts
it("unknown 失败时不 reset Sender，保留帧由库负责补发", async () => {
  // fake flush 抛 QwpError(ACK_TIMEOUT, delivery=unknown)
  // 断言 create() reject，但 lane.sender 未被 close，后续批次复用同一个 Sender
});
```

---

## 6. 可选的更严格方案：在调度预算内显式重试

如果业务不能接受“本轮 reject 但数据随后补发”，可以在 `flushBatch` 的 `unknown` 分支里，用剩余预算显式 `retryPending()`：

```ts
import { QwpError } from "questdb-qwp-bunclient";

const budget = this.flushDeadlineMs;
const started = Date.now();

try {
  await sender.flush(budget);
} catch (error) {
  if (
    error instanceof QwpError &&
    error.delivery === "unknown" &&
    Date.now() - started < budget
  ) {
    const remaining = Math.max(1, budget - (Date.now() - started));
    await sender.retryPending(remaining); // 成功即视为已提交
  }
  throw error;
}
```

这相当于把库内部“一次重放”的预算控制权交给下游。多数情况下不需要，默认的内部重放已经覆盖了假失败。

---

## 7. 灰度、观测与回滚

### 建议的灰度顺序

1. 单 lane 灰度：`QUESTDB_WRITE_LANES=1`，观察 30 分钟；
2. 单组织/小流量；
3. 全量。

### 需要观察的日志/指标

- `warn` 日志里的 `Replaying unacknowledged frame after ...`：库内部重放次数；
- `close()` 时的 `pending unacknowledged frame`：说明有帧在关闭时仍未确认；
- `QwpError` 按 `code` / `delivery` 聚合：区分“基础设施抖动”和“schema/权限问题”；
- 调度 `delay` 次数应下降，`status=error` 应不再由 QWP 错误触发；
- 重复行检查（DEDUP 生效）：按 `ts` 去重后的行数应与原始行数一致。

建议把 QWP 的 logger 常开（至少 `warn`），不要只在 `QUESTDB_QWP_DEBUG=1` 时挂 logger。下游当前的 `qwpDebugLogger()` 可以改成始终返回一个只上报 `warn/error` 的函数。

### 回滚

- 第 1→2 步之间：把 `resend_on_unknown` 改回 `off`，库退化为“保留原帧 + 下次 flush 重放”，但不再自动换连接重放；下游旧的重试代码如果还没删，可以继续工作。
- 第 2 步代码合并后：回滚该提交。
- 第 3 步只影响分类，可单独回滚。

建议把 `resend_on_unknown` 做成 env（例如 `QUESTDB_RESEND_ON_UNKNOWN`，默认 `1`），这样第 2 步之后仍能配置级回滚。

---

## 8. 限制与常见坑

1. **保留帧只在内存里**。进程崩溃/重启会丢；`close()` 会明确告警。这一版没有落盘队列。
2. **不要在 `unknown` 后调用 `sender.close()` 或 `resetSender()`**。那会丢弃保留帧，等于回到旧行为。只有确定性拒绝（`delivery=rejected && !retryable`）才 reset。
3. **`resend_on_unknown=on` 依赖 DEDUP**。任何新表类型都必须走 `buildCreateTableSql` 的 `DEDUP UPSERT KEYS(ts)`；否则重放可能双写。
4. **重放是整帧字节重放**，不是重新编码。符号字典是全量发送的，所以换连接重放是安全的。
5. **顺序**：保留帧永远先于新行发送；同一 Sender 内保序。
6. **错误文案保留**：`Server rejected the batch [...]`、`Timeout waiting for server acknowledgement [...]` 等文案没有变，旧的正则/字符串匹配在迁移期仍能命中，但它不再是契约；请改用 `code` / `delivery`。
7. **一个 lane 一个保留帧**：`drainLane` 单飞 + 库内只保留最后一个未确认帧，内存占用有界。但长期不可写时，保留帧会一直留在内存里直到重新连上或 `discardPending()`。
8. **`flush(deadlineMs)` 是总预算**，包括首次 ack、重连重放、`verifyAcks` 的逐表重发。不要把 `ack_timeout` 设成接近预算的值，否则重放没有时间片。

---

## 9. 最小改动清单（TL;DR）

- [ ] `packages/host/package.json`：升级 `questdb-qwp-bunclient` 的 git hash
- [ ] `buildQwpSenderConfig`：加 `ack_timeout=8000`、`resend_on_unknown=on`、`replay_backoff_ms=100`
- [ ] env：`QUESTDB_ACK_TIMEOUT_MS`、`QUESTDB_FLUSH_DEADLINE_MS`（`QUESTDB_RESEND_ON_UNKNOWN` 可选）
- [ ] `flushBatch`：删 `isResendableTransportError` 分支；`unknown/not_sent/可重试拒绝` 不 reset Sender；传 `flush(deadline)`
- [ ] `asRecordStoreError`：读 `QwpError`，QWP 错误默认 `delay`
- [ ] 测试：FakeSender 补方法；删除下游重发用例；新增“unknown 不 reset”回归
- [ ] 灰度观察 replay warn、QwpError 分布、DEDUP 去重行数
- [ ] 保留 `PERMANENT_WRITE_ERROR_PATTERNS` 作为业务级永久错误兜底
