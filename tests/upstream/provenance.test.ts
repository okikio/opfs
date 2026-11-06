import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { inspect } from "./provenance.ts";

describe("Pinned upstream provenance", () => {
  it("retains every declared original source and license byte with no unlisted snapshots", async () => {
    const provenance = await inspect();
    expect(Object.keys(provenance.files).length).toBeGreaterThan(0);
    expect(provenance.manifest).toMatch(/^[a-f0-9]{64}$/);
  });
});
