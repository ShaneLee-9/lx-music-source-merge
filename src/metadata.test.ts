import { describe, expect, test } from "bun:test";
import { parseMetadataFromHeader } from "./metadata.ts";

describe("metadata parser", () => {
  test("parses reordered fields and quote variants", () => {
    const metadata = parseMetadataFromHeader(`/**\n * @author 'A'\n * version: "2.0"\n * name = 'Demo'\n */\nconst body = true;`);
    expect(metadata).toEqual({ name: "Demo", version: "2.0", author: "A" });
  });

  test("parses bang-style JSDoc with unquoted values", () => {
    const metadata = parseMetadataFromHeader(`/*!\n * @name 墨澜聚合音源\n * @description ignored\n * @version 2.3.4\n * @author 白姬9527(2449067834)\n */`);
    expect(metadata).toEqual({
      name: "墨澜聚合音源",
      version: "2.3.4",
      author: "白姬9527(2449067834)",
    });
  });

  test("rejects missing and duplicate fields", () => {
    expect(() => parseMetadataFromHeader("/** @name 'Demo'\n @version '1' */")).toThrow(/missing author/);
    expect(() => parseMetadataFromHeader("/**\n * @name 'A'\n * name 'B'\n * @version '1'\n * @author 'C'\n */")).toThrow(/duplicate name/);
  });

  test("rejects malformed values and a missing JSDoc", () => {
    expect(() => parseMetadataFromHeader("/**\n * @name 'Demo\n * @version '1'\n * @author 'A'\n */")).toThrow(/invalid quotes/);
    expect(() => parseMetadataFromHeader("const x = 1;\n/** @name 'A' */")).toThrow(/JSDoc/);
  });
});
