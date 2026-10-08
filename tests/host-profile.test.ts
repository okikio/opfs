import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { createFileSystem } from "../mod.ts";
import { createFileAdapter } from "../src/adapter/file.ts";
import { defineFileDriver, type FileBackendType } from "../src/driver/file.ts";
import { createKeyValueBridge } from "../src/bridge/kv.ts";
import { createUnstorageBridge } from "../src/bridge/unstorage.ts";
import {
  admitHost,
  getHostCapabilities,
  getHostPublication,
  HOST_PROFILES,
  resolveHostProfile,
} from "../src/driver/host.ts";
import type { HostProfileType } from "../src/driver/host.ts";

/** The counter is the oracle: a declared rejection cannot enter any backend operation. */
function observed(profile: HostProfileType) {
  const calls: string[] = [];
  const fail = (name: string): never => {
    calls.push(name);
    throw new Error(`Unexpected storage work: ${name}`);
  };
  const backend: FileBackendType = {
    name: "observed",
    hostProfile: profile,
    capabilities: getHostCapabilities(profile),
    publication: getHostPublication(profile),
    admit: (input) => admitHost(profile, input),
    async stat() {
      return fail("stat");
    },
    async readFile() {
      return fail("readFile");
    },
    async writeFile() {
      fail("writeFile");
    },
    async *readDir() {
      yield fail("readDir");
    },
    async createDir() {
      fail("createDir");
    },
    async remove() {
      fail("remove");
    },
    async openReadStream() {
      return fail("openReadStream");
    },
    async writeStream() {
      fail("writeStream");
    },
    async copy() {
      fail("copy");
    },
    async move() {
      fail("move");
    },
    async reserve() {
      fail("reserve");
    },
    async entry() {
      return fail("entry");
    },
    async *entries() {
      yield fail("entries");
    },
    async openWritableFile() {
      return fail("openWritableFile");
    },
    async openSyncFile() {
      return fail("openSyncFile");
    },
  };
  const driver = defineFileDriver(backend, {
    name: "observed",
    plan: (input) => ({
      operation: input.operation,
      supported: true,
      support: "native",
      problems: [],
      actions: [],
    }),
  });
  return { driver, adapter: createFileAdapter(driver), calls };
}

describe("declared host deployment admission", () => {
  it("takes validated immutable snapshots and keeps profile provenance separate from observations", () => {
    const input = {
      ...HOST_PROFILES.native,
      name: "volume",
      source: "user" as const,
      writeModes: ["replace" as const],
    };
    const snapshot = resolveHostProfile(input);
    input.name = "changed";
    input.writeModes.push("replace");
    expect(snapshot.name).toBe("volume");
    expect(snapshot.writeModes).toEqual(["replace"]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.writeModes)).toBe(true);
    expect(() => resolveHostProfile("missing" as "native")).toThrow(TypeError);
    expect(() => resolveHostProfile({ ...input, extra: true } as HostProfileType)).toThrow(TypeError);
  });

  for (const profile of [HOST_PROFILES["mountpoint-s3"], HOST_PROFILES["blobfuse-block"]]) {
    for (const native of [true, false]) {
      it(`${profile.name} rejects strong copy/move before metadata, directory traversal, stages, or fallback I/O (native=${native})`, async () => {
        const { adapter, driver, calls } = observed(profile);
        const fs = createFileSystem(adapter, { optimizations: { nativeCopy: native, nativeMove: native } });
        try {
          for (const operation of ["copy", "move"] as const) {
            for (const overwrite of [false, true]) {
              const plan = fs.plan({ operation, path: "/unknown/tree", destination: "/parents/result", overwrite });
              expect(plan.supported).toBe(false);
              expect(plan.problems.some((problem) => problem.code.startsWith("host-"))).toBe(true);
              await expect(fs[operation]("/unknown/tree", "/parents/result", { overwrite })).rejects.toMatchObject({
                code: "not-supported",
                operation,
              });
            }
          }
          expect(driver.plan({ operation: "copy", path: "/a", destination: "/b" }).supported).toBe(false);
          await expect(adapter.copy!("/a", "/b", { overwrite: false })).rejects.toMatchObject({
            code: "not-supported",
          });
          await expect(driver.move!("/a", "/b", { overwrite: true })).rejects.toMatchObject({ code: "not-supported" });
          expect(calls).toEqual([]);
          expect(fs.inspect().adapter.hostProfile?.name).toBe(profile.name);
        } finally {
          await fs.close();
        }
      });
    }
  }

  it("limits Mountpoint append/update and mutable resources instead of advertising unrestricted host semantics", async () => {
    const { driver, adapter, calls } = observed(HOST_PROFILES["mountpoint-s3"]);
    const fs = createFileSystem(adapter);
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        pulls++;
      },
    }, { highWaterMark: 0 });
    try {
      expect(adapter.capabilities.streamWriteModes).toEqual(["replace"]);
      expect(adapter.capabilities.positionalWrite).toBe(false);
      expect(adapter.capabilities.syncAccess).toBe(false);
      await expect(driver.writeFile("/file", new Uint8Array(), { mode: "append" })).rejects.toMatchObject({
        code: "not-supported",
      });
      await expect(fs.writeFile("/parent/file", stream, { parents: true, mode: "update" })).rejects.toMatchObject({
        code: "not-supported",
      });
      await expect(fs.openWritableFile("/file", { create: true, parents: true })).rejects.toMatchObject({
        code: "not-supported",
      });
      await expect(fs.openSyncFile("/file", { create: true })).rejects.toMatchObject({ code: "not-supported" });
      expect(calls).toEqual([]);
      expect(pulls).toBe(0);
      expect(stream.locked).toBe(false);
    } finally {
      await fs.close();
    }
  });

  it("read-only facade and bridges reject before format reads, membership listing, indirect parents, or producer ownership", async () => {
    const { driver, adapter, calls } = observed(resolveHostProfile({ ...HOST_PROFILES.native, readOnly: true }));
    const fs = createFileSystem(adapter);
    const kv = createKeyValueBridge(fs);
    const unstorage = createUnstorageBridge(fs);
    try {
      for (
        const action of [
          () => fs.mkdir("/parent", { recursive: true }),
          () => fs.ensureDir("/parent"),
          () => fs.ensureFile("/parent/file"),
          () => fs.getDirectoryHandle("/parent", { recursive: true }),
          () => fs.getFileHandle("/parent/file", { create: true }),
          () => fs.writeFile("/parent/file", "body", { parents: true }),
          () => fs.remove("/parent", { recursive: true }),
          () => fs.emptyDir("/"),
          () => fs.copy("/source", "/target", { preserve: false }),
          () => fs.move("/source", "/target"),
          () => fs.openWritableFile("/file", { create: true }),
          () => fs.openSyncFile("/file", { create: true }),
          () => driver.createDir("/parent"),
          () => driver.remove("/file"),
          () => kv.set("a", "b"),
          () => kv.setRaw("a", new Uint8Array()),
          () => kv.remove("a"),
          () => kv.clear(),
          () => unstorage.setItem("a", "b", {}),
          () => unstorage.clear("", {}),
        ]
      ) await expect(action()).rejects.toMatchObject({ code: "not-supported" });
      expect(calls).toEqual([]);
    } finally {
      await fs.close();
    }
  });

  it("reports native unsupported facts without erasing explicitly admitted facade emulation", async () => {
    for (const name of ["mountpoint-s3", "blobfuse-block"] as const) {
      const profile = HOST_PROFILES[name];
      const { adapter } = observed(profile);
      const fs = createFileSystem(adapter);
      expect(adapter.publication?.copy).toBe("unsupported");
      expect(adapter.publication?.copyNoReplace).toBe("unsupported");
      expect(adapter.publication?.move).toBe(name === "mountpoint-s3" ? "unsupported" : "best-effort");
      expect(fs.plan({ operation: "copy", path: "/a", destination: "/b", preserve: false }))
        .toMatchObject({ supported: true, support: "emulated" });
      await fs.close();
    }
    expect(getHostPublication(resolveHostProfile({ ...HOST_PROFILES.native, readOnly: true })))
      .toMatchObject({
        copy: "unsupported",
        move: "unsupported",
        noReplace: "unsupported",
        copyNoReplace: "unsupported",
        moveNoReplace: "unsupported",
      });
    expect(getHostPublication(resolveHostProfile({ ...HOST_PROFILES.native, copyFile: false })).copyNoReplace)
      .toBe("unsupported");
    expect(getHostPublication(resolveHostProfile({ ...HOST_PROFILES.native, rename: "unsupported" })).noReplace)
      .toBe("atomic");
  });

  it("keeps option-sensitive overwrite admission and atomic no-replace separate", () => {
    const profile = resolveHostProfile({ ...HOST_PROFILES.native, hardLink: false });
    expect(admitHost(profile, { operation: "copy", overwrite: true }).supported).toBe(true);
    expect(admitHost(profile, { operation: "copy", overwrite: false }).supported).toBe(false);
    expect(admitHost(profile, { operation: "write", intent: "copy", preserve: true, mode: "replace" }).supported).toBe(
      true,
    );
    expect(admitHost(profile, { operation: "write", intent: "copy", preserve: false, exclusive: true }).supported).toBe(
      false,
    );
    for (const name of ["mountpoint-s3", "blobfuse-block"] as const) {
      expect(
        admitHost(HOST_PROFILES[name], { operation: "write", intent: "copy", preserve: false, mode: "replace" })
          .supported,
      ).toBe(true);
      expect(
        admitHost(HOST_PROFILES[name], { operation: "write", intent: "copy", preserve: true, mode: "replace" })
          .supported,
      ).toBe(false);
    }
  });
});
