/** Environment controls do not stand in for native browser Unicode tests. @module */
import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { admit, create, directory } from "./environment.ts";
import type { LaneType, ProbeType } from "./environment.ts";
import { withReleases } from "../close.ts";

/** Every acquired temporary root is retired even when a probe or assertion refuses. */
async function fixture(body: (root: string) => Promise<void>): Promise<void> {
  await withReleases(async (releases) => {
    const root = await mkdtemp(join(tmpdir(), "browser-environment-"));
    releases.push(() => rm(root, { recursive: true, force: true }));
    await body(root);
  });
}
/** A terminal box preserves raw undefined/null failure identity. */
async function rejected(body: () => Promise<void>): Promise<unknown> {
  const terminal = await body().then(
    () => ({ ok: true as const }),
    (reason: unknown) => ({ ok: false as const, reason }),
  );
  expect(terminal.ok).toBe(false);
  if (terminal.ok) throw Error("Expected native environment refusal.");
  return terminal.reason;
}
/** Parse actual retained JSON instead of deriving an expectation through the candidate. */
async function receipt(root: string, lane: LaneType): Promise<unknown> {
  return JSON.parse(await readFile(join(root, ".tmp/reports", lane, "environment.json"), "utf8"));
}

describe("native browser environment admission", () => {
  it("overrides Linux locale only and preserves nonlocale child settings without mutating its parent", () => {
    const ambient = { PATH: "/owned/tools", CUSTOM: "preserve", LANG: "", LC_ALL: "", LC_CTYPE: "POSIX" };
    expect(create("linux", ambient)).toEqual({
      PATH: "/owned/tools",
      CUSTOM: "preserve",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      LC_CTYPE: "POSIX",
    });
    expect(ambient).toEqual({ PATH: "/owned/tools", CUSTOM: "preserve", LANG: "", LC_ALL: "", LC_CTYPE: "POSIX" });
  });
  it("preserves inherited non-POSIX host environments as an independent snapshot", () => {
    const ambient = { PATH: "/tools", LANG: "existing", LC_ALL: "existing-all" };
    for (const system of ["darwin", "win32"]) {
      const child = create(system, ambient);
      expect(child).toEqual(ambient);
      expect(child).not.toBe(ambient);
    }
  });
  it("routes source, installed-consumer and benchmark evidence to their existing independent owners", async () => {
    await fixture(async (root) => {
      for (const lane of ["browser", "consumer-browser", "browser-bench"] as const) {
        expect(directory(root, lane)).toBe(join(root, ".tmp", "reports", lane));
        let calls = 0;
        await admit(root, lane, {
          system: "linux",
          ambient: { PATH: "/owned/tools", PRIVATE_TOKEN: "must-not-be-retained", LANG: "" },
          probe: (child) => {
            calls++;
            expect(child).toMatchObject({
              PATH: "/owned/tools",
              PRIVATE_TOKEN: "must-not-be-retained",
              LC_ALL: "C.UTF-8",
              LANG: "C.UTF-8",
            });
            return Promise.resolve({ stdout: "UTF-8\n", stderr: "" });
          },
        });
        expect(calls).toBe(1);
        expect(await receipt(root, lane)).toEqual({
          platform: "linux",
          policy: "linux-c-utf8",
          status: "admitted",
          ambient: { LANG: "", LANGUAGE: null, LC_ALL: null, LC_CTYPE: null, LC_MESSAGES: null },
          effective: { LANG: "C.UTF-8", LANGUAGE: null, LC_ALL: "C.UTF-8", LC_CTYPE: null, LC_MESSAGES: null },
          probe: { outcome: "completed", stdout: "UTF-8\n", stderr: "" },
        });
        const raw = await readFile(join(root, ".tmp/reports", lane, "environment.json"), "utf8");
        expect(raw.includes("must-not-be-retained")).toBe(false);
        expect(raw.includes("PRIVATE_TOKEN")).toBe(false);
      }
    });
  });
  it("admits semantic UTF-8 charset spellings instead of one incidental stdout string", async () => {
    await fixture(async (root) => {
      for (const stdout of ["utf8\n", "UTF-8\n", "utf_8\n"]) {
        await admit(root, "browser", {
          system: "linux",
          ambient: {},
          probe: () => Promise.resolve({ stdout, stderr: "" }),
        });
        expect(await receipt(root, "browser")).toMatchObject({ status: "admitted" });
      }
    });
  });
  it("refuses a successful native command whose observed charset is empty or non-UTF8", async () => {
    await fixture(async (root) => {
      for (const stdout of ["", "ANSI_X3.4-1968\n", "UTF-8 extra text\n"]) {
        expect(
          await rejected(() =>
            admit(root, "browser", {
              system: "linux",
              ambient: {},
              probe: () => Promise.resolve({ stdout, stderr: "" }),
            })
          ),
        ).toBeInstanceOf(Error);
        expect(await receipt(root, "browser")).toMatchObject({
          status: "refused",
          probe: { outcome: "completed", stdout },
        });
      }
    });
  });
  for (const reason of [undefined, null, Error("native locale unavailable")]) {
    it(`retains actual native probe fault presence (${String(reason)}) and bounded callback diagnostics`, async () => {
      await fixture(async (root) => {
        const result: ProbeType = { stdout: "", stderr: "locale unavailable\n", failure: { reason } };
        expect(
          await rejected(() =>
            admit(root, "browser", { system: "linux", ambient: {}, probe: () => Promise.resolve(result) })
          ),
        ).toBe(reason);
        expect(await receipt(root, "browser")).toMatchObject({
          status: "refused",
          probe: { outcome: "failed", stdout: "", stderr: "locale unavailable\n" },
        });
      });
    });
  }
  it("retains rejected probe acquisition separately from completed native command output", async () => {
    await fixture(async (root) => {
      const reason = Error("actual acquisition refusal");
      expect(
        await rejected(() =>
          admit(root, "browser", { system: "linux", ambient: {}, probe: () => Promise.reject(reason) })
        ),
      ).toBe(reason);
      expect(await receipt(root, "browser")).toMatchObject({
        status: "refused",
        probe: { outcome: "rejected", stdout: "", stderr: "" },
      });
    });
  });
  it("does not start a Linux locale probe or manufacture UTF8 admission on another host", async () => {
    await fixture(async (root) => {
      let calls = 0;
      for (const system of ["darwin", "win32"]) {
        await admit(root, "browser", {
          system,
          ambient: { LANG: "inherited" },
          probe: () => {
            calls++;
            return Promise.reject(Error("This native capability must not be acquired."));
          },
        });
        expect(await receipt(root, "browser")).toMatchObject({
          platform: system,
          policy: "inherited",
          status: "not-applicable",
          probe: { outcome: "not-applicable" },
          effective: { LANG: "inherited", LC_ALL: null },
        });
      }
      expect(calls).toBe(0);
    });
  });
});
