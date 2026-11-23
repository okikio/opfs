import { describe, it } from "node:test";
import { expect } from "@std/expect";
import * as exports from "./exports.ts";

describe("public export record", () => {
  it("reports a renamed symbol as one removal and one addition", () => {
    const recorded = { "./source": ["function budgetSource", "function createBlobSource"] };
    const actual = { "./source": ["function createBlobSource", "function limitSource"] };
    expect(exports.compare(recorded, actual)).toEqual([
      "- ./source: function budgetSource",
      "+ ./source: function limitSource",
    ]);
  });
  it("reports a whole new or removed subpath", () => {
    expect(exports.compare({}, { "./hash": ["function crc32"] })).toEqual(["+ ./hash: function crc32"]);
    expect(exports.compare({ "./aws": ["function sha256"] }, {})).toEqual(["- ./aws: function sha256"]);
  });
  it("accepts an identical record", () => {
    expect(exports.compare({ "./xz": ["function openXz"] }, { "./xz": ["function openXz"] })).toEqual([]);
  });
});
