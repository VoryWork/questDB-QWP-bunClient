// @ts-check
import { describe, it, expect, beforeAll, afterAll } from "bun:test";

import { Sender } from "../src";

const QDB_HTTP_PORT = Number(process.env.QDB_HTTP_PORT ?? 9000);
const QDB_WS_PORT = Number(process.env.QDB_WS_PORT ?? 9000);
const BASE_URL = `http://localhost:${QDB_HTTP_PORT}`;

let available = false;

async function qdbAvailable(): Promise<boolean> {
  try {
    const response = await fetch(`${BASE_URL}/exec?query=select%201`, {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Runs a SQL query against the local QuestDB instance. */
async function runSelect<T>(query: string): Promise<T[]> {
  const response = await fetch(
    `${BASE_URL}/exec?query=${encodeURIComponent(query)}`,
  );
  const json = (await response.json()) as {
    columns: { name: string; type: string }[];
    dataset: T[][];
  };
  return json.dataset.map((row) => {
    const record = {} as Record<string, unknown>;
    json.columns.forEach((column, i) => {
      record[column.name] = row[i];
    });
    return record as T;
  });
}

/** Polls until the row count of a table reaches the expected value. */
async function waitForCount(
  table: string,
  expected: number,
  timeoutMs = 15_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let count = -1;
  while (Date.now() < deadline) {
    try {
      const rows = await runSelect<{ c: number }>(
        `select count(*) c from "${table}"`,
      );
      count = Number(rows[0]?.c ?? 0);
      if (count >= expected) {
        return count;
      }
    } catch {
      // server may be mid-restart; keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return count;
}

async function dropTable(name: string): Promise<void> {
  try {
    await fetch(
      `${BASE_URL}/exec?query=${encodeURIComponent(`drop table if exists "${name}"`)}`,
    );
  } catch {
    // ignore
  }
}

async function createTable(
  name: string,
  ddl: string,
): Promise<void> {
  const response = await fetch(
    `${BASE_URL}/exec?query=${encodeURIComponent(ddl)}`,
  );
  const json = (await response.json()) as { error?: string };
  if (!response.ok || json.error) {
    throw new Error(
      `Failed to create table: ${json.error ?? await response.text()}`,
    );
  }
}

describe("Sender tests with a local QuestDB instance", function () {
  beforeAll(async () => {
    available = await qdbAvailable();
    if (!available) {
      console.warn(
        `QuestDB not reachable at ${BASE_URL}; integration tests will be skipped`,
      );
    }
  });

  afterAll(async () => {
    // no-op; tables are dropped per test
  });

  it("can ingest data via ws and run queries", async () => {
    if (!available) return;
    const table = "bun_integ_basic";
    await dropTable(table);
    const sender = await Sender.fromConfig(
      `ws::addr=localhost:${QDB_WS_PORT};auto_flush=off`,
    );

    for (let i = 0; i < 10; i++) {
      sender
        .table(table)
        .symbol("host", `server-${i % 2}`)
        .stringColumn("location", `dc-${i}`)
        .intColumn("value", i * 10)
        .floatColumn("temperature", 20.5 + i)
        .booleanColumn("active", i % 2 === 0)
        .atNow();
    }
    expect(await sender.flush()).toBe(true);
    await sender.close();

    expect(await waitForCount(table, 10)).toBe(10);
    const rows = await runSelect<{
      host: string;
      location: string;
      value: number;
      temperature: number;
      active: boolean;
    }>(`select host, location, value, temperature, active from "${table}" order by value`);
    expect(rows).toHaveLength(10);
    expect(rows[0]!.host).toBe("server-0");
    expect(rows[0]!.location).toBe("dc-0");
    expect(rows[0]!.value).toBe(0);
    expect(rows[0]!.temperature).toBeCloseTo(20.5);
    expect(rows[0]!.active).toBe(true);
    expect(rows[9]!.value).toBe(90);
    expect(rows[9]!.active).toBe(false);
    await dropTable(table);
  });

  it("can ingest data with explicit timestamps", async () => {
    if (!available) return;
    const table = "bun_integ_ts";
    await dropTable(table);
    const sender = await Sender.fromConfig(
      `ws::addr=localhost:${QDB_WS_PORT};auto_flush=off`,
    );

    const base = 1_650_000_000_000_000_000n; // ns
    for (let i = 0; i < 3; i++) {
      sender
        .table(table)
        .intColumn("value", i)
        .at(base + BigInt(i) * 1_000_000_000n, "ns");
    }
    await sender.flush();
    await sender.close();

    expect(await waitForCount(table, 3)).toBe(3);
    const rows = await runSelect<{ value: number; ts: string }>(
      `select value, timestamp ts from "${table}" order by value`,
    );
    expect(rows[0]!.value).toBe(0);
    expect(rows[2]!.value).toBe(2);
    await dropTable(table);
  });

  it("can ingest data with auto flush rows", async () => {
    if (!available) return;
    const table = "bun_integ_autoflush";
    await dropTable(table);
    const sender = await Sender.fromConfig(
      `ws::addr=localhost:${QDB_WS_PORT};auto_flush_rows=1`,
    );

    for (let i = 0; i < 5; i++) {
      sender.table(table).intColumn("value", i).atNow();
    }
    await sender.close();

    expect(await waitForCount(table, 5)).toBe(5);
    await dropTable(table);
  });

  it("can ingest data with auto flush interval", async () => {
    if (!available) return;
    const table = "bun_integ_interval";
    await dropTable(table);
    const sender = await Sender.fromConfig(
      `ws::addr=localhost:${QDB_WS_PORT};auto_flush_interval=1`,
    );

    for (let i = 0; i < 5; i++) {
      sender.table(table).intColumn("value", i).atNow();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await sender.close();

    expect(await waitForCount(table, 5)).toBe(5);
    await dropTable(table);
  });

  it("can ingest array columns", async () => {
    if (!available) return;
    const table = "bun_integ_array";
    await dropTable(table);
    const sender = await Sender.fromConfig(
      `ws::addr=localhost:${QDB_WS_PORT};auto_flush=off`,
    );

    sender.table(table).arrayColumn("vec", [1.5, 2.5, 3.5]).atNow();
    sender.table(table).arrayColumn("vec", [4.0, 5.0]).atNow();
    await sender.flush();
    await sender.close();

    expect(await waitForCount(table, 2)).toBe(2);
    const rows = await runSelect<{ vec: number[] }>(
      `select vec from "${table}"`,
    );
    const vectors = rows.map((row) => row.vec).sort((a, b) => a[0]! - b[0]!);
    expect(vectors[0]).toEqual([1.5, 2.5, 3.5]);
    expect(vectors[1]).toEqual([4.0, 5.0]);
    await dropTable(table);
  });

  it("can ingest NULL values", async () => {
    if (!available) return;
    const table = "bun_integ_null";
    await dropTable(table);
    const sender = await Sender.fromConfig(
      `ws::addr=localhost:${QDB_WS_PORT};auto_flush=off`,
    );

    sender.table(table).intColumn("value", 1).stringColumn("note", "a").atNow();
    // second row omits "note": it must be null
    sender.table(table).intColumn("value", 2).atNow();
    await sender.flush();
    await sender.close();

    expect(await waitForCount(table, 2)).toBe(2);
    const rows = await runSelect<{ value: number; note: string | null }>(
      `select value, note from "${table}" order by value`,
    );
    expect(rows[0]!.note).toBe("a");
    expect(rows[1]!.note).toBeNull();
    await dropTable(table);
  });

  it("can ingest decimal columns", async () => {
    if (!available) return;
    const table = "bun_integ_decimal";
    await dropTable(table);
    const sender = await Sender.fromConfig(
      `ws::addr=localhost:${QDB_WS_PORT};auto_flush=off`,
    );

    sender.table(table).decimalColumn("amount", 12345n, 2).atNow();
    sender.table(table).decimalColumn("amount", -425n, 1).atNow();
    await sender.flush();
    await sender.close();

    expect(await waitForCount(table, 2)).toBe(2);
    const rows = await runSelect<{ amount: string }>(
      `select amount from "${table}" order by amount`,
    );
    expect(rows).toHaveLength(2);
    await dropTable(table);
  });

  it("can ingest multiple tables in a single message", async () => {
    if (!available) return;
    const tableA = "bun_integ_multi_a";
    const tableB = "bun_integ_multi_b";
    await dropTable(tableA);
    await dropTable(tableB);
    const sender = await Sender.fromConfig(
      `ws::addr=localhost:${QDB_WS_PORT};auto_flush=off`,
    );

    sender.table(tableA).intColumn("value", 1).atNow();
    sender.table(tableB).stringColumn("name", "x").atNow();
    sender.table(tableA).intColumn("value", 2).atNow();
    await sender.flush();
    await sender.close();

    expect(await waitForCount(tableA, 2)).toBe(2);
    expect(await waitForCount(tableB, 1)).toBe(1);
    await dropTable(tableA);
    await dropTable(tableB);
  });

  it("recovers silently swallowed writes after a table is dropped and recreated via REST", async () => {
    if (!available) return;
    const table = "bun_integ_stale_recreate";
    await dropTable(table);
    const sender = await Sender.fromConfig(
      `ws::addr=localhost:${QDB_WS_PORT};auto_flush=off`,
    );

    sender
      .table(table)
      .symbol("device_id", "d1")
      .intColumn("value", 1)
      .at(1_000_000n, "us");
    expect(await sender.flush()).toBe(true);

    // Drop and recreate the table with the same schema while the same QWP
    // connection stays open. The server's per-connection writer cache goes
    // stale and silently drops the next one or two frames.
    await dropTable(table);
    await createTable(
      table,
      `create table "${table}" (ts timestamp, device_id symbol, value int) ` +
        `timestamp(ts) partition by day dedup upsert keys(ts, device_id)`,
    );

    sender
      .table(table)
      .symbol("device_id", "d1")
      .intColumn("value", 2)
      .at(2_000_000n, "us");
    sender
      .table(table)
      .symbol("device_id", "d1")
      .intColumn("value", 3)
      .at(3_000_000n, "us");
    expect(await sender.flush()).toBe(true);
    await sender.close();

    // the client re-sends the swallowed rows; dedup keeps retries idempotent
    expect(await waitForCount(table, 2, 20_000)).toBe(2);
    await dropTable(table);
  }, 30_000);

  it("recovers silently swallowed writes after a table is dropped and recreated by QWP", async () => {
    if (!available) return;
    const table = "bun_integ_stale_auto";
    await dropTable(table);
    const sender = await Sender.fromConfig(
      `ws::addr=localhost:${QDB_WS_PORT};auto_flush=off`,
    );

    sender
      .table(table)
      .symbol("device_id", "d1")
      .intColumn("value", 1)
      .at(1_000_000n, "us");
    expect(await sender.flush()).toBe(true);
    await dropTable(table);

    // the next write lets QWP auto-create the table on the same connection
    sender
      .table(table)
      .symbol("device_id", "d1")
      .intColumn("value", 2)
      .at(2_000_000n, "us");
    sender
      .table(table)
      .symbol("device_id", "d1")
      .intColumn("value", 3)
      .at(3_000_000n, "us");
    expect(await sender.flush()).toBe(true);
    await sender.close();

    // QWP auto-created tables have no dedup keys, so the retried frame may
    // insert duplicates; the required property is that no row is lost.
    expect(await waitForCount(table, 2, 20_000)).toBeGreaterThanOrEqual(2);
    const values = await runSelect<{ value: number }>(
      `select value from "${table}"`,
    );
    const seen = new Set(values.map((row) => row.value));
    expect(seen.has(2)).toBe(true);
    expect(seen.has(3)).toBe(true);
    await dropTable(table);
  }, 30_000);

  it("ingests all data without loss under high load with auto-flush", async () => {
    if (!available) return;
    const table = "bun_integ_highload";
    await dropTable(table);
    const sender = await Sender.fromConfig(
      `ws::addr=localhost:${QDB_WS_PORT};auto_flush_rows=5;auto_flush_interval=1`,
    );

    for (let i = 0; i < 1000; i++) {
      sender.table(table).intColumn("value", i).atNow();
      if (i % 100 === 0) {
        // allow the event loop to process acks
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    }
    await sender.close();

    expect(await waitForCount(table, 1000, 30_000)).toBe(1000);
    await dropTable(table);
  });
});
