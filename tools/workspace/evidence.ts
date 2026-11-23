/**
 * Read CI evidence from GitHub. Release needs a passing main-push CI run on the exact commit, and
 * a main push selects work from the last commit whose CI passed. Caches hold tools and downloads;
 * only a recorded run on GitHub proves that a commit passed.
 * @module
 */
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import process from "node:process";
import { parseArgs } from "node:util";

/** The repository, branch and workflow whose push runs count as evidence. */
export interface ScopeType {
  /** `owner/name`. Runs from forks never count. */
  readonly repository: string;
  /** Only pushes to this branch count. */
  readonly branch: string;
}

/** The run fields that admission reads. GitHub sends more; the rest is ignored. */
interface RunType {
  readonly id: number;
  readonly sha: string;
  readonly created: number;
  readonly passed: boolean;
}

/** A full 40-digit commit SHA; abbreviated or malformed head SHAs from the API are not evidence. */
const sha = /^[0-9a-f]{40}$/u;

/** Inspect provider JSON without trusting its shape. */
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/**
 * Keep push runs on the scope's branch whose source and head are both this repository. The API
 * filters by these fields too, but a filter is a request, not proof, so each run is checked again.
 */
function pushes(runs: readonly unknown[], { repository, branch }: ScopeType): RunType[] {
  const same = (value: unknown) => typeof value === "string" && value.toLowerCase() === repository.toLowerCase();
  return runs.flatMap((value) => {
    const run = record(value);
    if (
      !run || run.event !== "push" || run.head_branch !== branch ||
      !same(record(run.repository)?.full_name) || !same(record(run.head_repository)?.full_name)
    ) return [];
    const created = typeof run.created_at === "string" ? Date.parse(run.created_at) : Number.NaN;
    if (
      typeof run.id !== "number" || !Number.isSafeInteger(run.id) || run.id < 1 ||
      typeof run.head_sha !== "string" || !sha.test(run.head_sha) || !Number.isFinite(created)
    ) throw new TypeError("GitHub returned a push run without a valid id, commit or creation time.");
    return [{
      id: run.id,
      sha: run.head_sha,
      created,
      passed: run.status === "completed" && run.conclusion === "success",
    }];
  });
}

/**
 * Return the id of the latest main-push run for `revision` when that run passed. An older passing
 * run does not count when a newer run on the same commit failed or is still running.
 */
export function admit(runs: readonly unknown[], scope: ScopeType & { readonly revision: string }): number {
  const [latest] = pushes(runs, scope).filter((run) => run.sha === scope.revision).sort((a, b) => b.id - a.id);
  if (!latest) throw new Error(`No CI run for a push to ${scope.branch} exists for ${scope.revision}.`);
  if (!latest.passed) throw new Error(`The latest CI run for ${scope.revision} (${latest.id}) has not passed.`);
  return latest.id;
}

/**
 * Return the newest commit whose main-push CI passed and that is an ancestor of `head`, or
 * `undefined` when there is none. The caller must then select all work. The current run never
 * counts, nor does a run created after it.
 */
export function baseline(
  runs: readonly unknown[],
  scope: ScopeType & { readonly head: string; readonly current?: number },
  ancestor: (base: string, head: string) => boolean,
): string | undefined {
  const passed = pushes(runs, scope).filter((run) => run.passed).sort((a, b) => b.created - a.created || b.id - a.id);
  const cutoff = passed.find((run) => run.id === scope.current)?.created;
  for (const run of passed) {
    if (run.id === scope.current || (cutoff !== undefined && run.created > cutoff)) continue;
    if (ancestor(run.sha, scope.head)) return run.sha;
  }
  return undefined;
}

/** Read one page of up to 100 runs for a workflow. Every filter is checked again by the caller. */
export async function runs(
  scope: ScopeType & { readonly workflow: string; readonly token: string },
  query: Readonly<Record<string, string>>,
  request: typeof fetch = fetch,
): Promise<unknown[]> {
  const url = new URL(`https://api.github.com/repos/${scope.repository}/actions/workflows/${scope.workflow}/runs`);
  url.search = new URLSearchParams({ ...query, branch: scope.branch, event: "push", per_page: "100" }).toString();
  const response = await request(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${scope.token}`,
      "X-GitHub-Api-Version": "2026-03-10",
    },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`GitHub returned ${response.status} for the ${scope.workflow} runs.`);
  const page = record(await response.json());
  if (!Array.isArray(page?.workflow_runs)) throw new TypeError("GitHub returned a runs page without workflow_runs.");
  return page.workflow_runs;
}

/** Git confirms ancestry in the checkout; the plan job fetches full history. */
const ancestor = (base: string, head: string) =>
  spawnSync("git", ["merge-base", "--is-ancestor", base, head], { stdio: "ignore", timeout: 10_000 }).status === 0;

if (import.meta.main) {
  const { positionals: [command], values } = parseArgs({
    allowPositionals: true,
    options: { sha: { type: "string" }, head: { type: "string" }, "run-id": { type: "string" } },
  });
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? "";
  const scope = { repository, branch: "main", workflow: "ci.yml", token };
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository) || !token) {
    throw new Error("Set GITHUB_REPOSITORY and GH_TOKEN to read CI evidence.");
  }
  if (command === "release") {
    const revision = values.sha ?? "";
    if (!sha.test(revision)) throw new TypeError("Pass --sha with a full lowercase commit SHA.");
    const id = admit(await runs(scope, { head_sha: revision }), { ...scope, revision });
    console.log(`CI run ${id} passed on a push to main for ${revision}.`);
  } else if (command === "baseline") {
    const head = values.head ?? "";
    const current = Number(values["run-id"]);
    if (!sha.test(head) || !Number.isSafeInteger(current) || current < 1) {
      throw new TypeError("Pass --head with a full commit SHA and --run-id with the current run id.");
    }
    let base: string | undefined;
    try {
      base = baseline(await runs(scope, { status: "success" }), { ...scope, head, current }, ancestor);
    } catch (error) {
      // A failed lookup is the same as no evidence: select all work rather than guess.
      console.log(`::warning::No CI baseline: ${error instanceof Error ? error.message : String(error)}`);
    }
    console.log(base ? `Select work changed since ${base}, the last commit whose CI passed.` : "Select all work.");
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `base=${base ?? ""}\n`);
  } else {
    throw new TypeError("Usage: evidence.ts release --sha <sha> | baseline --head <sha> --run-id <id>");
  }
}
