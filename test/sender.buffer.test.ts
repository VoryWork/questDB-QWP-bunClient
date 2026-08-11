// @ts-check
import { describe, it, expect } from "bun:test";

import { Sender } from "../src";
import { SenderOptions } from "../src/options";
import { QwpEncoder } from "../src/qwp/encoder";
import { QwpTableBuffer } from "../src/qwp/tablebuffer";
import { GlobalSymbolDictionary } from "../src/qwp/symboldict";
import {
  TYPE_BOOLEAN,
  TYPE_DOUBLE,
  TYPE_DOUBLE_ARRAY,
  TYPE_LONG,
  TYPE_SYMBOL,
  TYPE_TIMESTAMP,
  TYPE_VARCHAR,
} from "../src/qwp/constants";

function makeEncoder(dict: GlobalSymbolDictionary = new GlobalSymbolDictionary()) {
  return new QwpEncoder(dict, 0); // no delta dictionary, self-contained layout
}

function hex(frame: Uint8Array): string {
  return Array.from(frame)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
}

describe("Sender message builder test suite", function () {
  it("throws if the table name is not a string", function () {
    const sender = new Sender(new SenderOptions("ws::addr=host"));
    // @ts-expect-error - Testing invalid input
    expect(() => sender.table(123)).toThrow("Table name must be a string");
  });

  it("throws on an empty table name", function () {
    const sender = new Sender(new SenderOptions("ws::addr=host"));
    expect(() => sender.table("")).toThrow(
      "Empty string is not allowed as table name",
    );
  });

  it("throws if the table name is too long", function () {
    const sender = new Sender(new SenderOptions("ws::addr=host"));
    expect(() => sender.table("a".repeat(128))).toThrow(
      "Table name is too long, max length is 127",
    );
  });

  it("throws if the table name has already been set", function () {
    const sender = new Sender(new SenderOptions("ws::addr=host"));
    sender.table("t1");
    expect(() => sender.table("t2")).toThrow("Table name has already been set");
  });

  it("throws on an empty column name", function () {
    const sender = new Sender(new SenderOptions("ws::addr=host"));
    sender.table("t1");
    expect(() => sender.stringColumn("", "v")).toThrow(
      "Empty string is not allowed as column name",
    );
  });

  it("throws if the column name is too long", function () {
    const sender = new Sender(new SenderOptions("ws::addr=host"));
    sender.table("t1");
    expect(() => sender.intColumn("a".repeat(128), 1)).toThrow(
      "Column name is too long, max length is 127",
    );
  });

  it("throws if a column is added before the table name is set", function () {
    const sender = new Sender(new SenderOptions("ws::addr=host"));
    expect(() => sender.intColumn("x", 1)).toThrow(
      "Column can be set only after table name is set",
    );
  });

  it("throws if a symbol is added after a column of the same row", function () {
    const sender = new Sender(new SenderOptions("ws::addr=host"));
    sender.table("t1").intColumn("x", 1);
    expect(() => sender.symbol("host", "h1")).toThrow(
      "Symbol can be added only after table name is set and before any column added",
    );
  });

  it("throws if a column is set twice in the same row", function () {
    const sender = new Sender(new SenderOptions("ws::addr=host"));
    sender.table("t1").intColumn("x", 1);
    expect(() => sender.intColumn("x", 2)).toThrow(
      "Column 'x' has already been set for the current row",
    );
  });

  it("throws if the row has no values when closed", async function () {
    const sender = await Sender.fromConfig("ws::addr=host;auto_flush=off");
    sender.table("t1");
    await expect(sender.atNow()).rejects.toThrow(
      "The row must have a symbol or column set before it is closed",
    );
    await sender.close();
  });

  it("throws on an invalid timestamp unit", function () {
    const sender = new Sender(new SenderOptions("ws::addr=host"));
    sender.table("t1");
    // @ts-expect-error - Testing invalid input
    expect(() => sender.timestampColumn("ts", 1n, "foobar")).toThrow(
      "Unknown timestamp unit: foobar",
    );
  });

  it("throws if a nanosecond timestamp is not a BigInt", function () {
    const sender = new Sender(new SenderOptions("ws::addr=host"));
    sender.table("t1");
    expect(() => sender.timestampColumn("ts", 123, "ns")).toThrow(
      "Timestamp value must be a BigInt if it is set in nanoseconds",
    );
  });

  it("throws if the int column value is not an integer", function () {
    const sender = new Sender(new SenderOptions("ws::addr=host"));
    sender.table("t1");
    expect(() => sender.intColumn("x", 1.5)).toThrow(
      "Value must be an integer",
    );
  });

  it("throws if the array is not an array", function () {
    const sender = new Sender(new SenderOptions("ws::addr=host"));
    sender.table("t1");
    // @ts-expect-error - Testing invalid input
    expect(() => sender.arrayColumn("a", 42)).toThrow(
      "The value must be an array",
    );
  });

  it("throws on irregularly sized sub-arrays", function () {
    const sender = new Sender(new SenderOptions("ws::addr=host"));
    sender.table("t1");
    expect(() =>
      sender.arrayColumn("a", [
        [1, 2],
        [1],
      ]),
    ).toThrow("Lengths of sub-arrays do not match");
  });

  it("throws on non-homogenous arrays", function () {
    const sender = new Sender(new SenderOptions("ws::addr=host"));
    sender.table("t1");
    expect(() => sender.arrayColumn("a", [1, "two"])).toThrow(
      "Mixed types found",
    );
  });

  it("throws on unsupported decimal scale", function () {
    const sender = new Sender(new SenderOptions("ws::addr=host"));
    sender.table("t1");
    expect(() => sender.decimalColumn("d", 12345n, 77)).toThrow(
      "Scale must be between 0 and 76",
    );
  });

  it("throws if the unscaled decimal value is too long", function () {
    const sender = new Sender(new SenderOptions("ws::addr=host"));
    sender.table("t1");
    expect(() =>
      sender.decimalColumn("d", 1n << 300n, 2),
    ).toThrow("Unscaled value length must be between 0 and 32 bytes");
  });
});

describe("QWP encoder test suite", function () {
  it("encodes a LONG column as little-endian int64 values", function () {
    const table = new QwpTableBuffer("sensors");
    table.addValue("id", TYPE_LONG, 1n);
    table.commitRow();
    table.addValue("id", TYPE_LONG, 2n);
    table.commitRow();

    const frame = makeEncoder().encode([table]);
    // header: QWP1 01 00 01 00 [len]
    expect(hex(frame.subarray(0, 8))).toBe("51 57 50 31 01 00 01 00");
    // table name "sensors", rowCount=2, colCount=1
    expect(hex(frame.subarray(12, 20))).toBe("07 73 65 6e 73 6f 72 73");
    expect(frame[20]).toBe(2); // rowCount
    expect(frame[21]).toBe(1); // columnCount
    // column "id" LONG: 02 69 64 05
    expect(hex(frame.subarray(22, 26))).toBe("02 69 64 05");
    // data: null flag 0, 1, 2 as int64 LE
    expect(frame[26]).toBe(0);
    expect(hex(frame.subarray(27, 35))).toBe("01 00 00 00 00 00 00 00");
    expect(hex(frame.subarray(35, 43))).toBe("02 00 00 00 00 00 00 00");
  });

  it("encodes a DOUBLE column as little-endian float64 values", function () {
    const table = new QwpTableBuffer("sensors");
    table.addValue("value", TYPE_DOUBLE, 1.3);
    table.commitRow();
    table.addValue("value", TYPE_DOUBLE, 2.2);
    table.commitRow();

    const frame = makeEncoder().encode([table]);
    // data: null flag 0, then 1.3 and 2.2 as IEEE-754 LE
    // header(12) + "sensors"(8) + rowCount(1) + colCount(1) + "value"(6) + type(1) = 29
    expect(frame[29]).toBe(0);
    expect(hex(frame.subarray(30, 38))).toBe("cd cc cc cc cc cc f4 3f");
    expect(hex(frame.subarray(38, 46))).toBe("9a 99 99 99 99 99 01 40");
  });

  it("encodes a BOOLEAN column as a packed bitstream", function () {
    const table = new QwpTableBuffer("t");
    for (const value of [true, false, true, true, false]) {
      table.addValue("b", TYPE_BOOLEAN, value);
      table.commitRow();
    }
    const frame = makeEncoder().encode([table]);
    // find the boolean column data: after header (12) + name "t" (2) +
    // rowCount (1) + colCount (1) + colName "b" (2) + type (1)
    const dataStart = 12 + 2 + 1 + 1 + 2 + 1;
    expect(frame[dataStart]).toBe(0); // null flag
    expect(frame[dataStart + 1]).toBe(0b01101); // bits LSB-first: t,f,t,t,f
  });

  it("encodes a VARCHAR column with an offset array", function () {
    const table = new QwpTableBuffer("t");
    table.addValue("s", TYPE_VARCHAR, "foo");
    table.commitRow();
    table.addValue("s", TYPE_VARCHAR, "bar");
    table.commitRow();
    table.addValue("s", TYPE_VARCHAR, "baz");
    table.commitRow();

    const frame = makeEncoder().encode([table]);
    const dataStart = 12 + 2 + 1 + 1 + 2 + 1;
    expect(frame[dataStart]).toBe(0); // null flag
    // offsets: 0, 3, 6, 9 as uint32 LE
    expect(hex(frame.subarray(dataStart + 1, dataStart + 17))).toBe(
      "00 00 00 00 03 00 00 00 06 00 00 00 09 00 00 00",
    );
    // data: "foo" "bar" "baz"
    expect(
      new TextDecoder().decode(frame.subarray(dataStart + 17, dataStart + 26)),
    ).toBe("foobarbaz");
  });

  it("encodes a SYMBOL column with global ids and the delta dictionary", function () {
    const dict = new GlobalSymbolDictionary();
    const table = new QwpTableBuffer("t");
    table.addValue("host", TYPE_SYMBOL, dict.getOrAddSymbol("server1"));
    table.commitRow();
    table.addValue("host", TYPE_SYMBOL, dict.getOrAddSymbol("server2"));
    table.commitRow();

    const encoder = new QwpEncoder(dict); // default: delta symbol dict flag
    const frame = encoder.encode([table]);
    // header flags = 0x08
    expect(frame[5]).toBe(0x08);
    // payload starts with the delta dictionary: deltaStart=0, deltaCount=2
    expect(frame[12]).toBe(0);
    expect(frame[13]).toBe(2);
    // "server1" (len 7), "server2" (len 7)
    expect(frame[14]).toBe(7);
    expect(new TextDecoder().decode(frame.subarray(15, 22))).toBe("server1");
    expect(frame[22]).toBe(7);
    expect(new TextDecoder().decode(frame.subarray(23, 30))).toBe("server2");
    // table block: "t"(2) + rowCount(1) + colCount(1) + "host"(5) + type(1)
    // column data starts at 12 + 18 (dict) + 10 (block) = 40
    expect(frame[40]).toBe(0); // null flag
    expect(frame[41]).toBe(0); // row 0: id 0
    expect(frame[42]).toBe(1); // row 1: id 1
  });

  it("encodes a TIMESTAMP column as microseconds since the epoch", function () {
    const table = new QwpTableBuffer("t");
    table.addValue("ts", TYPE_TIMESTAMP, 1_000_000n);
    table.commitRow();
    const frame = makeEncoder().encode([table]);
    const dataStart = 12 + 2 + 1 + 1 + 3 + 1;
    expect(frame[dataStart]).toBe(0);
    expect(hex(frame.subarray(dataStart + 1, dataStart + 9))).toBe(
      "40 42 0f 00 00 00 00 00",
    );
  });

  it("encodes NULLs with a null bitmap and omits their data", function () {
    const table = new QwpTableBuffer("t");
    table.addValue("x", TYPE_LONG, 1n);
    table.commitRow(); // row 0: 1
    table.addValue("x", TYPE_LONG, null); // row 1: NULL
    table.commitRow();
    table.addValue("x", TYPE_LONG, 3n);
    table.commitRow(); // row 2: 3

    const frame = makeEncoder().encode([table]);
    const dataStart = 12 + 2 + 1 + 1 + 2 + 1;
    expect(frame[dataStart]).toBe(1); // null bitmap present
    expect(frame[dataStart + 1]).toBe(0b00000010); // row 1 is NULL
    // only 1 and 3 are written
    expect(hex(frame.subarray(dataStart + 2, dataStart + 10))).toBe(
      "01 00 00 00 00 00 00 00",
    );
    expect(hex(frame.subarray(dataStart + 10, dataStart + 18))).toBe(
      "03 00 00 00 00 00 00 00",
    );
  });

  it("encodes a DOUBLE array column with its dimensions", function () {
    const table = new QwpTableBuffer("t");
    table.addValue("a", TYPE_DOUBLE_ARRAY, [
      [1, 2],
      [3, 4],
    ]);
    table.commitRow();
    const frame = makeEncoder().encode([table]);
    const dataStart = 12 + 2 + 1 + 1 + 2 + 1;
    expect(frame[dataStart]).toBe(0); // null flag
    expect(frame[dataStart + 1]).toBe(2); // nDims
    // dims: 2, 2 as int32 LE
    expect(hex(frame.subarray(dataStart + 2, dataStart + 10))).toBe(
      "02 00 00 00 02 00 00 00",
    );
    // values 1,2,3,4 as float64 LE
    expect(hex(frame.subarray(dataStart + 10, dataStart + 18))).toBe(
      "00 00 00 00 00 00 f0 3f",
    );
  });

  it("encodes multiple tables in one message", function () {
    const t1 = new QwpTableBuffer("t1");
    t1.addValue("x", TYPE_LONG, 1n);
    t1.commitRow();
    const t2 = new QwpTableBuffer("t2");
    t2.addValue("x", TYPE_LONG, 2n);
    t2.commitRow();

    const frame = makeEncoder().encode([t1, t2]);
    // tableCount = 2
    expect(new DataView(frame.buffer, 6, 2).getUint16(0, true)).toBe(2);
  });

  it("reports the payload length in the header", function () {
    const table = new QwpTableBuffer("t");
    table.addValue("x", TYPE_LONG, 1n);
    table.commitRow();
    const frame = makeEncoder().encode([table]);
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const payloadLength = view.getUint32(8, true);
    expect(payloadLength).toBe(frame.length - 12);
  });
});
