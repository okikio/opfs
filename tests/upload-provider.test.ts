import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { close } from "../src/close.ts";
import { UploadSessionSchema } from "../src/upload.ts";
import pin from "./fixtures/upload/upstream.json" with { type: "json" };

/** Full source verification occurs before the borrowed code is reconstructed inside a disposable container. */
async function nativeFiles() {
  const out = [];
  for (const item of pin.files) {
    if (item.path.startsWith("/") || item.path.split("/").includes("..")) throw new Error("Unsafe native path.");
    const content = await readFile(
      fileURLToPath(new URL("./fixtures/upload/native/" + item.path + ".snapshot", import.meta.url).href),
    );
    const blob = createHash("sha1").update("blob " + content.byteLength + "\0").update(content).digest("hex");
    expect(blob).toBe(item.gitBlob);
    out.push({ content, target: "/tool/source/" + item.path });
  }
  out.push({
    content: await readFile(fileURLToPath(new URL("./fixtures/upload/server.ts", import.meta.url).href)),
    target: "/tool/server.ts",
  });
  return out;
}
/** Bounded child capture; close is the join after SIGKILL, not merely the kill request. */
async function client(phase: string, target: string, directory: string) {
  const process = spawn("node", [
    fileURLToPath(new URL("./fixtures/upload/client.ts", import.meta.url).href),
    new URL("../src/upload.ts", import.meta.url).href,
    phase,
    target,
    directory,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const take = (value: Buffer) => {
    if (output.length + value.byteLength > 65536) process.kill("SIGKILL");
    else output += value.toString();
  };
  process.stdout.on("data", take);
  process.stderr.on("data", take);
  const timer = setTimeout(() => process.kill("SIGKILL"), 30_000);
  try {
    return await new Promise<{ code: number | null; signal: string | null; output: string }>((resolve, reject) => {
      process.once("error", reject);
      process.once("close", (code, signal) => resolve({ code, signal, output }));
    });
  } finally {
    clearTimeout(timer);
  }
}

describe("draft15 client against independent canonical interop10 FS server", () => {
  it("recovers lost append/final replies in separate client processes and preserves unavailable publication truth", {
    timeout: 180_000,
  }, async () => {
    const releases: Array<() => PromiseLike<unknown>> = [];
    let primary: readonly unknown[] = [];
    try {
      const { GenericContainer, Wait } = await import("testcontainers");
      class BoundedContainer extends GenericContainer {
        protected override beforeContainerCreated(): Promise<void> {
          this.hostConfig.PidsLimit = 128;
          return Promise.resolve();
        }
      }
      const container = await new BoundedContainer(
        "node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68",
      )
        .withResourcesQuota({ memory: 1, cpu: 1 })
        .withCopyContentToContainer(await nativeFiles())
        .withCommand(["node", "/tool/server.ts", "/tmp/upload-store", "--public-fixture"])
        .withExposedPorts(8080).withWaitStrategy(Wait.forLogMessage("upload-fixture-ready:8080"))
        .withStartupTimeout(30_000).start();
      releases.push(async () => {
        await container.stop();
      });
      const runtime = await container.exec(["node", "--version"]);
      expect(runtime.exitCode).toBe(0);
      expect(runtime.output.trim()).toBe("v26.13.0");
      console.info("Upload native server official Node runtime:", runtime.output.trim());
      const resources = await container.exec([
        "node",
        "-e",
        `
        const fs=require("node:fs");
        const read=(path)=>fs.readFileSync(path,"utf8").trim();
        const v2=fs.existsSync("/sys/fs/cgroup/memory.max");
        const cpu=v2?read("/sys/fs/cgroup/cpu.max").split(" ").map(Number):[Number(read("/sys/fs/cgroup/cpu/cpu.cfs_quota_us")),Number(read("/sys/fs/cgroup/cpu/cpu.cfs_period_us"))];
        process.stdout.write(JSON.stringify({memory:Number(read(v2?"/sys/fs/cgroup/memory.max":"/sys/fs/cgroup/memory/memory.limit_in_bytes")),pids:Number(read(v2?"/sys/fs/cgroup/pids.max":"/sys/fs/cgroup/pids/pids.max")),cpus:cpu[0]/cpu[1]}));
      `,
      ]);
      expect(resources.exitCode, resources.output).toBe(0);
      expect(JSON.parse(resources.output)).toEqual({ memory: 1073741824, pids: 128, cpus: 1 });
      console.info("Upload native server actual cgroup limits:", resources.output);
      const directory = await mkdtemp(join(tmpdir(), "upload-client-loss-"));
      releases.push(() => rm(directory, { recursive: true, force: true }));
      const original = Uint8Array.from({ length: 131089 }, (_, index) => (index * 31 + 17) % 251);
      const endpoint = `http://${container.getHost()}:${container.getMappedPort(8080)}`;
      for (const ending of ["replay", "unknown"]) {
        const target = endpoint + "/create?key=" + ending + ".bin";
        await writeFile(join(directory, "input.bin"), original);
        const first = await client("append-kill", target, directory);
        expect(first, first.output).toMatchObject({ code: null, signal: "SIGKILL" });
        const saved = JSON.parse(await readFile(join(directory, "checkpoint.json"), "utf8"));
        expect(UploadSessionSchema.parse(saved.session).size).toBe(original.length);
        expect(saved.acknowledgedOffset).toBe(0);
        const second = await client("finish-kill", target, directory);
        expect(second, second.output).toMatchObject({ code: null, signal: "SIGKILL" });
        const pending = JSON.parse(await readFile(join(directory, "checkpoint.json"), "utf8"));
        expect(pending.acknowledgedOffset).toBe(original.length);
        expect(pending.receipt).toBeUndefined();
        const native = await container.exec([
          "node",
          "-e",
          `process.stdout.write(require("node:fs").readFileSync("/tmp/upload-store/${ending}.bin").toString("base64"))`,
        ]);
        expect(native.exitCode).toBe(0);
        expect(new Uint8Array(Buffer.from(native.output, "base64"))).toEqual(original);
        if (ending === "unknown") {
          const token = new URL(pending.session.url).pathname.slice("/uploads/".length);
          expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
          const removed = await container.exec([
            "node",
            "-e",
            `require("node:fs").rmSync("/tmp/upload-store/.uploads/${token}",{recursive:true})`,
          ]);
          expect(removed.exitCode).toBe(0);
        }
        const final = await client(ending, target, directory);
        expect(final, final.output).toMatchObject({ code: 0, signal: null });
        expect(JSON.parse(final.output).state).toBe(ending === "replay" ? "target-response" : "publication-unknown");
      }
    } catch (reason) {
      primary = [reason];
    }
    await close(releases.reverse(), primary);
  });
});
