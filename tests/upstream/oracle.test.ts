import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { createFileSystem } from "../../mod.ts";
import { createMemoryAdapter } from "../../src/adapter/memory.ts";
import { withReleases } from "../close.ts";
import { directoryCases, runDirectoryCase, syncCases, WptAssertionError } from "./wpt.ts";
import { unavailable } from "./capability.ts";
import type { RootType } from "./wpt.ts";

/** Controls deliberately corrupt results without changing the original upstream assertion bodies. */
describe("Copied upstream oracles", () => {
  it("skips absent APIs and policy denial but fails unexpected native acquisition errors", () => {
    // Only fields consumed by this predicate vary; the complete reported probe remains its input.
    const probe: import("../../src/probe.ts").OpfsCapabilitiesType = {
      context: "window",
      secureContext: true,
      origin: "https://example.test",
      embedded: false,
      sameOriginTop: true,
      rootAvailable: false,
      webLocksAvailable: true,
      syncAccessHandleExposed: false,
      syncAccessHandleAllowedByContext: false,
      storageAccessApiAvailable: false,
    };
    for (const name of ["NotSupportedError", "SecurityError", "NotAllowedError"]) {
      expect(unavailable({ ...probe, rootError: { name, message: "native diagnostic" } })).toContain(name);
    }
    expect(() => unavailable({ ...probe, rootError: { name: "UnknownError", message: "native failure" } })).toThrow(
      "UnknownError",
    );
    expect(unavailable({ ...probe, rootAvailable: true })).toBeUndefined();
  });
  for (const corruption of ["bytes", "utf8-size"] as const) {
    it(`rejects ${corruption} corruption even when the other observable is correct`, async () => {
      await withReleases(async (releases) => {
        const fileSystem = createFileSystem(createMemoryAdapter());
        releases.push(() => fileSystem.close());
        const name = corruption === "bytes" ? "write() a blob to an empty file" : "write() with a valid utf-8 string";
        const source = directoryCases.find((test) => test.name === name);
        if (source === undefined) throw new Error(`Missing copied case ${name}`);
        const root: RootType = {
          async getFileHandle(name, options) {
            const file = await fileSystem.root.getFileHandle(name, options);
            return {
              kind: file.kind,
              name: file.name,
              createWritable: () => file.createWritable(),
              async getFile() {
                const actual = await file.getFile();
                if (corruption === "bytes") return new Blob(["0987654321"]); // Correct size, wrong bytes.
                const text = await actual.text();
                Object.defineProperty(actual, "text", { value: async () => text });
                Object.defineProperty(actual, "size", { value: 6 }); // Correct UTF-8 bytes, wrong size.
                return actual;
              },
            };
          },
        };
        await expect(runDirectoryCase(source, root)).rejects.toThrow(
          WptAssertionError,
        );
      });
    });
  }
  it("rejects a nonzero byte in a supposedly zero-filled extension", () => {
    const source = syncCases.find((test) =>
      test.name === "test SyncAccessHandle.truncate after SyncAccessHandle.write"
    );
    if (source === undefined) throw new Error("Missing copied truncate byte case");
    let size = 4;
    // This faulty fixture retains the valid read counts and prefix, but violates zero-fill.
    expect(() =>
      source.run({}, {
        write: (bytes) => bytes.length,
        getSize: () => size,
        truncate: (length) => {
          size = length;
        },
        read(bytes) {
          bytes.set([96, 97]);
          if (size === 6) bytes[2] = 1; // Only the newly grown region is corrupted.
          return size;
        },
      })
    ).toThrow(WptAssertionError);
  });
});
