import { describe, it } from "node:test";
import { expect } from "@std/expect";
import * as store from "./store.ts";

const sha = "a".repeat(64);

describe("fixture store manifest", () => {
  it("round-trips sorted entries, so writing twice changes nothing", () => {
    const files = {
      "tests/fixtures/b.json": { size: 2, sha256: sha },
      "tests/fixtures/a.json": { size: 1, sha256: sha },
    };
    const text = store.format(files);
    expect(Object.keys(store.parse(text).files)).toEqual(["tests/fixtures/a.json", "tests/fixtures/b.json"]);
    expect(store.format(store.parse(text).files)).toBe(text);
  });
  it("refuses paths outside tests/fixtures/, bad sizes and non-hex digests", () => {
    const bad = JSON.stringify({
      version: 1,
      limit: 1,
      files: {
        "src/x.ts": { size: 1, sha256: sha },
        "tests/fixtures/../x": { size: 1, sha256: sha },
        "tests/fixtures/zero": { size: 0, sha256: sha },
        "tests/fixtures/hex": { size: 1, sha256: "A".repeat(64) },
      },
    });
    expect(() => store.parse(bad)).toThrow(/src\/x\.ts[\s\S]*\.\.\/x[\s\S]*zero[\s\S]*hex/);
  });
  it("ignores exactly the stored paths, relative to tests/fixtures/", () => {
    const text = store.formatIgnore({ "tests/fixtures/seven/independent.json": { size: 1, sha256: sha } });
    expect(text.split("\n").filter((line) => line && !line.startsWith("#"))).toEqual(["/seven/independent.json"]);
  });
});
