/** Start one explicitly named fixture container after checking its complete authority envelope. */
import { Buffer } from "node:buffer";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { check, json, record, snapshot } from "./acquire.ts";
const IMAGE = "sha256:97000ec2e6fe65be46c887c441bb83ac6cb03d46091429bb73914a75bce6991e";
const REFERENCE = "node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68";
const MAX_LOG = 1024 * 1024;
function docker(args: readonly string[]): Buffer<ArrayBuffer> {
  const result = spawnSync("docker", [...args], { timeout: 10_000, maxBuffer: 512 * 1024 });
  check(
    !result.error && result.status === 0 && result.stdout.length <= 512 * 1024,
    "Bounded Docker command failed: " + args.slice(0, 2).join(" "),
  );
  return result.stdout;
}
function empty(value: unknown): boolean {
  return value === null || value === undefined ||
    (Array.isArray(value) ? value.length === 0 : typeof value === "object" && Object.keys(value).length === 0);
}
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
export interface RecipeType {
  readonly container: string;
  readonly family: "age" | "jwe";
  readonly stage: "cli" | "vectors" | "producer";
  readonly output: string;
}
/**
 * Containers must be created separately from a reviewed recipe. This launcher
 * neither creates nor removes containers. Only a successfully checked owned
 * container is stopped on failure; logs, state and cleanup faults are retained.
 */
export async function launch(recipe: RecipeType): Promise<void> {
  check(
    new RegExp("^opfs-" + recipe.family + "-[a-z0-9-]{1,64}$").test(recipe.container),
    "Only an owned fixture container may start.",
  );
  check(recipe.family === "age" || recipe.stage === "producer", "JWE launcher supports offline production only.");
  mkdirSync(recipe.output, { recursive: false, mode: 0o700 });
  const start = performance.now(), deadline = recipe.family === "age" ? 180_000 : 90_000;
  const primary: string[] = [], cleanup: string[] = [];
  let started = false, code = 0, logBytes = 0;
  function inspect(kind: "container" | "image", name: string, receipt: string): Record<string, unknown> {
    const raw = docker([kind, "inspect", name]);
    snapshot(recipe.output, receipt, raw);
    const data: unknown = JSON.parse(raw.toString());
    check(Array.isArray(data) && data.length === 1, "Docker inspection cardinality.");
    return record(data[0]);
  }
  try {
    const container = inspect("container", recipe.container, "pre-start-container.json"),
      image = inspect("image", IMAGE, "pre-start-image.json");
    const config = record(container.Config),
      imageConfig = record(image.Config),
      host = record(container.HostConfig),
      state = record(container.State);
    check(
      image.Id === IMAGE && image.Architecture === "arm64" && image.Os === "linux",
      "Pinned official Node image/platform.",
    );
    check(container.Image === IMAGE && config.Image === REFERENCE, "Reviewed image reference/config identity.");
    check(state.Status === "created" && state.Running === false, "Only a fresh stopped container may start.");
    check(
      host.Memory === 1073741824 && host.MemorySwap === 1073741824 && host.NanoCpus === 1000000000 &&
        host.PidsLimit === 128,
      "Exact RAM/swap/CPU/PID quotas.",
    );
    for (
      const value of [
        container.Mounts,
        host.Binds,
        host.Mounts,
        host.PortBindings,
        config.ExposedPorts,
        host.CapAdd,
        host.Devices,
        host.DeviceRequests,
        host.ExtraHosts,
        host.Links,
      ]
    ) check(empty(value), "Unexpected container authority.");
    check(!host.PublishAllPorts && !host.Privileged, "Unexpected published ports/privilege.");
    check(host.NetworkMode === (recipe.stage === "producer" ? "none" : "bridge"), "Reviewed network mode.");
    check(
      same(config.Env, imageConfig.Env) && same(config.Entrypoint, ["node"]),
      "No added environment credentials; explicit Node entrypoint.",
    );
    const command = recipe.stage === "producer"
      ? ["/tool/produce.ts", ...(recipe.family === "jwe" ? ["/evidence"] : [])]
      : ["/tool/age/provenance/age-acquire.ts", recipe.stage, "--output", "/evidence"];
    check(same(config.Cmd, command), "Reviewed TypeScript stage command.");
    const log = openSync(recipe.output + "/output.log", "wx", 0o600);
    try {
      const child = spawn("docker", ["start", "-a", recipe.container], { stdio: ["ignore", "pipe", "pipe"] });
      started = true;
      let retired = false, fault = "";
      let resolveFault: () => void = () => {};
      const failed = new Promise<void>((resolve) => {
        resolveFault = resolve;
      });
      const fail = function (message: string): void {
        if (!fault) {
          fault = message;
          resolveFault();
        }
      };
      const closed = new Promise<number>((resolve) => {
        child.once("error", (error) => fail("Docker attachment error: " + error.message));
        child.once("close", (status) => {
          retired = true;
          resolve(status ?? 126);
        });
      });
      const collect = function (data: Buffer<ArrayBufferLike>): void {
        if (fault) return;
        const allowed = MAX_LOG - logBytes;
        try {
          if (allowed > 0) {
            const kept = data.subarray(0, allowed);
            let at = 0;
            while (at < kept.length) {
              const written = writeSync(log, kept, at, kept.length - at);
              check(written > 0, "Fixture log write made no progress.");
              at += written;
              logBytes += written;
            }
          }
          if (data.length > allowed) fail("1-MiB combined output limit");
        } catch (error) {
          fail("Fixture log write failed: " + String(error));
        }
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      const timer = setTimeout(
        () => fail("Outer fixture deadline"),
        Math.max(1, deadline - (performance.now() - start)),
      );
      const join = async function (milliseconds: number): Promise<boolean> {
        let limit: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            closed.then(() => true),
            new Promise<boolean>((resolve) => {
              limit = setTimeout(() => resolve(false), milliseconds);
            }),
          ]);
        } finally {
          if (limit !== undefined) clearTimeout(limit);
        }
      };
      try {
        await Promise.race([closed, failed]);
        if (fault) {
          primary.push(fault);
          code = 125;
        }
      } finally {
        clearTimeout(timer);
        if (fault || !retired) {
          try {
            docker(["stop", "--time", "1", recipe.container]);
          } catch (error) {
            cleanup.push("Owned container stop failed: " + String(error));
          }
          if (!await join(10_000)) {
            primary.push("Docker attachment did not retire after stop");
            code ||= 126;
            child.kill("SIGKILL");
            if (!await join(10_000)) cleanup.push("Docker attachment did not retire after SIGKILL");
          }
        }
        if (retired) code ||= await closed;
        child.stdout.removeListener("data", collect);
        child.stderr.removeListener("data", collect);
        child.stdout.destroy();
        child.stderr.destroy();
      }
    } finally {
      closeSync(log);
    }
  } catch (error) {
    primary.push(String(error).slice(0, 2048));
    code ||= 127;
  } finally {
    if (started) {
      try {
        const final = inspect("container", recipe.container, "state.json"), state = record(final.State);
        if (state.Running !== false || state.OOMKilled !== false || state.ExitCode !== 0) {
          code ||= 129;
          primary.push("Final container state is running, OOM-killed or unsuccessful");
        }
      } catch (error) {
        cleanup.push("Final inspection failed: " + String(error));
        code ||= 128;
      }
    }
    if (cleanup.length) code ||= 128;
    json(recipe.output, "launch.json", {
      container: recipe.container,
      stage: recipe.stage,
      exitCode: code,
      primary,
      cleanupFaults: cleanup,
      elapsedSeconds: (performance.now() - start) / 1000,
      logBytes,
      outerDeadlineSeconds: deadline / 1000,
      maxLogBytes: MAX_LOG,
      image: REFERENCE,
      scope: "New TypeScript recipe; historical Python receipts remain unchanged.",
    });
  }
  check(code === 0, "Fixture launch failed; inspect retained launch.json and output.log.");
}
