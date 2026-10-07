/**
 * Decide whether a CI run checks a native GitHub pull request stack, and against which base.
 *
 * A native stack is an ordered list of pull requests where each one targets the branch of the one
 * below it. Checking every layer with the costly jobs would test the same code several times, so
 * only the top layer runs them. The top compares the whole stack with the base of the bottom layer
 * (the "ultimate base"), which is the same change set that lands when the stack merges.
 * A lower layer still runs the source checks and skips the rest.
 *
 * The program writes two step outputs for `.github/actions/stack`:
 *
 * - `selected`: `true` when this run must prove the combined checks, `false` for a lower layer.
 * - `base-sha`: the ultimate base for the top of a stack, or empty to keep the event's own base.
 *
 * Every failure to read the stack selects the run with an empty base. A missing preview API or a
 * network error therefore runs more checks, never fewer. @module
 */
import { appendFile, readFile } from "node:fs/promises";

/** The part of a stack member that the decision reads. */
export interface Member {
  /** Pull request number. */
  readonly number: number;
  /** `open`, or `closed` for a merged or abandoned layer. */
  readonly state: string;
  /** The commit the layer was compared with when GitHub last updated it. */
  readonly base: { readonly sha: string };
}

/** What one run should do. */
export interface Selection {
  /** Whether this run executes the costly checks and the required aggregate. */
  readonly selected: boolean;
  /** The comparison base for the planner; empty keeps the event's own base. */
  readonly baseSha: string;
  /** One sentence for the job log. */
  readonly reason: string;
}

/** Inputs from the Actions runner. Tests pass them directly. */
export interface Context {
  /** `GITHUB_EVENT_NAME`, for example `pull_request` or `push`. */
  readonly event: string;
  /** The pull request number from the event payload, when the event has one. */
  readonly pull?: number | undefined;
  /** `owner/name` of this repository. */
  readonly repository: string;
  /** The REST API root, normally `https://api.github.com`. */
  readonly api: string;
  /** A token that can read this repository's pull requests. */
  readonly token: string;
}

/** The subset of `fetch` the program uses, so tests can answer without a network. */
export type Request = (url: string, init: { headers: Record<string, string> }) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}>;

/** Selected with the event's own base: the safe answer whenever the stack is unknown. */
const Everything = (reason: string): Selection => ({ selected: true, baseSha: "", reason });

/**
 * Choose from the stack's members, ordered from the bottom layer to the top.
 * Closed layers are ignored, so a stack whose bottom already merged is judged by its open layers.
 */
export function choose(current: number, members: readonly Member[]): Selection {
  const open = members.filter((member) => member.state === "open");
  const top = open.at(-1);
  if (!top || !open.some((member) => member.number === current)) {
    return Everything(`#${current} is not an open layer of its stack; checking it on its own base.`);
  }
  if (top.number !== current) {
    return {
      selected: false,
      baseSha: "",
      reason: `#${top.number} is the top of this stack; it runs the combined checks.`,
    };
  }
  const base = open[0]!.base.sha;
  return {
    selected: true,
    baseSha: base,
    reason: `#${current} is the top of a ${open.length}-layer stack; comparing with ${base}.`,
  };
}

/** Read the stack of the event's pull request and choose. Never throws: errors select everything. */
export async function resolve(context: Context, request: Request = fetch): Promise<Selection> {
  if (context.event !== "pull_request" || context.pull === undefined) {
    return Everything(`A ${context.event} run is not part of a pull request stack.`);
  }
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${context.token}`,
    "X-GitHub-Api-Version": "2026-03-10",
  };
  const root = `${context.api}/repos/${context.repository}`;
  try {
    const pull = await read(request, `${root}/pulls/${context.pull}`, headers);
    const stack = (pull as { stack?: { number?: unknown } | null }).stack?.number;
    if (typeof stack !== "number") return Everything(`#${context.pull} is not in a stack.`);
    const body = await read(request, `${root}/stacks/${stack}`, headers);
    const members = (body as { pull_requests?: unknown }).pull_requests;
    if (!Array.isArray(members) || !members.every(isMember)) {
      return Everything(`Stack ${stack} has an unexpected shape; checking #${context.pull} on its own base.`);
    }
    return choose(context.pull, members);
  } catch (error) {
    return Everything(
      `Could not read the stack (${(error as Error).message}); checking #${context.pull} on its own base.`,
    );
  }
}

/** Fetch JSON or throw with the HTTP status, which `resolve` turns into a safe selection. */
async function read(request: Request, url: string, headers: Record<string, string>): Promise<unknown> {
  const response = await request(url, { headers });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).pathname}`);
  return response.json();
}

/** Accept only members with the three fields `choose` reads. */
function isMember(value: unknown): value is Member {
  const member = value as Partial<Member> | null;
  return typeof member?.number === "number" && typeof member.state === "string" &&
    typeof member.base?.sha === "string";
}

if (import.meta.main) {
  const env = process.env;
  const payload = env.GITHUB_EVENT_PATH
    ? JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8")) as { pull_request?: { number?: number } }
    : {};
  const selection = await resolve({
    event: env.GITHUB_EVENT_NAME ?? "",
    pull: payload.pull_request?.number,
    repository: env.GITHUB_REPOSITORY ?? "",
    api: env.GITHUB_API_URL ?? "https://api.github.com",
    token: env.GITHUB_TOKEN ?? "",
  });
  console.log(selection.reason);
  const output = `selected=${selection.selected}\nbase-sha=${selection.baseSha}\n`;
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, output);
  else process.stdout.write(output);
}
