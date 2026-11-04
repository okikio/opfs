/** Native browser child environment and finite Linux locale admission. @module */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { env, platform } from "node:process";

/** Only locale fields enter evidence; inherited credentials never enter a receipt. */
const fields = ["LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "LC_MESSAGES"] as const;
/** Existing correctness, installed-consumer and benchmark owners retain separate evidence. */
export type LaneType = "browser" | "consumer-browser" | "browser-bench";
/** The native child receives inherited nonlocale settings without changing its parent. */
export type EnvironmentType = Record<string, string | undefined>;
/** Successful native locale output remains separate from the browser workload verdict. */
export interface ProbeType {
  readonly stdout: string;
  readonly stderr: string;
  /** Native callback fault and diagnostics stay separate; absence means successful exit. */
  readonly failure?: { readonly reason: unknown };
}
/** Private controls exercise admission without inventing a native locale installation. */
export interface OptionsType {
  readonly system?: string;
  readonly ambient?: EnvironmentType;
  readonly probe?: (environment: EnvironmentType) => Promise<ProbeType>;
}

/** Linux native filename conversion needs a real UTF-8 locale, independently of page locale. */
export function create(system: string = platform, ambient: EnvironmentType = env): EnvironmentType {
  return { ...ambient, ...(system === "linux" ? { LC_ALL: "C.UTF-8", LANG: "C.UTF-8" } : {}) };
}

/** Evidence follows the existing report owner rather than an installed package source path. */
export function directory(root: string, lane: LaneType): string {
  return join(root, ".tmp", "reports", lane);
}

/** Select the exact allowlist, retaining the difference between an absent and an empty setting. */
function locale(environment: EnvironmentType): Record<string, string | null> {
  return Object.fromEntries(fields.map((field) => [field, environment[field] ?? null]));
}

/**
 * Executes one direct native command with bounded output and a native kill deadline.
 * execFile owns its child and callback settlement; this does not own browser processes
 * or promise to interrupt a stuck OS operation. The outer runner still owns its deadline.
 */
function probe(environment: EnvironmentType): Promise<ProbeType> {
  return new Promise((resolve) => {
    execFile("locale", ["charmap"], {
      env: environment,
      encoding: "utf8",
      timeout: 10_000,
      killSignal: "SIGKILL",
      maxBuffer: 16_384,
      shell: false,
    }, (error, stdout, stderr) => {
      resolve({ stdout, stderr, ...(error ? { failure: { reason: error } } : {}) });
    });
  });
}

/**
 * Refuses Linux browser acquisition when C.UTF-8 or the native locale utility is absent.
 * A receipt records environment admission only. Native versions, behavioral assertions,
 * skips and timings remain in their own browser evidence. macOS and Windows retain their
 * environment; no POSIX locale availability is inferred on those platforms.
 */
export async function admit(root: string, lane: LaneType, options: OptionsType = {}): Promise<void> {
  const system = options.system ?? platform;
  const ambient = options.ambient ?? env;
  const effective = create(system, ambient);
  const receipt = {
    platform: system,
    policy: system === "linux" ? "linux-c-utf8" : "inherited",
    ambient: locale(ambient),
    effective: locale(effective),
    status: system === "linux" ? "refused" : "not-applicable",
    probe: { outcome: system === "linux" ? "pending" : "not-applicable", stdout: "", stderr: "" },
  };
  const failures: unknown[] = [];
  // Create only the named existing report namespace before the native probe.
  const output = directory(root, lane);
  await mkdir(output, { recursive: true });
  if (system === "linux") {
    try {
      const result = await (options.probe ?? probe)(effective);
      receipt.probe = {
        outcome: result.failure ? "failed" : "completed",
        stdout: result.stdout,
        stderr: result.stderr,
      };
      if (result.failure) throw result.failure.reason;
      // Charset spellings are case-insensitive and may use '-' or '_'. ANSI/empty
      // output is a failed native admission, never a capability skip.
      if (result.stdout.trim().replace(/[-_]/gu, "").toUpperCase() !== "UTF8") {
        throw new Error("Linux browsers require an installed C.UTF-8 locale and UTF-8 charmap.");
      }
      receipt.status = "admitted";
    } catch (reason) {
      if (receipt.probe.outcome === "pending") receipt.probe.outcome = "rejected";
      failures.push(reason);
    }
  }
  try {
    await writeFile(join(output, "environment.json"), JSON.stringify(receipt, null, 2) + "\n");
  } catch (reason) {
    failures.push(reason);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Browser environment admission and evidence retention failed.", {
      cause: failures[0],
    });
  }
}
