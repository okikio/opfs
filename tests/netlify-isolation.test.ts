/** Authored Docker inspection controls; these do not replace effective engine and kernel isolation checks. */
import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { hasNoPublishedPorts } from "./provider/netlify.ts";

describe("Netlify fixture published-port evidence", () => {
  it("admits Docker Engine null and Docker Desktop empty-object representations", () => {
    expect(hasNoPublishedPorts(null)).toBe(true);
    expect(hasNoPublishedPorts({})).toBe(true);
    expect(hasNoPublishedPorts(JSON.parse("{}"))).toBe(true);
  });

  it("refuses missing evidence, arrays, scalars and nonempty port mappings", () => {
    const missing: Record<string, unknown> = {};
    const refused: readonly unknown[] = [
      missing.PortBindings,
      undefined,
      [],
      [null],
      "",
      "{}",
      0,
      false,
      { "8080/tcp": null },
      { "8080/tcp": [] },
      { "8080/tcp": [{ HostIp: "0.0.0.0", HostPort: "8080" }] },
      new Date(0),
      Object.defineProperty({}, "8080/tcp", { value: [] }),
    ];
    for (const value of refused) expect(hasNoPublishedPorts(value)).toBe(false);
  });
});
