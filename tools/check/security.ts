/**
 * Check locked dependencies against published advisories, with reviewed exceptions only.
 *
 * Two scanners read the lockfiles:
 *
 * - `deno audit` reads `deno.lock`, the one lockfile that decides what `deno ci` installs.
 * - `osv-scanner` reads the lockfiles and manifests it finds in the repository, as an independent second source.
 *
 * Exceptions live in one file, `osv-scanner.toml`, as osv-scanner's own `[[IgnoredVulns]]` entries. Every
 * entry needs an `id`, a `reason` and an `ignoreUntil` date. An expired or incomplete entry fails the check,
 * so an exception is reviewed again rather than renewed silently. osv-scanner applies the file natively.
 * `deno audit --ignore` accepts only CVE ids and does not match these advisories, so this program reads the
 * advisory ids from deno audit's report and fails on any id the file does not list.
 *
 * Run it with `mise run check:security`. It needs network access to both advisory databases.
 * @module
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

/** One reviewed advisory exception from `osv-scanner.toml`. */
export interface ExceptionType {
  /** Advisory id, for example `GHSA-3g3m-2fjr-6pw4`. */
  readonly id: string;
  /** Why the advisory does not apply, or why it is accepted for now. */
  readonly reason: string;
  /** Last day (UTC, `YYYY-MM-DD`) the exception applies. */
  readonly until: string;
}

const root = fileURLToPath(new URL("../../", import.meta.url));
const config = "osv-scanner.toml";

/**
 * Validate parsed `[[IgnoredVulns]]` entries and return them. Throws on a missing id or reason, a malformed
 * date, or a date before `today`, naming every problem at once.
 */
export function parseExceptions(entries: readonly unknown[], today: string): readonly ExceptionType[] {
  const problems: string[] = [];
  const admitted: ExceptionType[] = [];
  entries.forEach((value, index) => {
    const entry = (value ?? {}) as Record<string, unknown>;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const reason = typeof entry.reason === "string" ? entry.reason.trim() : "";
    const until = typeof entry.ignoreUntil === "string" ? entry.ignoreUntil.slice(0, 10) : "";
    const name = id || `entry ${index + 1}`;
    if (!id) problems.push(`${name}: missing id`);
    if (!reason) problems.push(`${name}: missing reason`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) problems.push(`${name}: ignoreUntil must be a YYYY-MM-DD date`);
    else if (until < today) problems.push(`${name}: expired on ${until}; review it again`);
    if (id && reason && until >= today) admitted.push({ id, reason, until });
  });
  if (problems.length > 0) throw new Error(`${config} has invalid exceptions:\n  ${problems.join("\n  ")}`);
  return admitted;
}

/** Advisory ids that a `deno audit` report names, in report order without repeats. */
export function parseAdvisories(report: string): readonly string[] {
  const ids = [...stripVTControlCharacters(report).matchAll(/github\.com\/advisories\/(GHSA(?:-[0-9a-z]{4}){3})/g)]
    .map((match) => match[1]!);
  return [...new Set(ids)];
}

/** TOML local dates (`ignoreUntil = 2027-02-21`) quoted, so yq can parse a copy; the file is never edited. */
export function quoteDates(toml: string): string {
  return toml.replace(/^(\s*ignoreUntil\s*=\s*)(\d{4}-\d{2}-\d{2})(\s*(?:#.*)?)$/gm, '$1"$2"$3');
}

/** Read and validate the exceptions file; an absent file means no exceptions. */
function readExceptions(today: string): readonly ExceptionType[] {
  let toml: string;
  try {
    toml = readFileSync(`${root}${config}`, "utf8");
  } catch {
    return [];
  }
  const parsed = spawnSync("mise", ["exec", "yq", "--", "yq", "-p", "toml", "-o", "json", "-"], {
    cwd: root,
    input: quoteDates(toml),
    encoding: "utf8",
  });
  if (parsed.status !== 0) throw new Error(`yq could not parse ${config}:\n${parsed.stderr}`);
  const data = JSON.parse(parsed.stdout) as { IgnoredVulns?: unknown[] };
  return parseExceptions(data?.IgnoredVulns ?? [], today);
}

/** Run deno audit; pass when it finds nothing or only listed advisories. */
function scanDeno(allowed: ReadonlySet<string>): boolean {
  const result = spawnSync("deno", ["audit", "--frozen-lockfile"], { cwd: root, encoding: "utf8" });
  const report = `${result.stdout}${result.stderr}`;
  if (result.status === 0) {
    console.log("deno audit: no known advisories in deno.lock.");
    return true;
  }
  const found = parseAdvisories(report);
  if (found.length === 0) {
    // A failure that names no advisory is a tool or network error, not a clean result.
    console.error(`deno audit failed without naming an advisory:\n${report}`);
    return false;
  }
  const unlisted = found.filter((id) => !allowed.has(id));
  if (unlisted.length > 0) {
    console.error(report);
    console.error(`deno audit: ${unlisted.join(", ")} not covered by ${config}.`);
    return false;
  }
  console.log(`deno audit: ${found.length} advisories, all covered by reviewed exceptions in ${config}.`);
  return true;
}

/** Run osv-scanner over every lockfile, with the same exceptions file. */
function scanOsv(): boolean {
  const result = spawnSync(
    "osv-scanner",
    [
      "scan",
      "source",
      "--recursive",
      "--allow-no-lockfiles",
      "--format=vertical",
      "--verbosity=error",
      `--config=${config}`,
      ".",
    ],
    { cwd: root, stdio: "inherit" },
  );
  return result.status === 0;
}

if (import.meta.main) {
  const today = new Date().toISOString().slice(0, 10);
  const allowed = new Set(readExceptions(today).map((entry) => entry.id));
  console.log("==> deno audit");
  const denoOk = scanDeno(allowed);
  console.log("==> osv-scanner");
  const osvOk = scanOsv();
  process.exitCode = denoOk && osvOk ? 0 : 1;
}
