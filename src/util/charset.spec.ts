import { decodeText, isTextCharset } from "./charset";

describe("decodeText (SPEC §8, X16)", () => {
  it("decodes UTF-8 (dropping a BOM) and Windows-1251", () => {
    expect(decodeText(Buffer.from("﻿Иван;BY", "utf8"), "utf-8")).toBe("Иван;BY");
    // "Иван Ўс" in Windows-1251.
    const cp1251 = Buffer.from([0xc8, 0xe2, 0xe0, 0xed, 0x20, 0xa1, 0xf1]);
    expect(decodeText(cp1251, "windows-1251")).toBe("Иван Ўс");
  });

  it("refuses invalid UTF-8 (fatal) and an unknown charset", () => {
    expect(() => decodeText(Buffer.from([0xc8, 0xe2, 0xe0]), "utf-8")).toThrow(/not valid utf-8/);
    expect(() => decodeText(Buffer.from("x"), "koi8-r" as never)).toThrow(/charset must be one of/);
    expect(isTextCharset("windows-1251")).toBe(true);
    expect(isTextCharset("latin1")).toBe(false);
  });
});
