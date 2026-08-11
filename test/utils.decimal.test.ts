import { describe, it, expect } from "bun:test";

import { bigintToTwosComplementBytes } from "../src/utils";

describe("bigintToTwosComplementBytes", () => {
  it("encodes zero as a single zero byte", () => {
    expect(bigintToTwosComplementBytes(0n)).toEqual([0]);
  });

  it("encodes positive values without unnecessary sign-extension", () => {
    expect(bigintToTwosComplementBytes(1n)).toEqual([1]);
    expect(bigintToTwosComplementBytes(123456n)).toEqual([1, 0xe2, 0x40]);
  });

  it("adds a leading zero when the positive sign bit would be set", () => {
    expect(bigintToTwosComplementBytes(255n)).toEqual([0, 0xff]);
  });

  it("encodes negative values with two's complement sign extension", () => {
    expect(bigintToTwosComplementBytes(-1n)).toEqual([0xff]);
    expect(bigintToTwosComplementBytes(-10n)).toEqual([0xff, 0xf6]);
    expect(bigintToTwosComplementBytes(-256n)).toEqual([0xff, 0x00]);
  });
});
