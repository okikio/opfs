/**
 * Record the package's public symbols per subpath, and fail when they change without a recorded decision.
 *
 * `node tools/check/exports.ts [--write]`
 *
 * Every subpath in `deno.json` `exports` is a compatibility surface: a consumer imports `@okikio/opfs/archive/xz` and
 * expects `openXz` to be there. Moving a source file changes only the right side of that map, but renaming or dropping
 * a symbol breaks consumers. This check runs `deno doc --json` over every entry point and compares each subpath's
 * symbol names and kinds with `tests/package/exports.json`:
 *
 * ```text
 *   deno.json exports ─► deno doc --json ─► { "./archive/xz": ["function openXz", …] } ─► compare with the record
 * ```
 *
 * `--write` (the `build:exports` task) rewrites the record. A pull request that changes the public API therefore
 * shows the change as a diff of that file, beside the changeset that explains it to consumers.
 *
 * @module
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

/** The committed record of public symbols, one sorted list per subpath. */
const record = `${root}tests/package/exports.json`;

/** One file's part of `deno doc --json`: each top-level symbol and how it is declared. */
interface DocFileType {
  readonly symbols: readonly { readonly name: string; readonly declarations: readonly { readonly kind: string }[] }[];
}

/** Public symbols per subpath, as `"<kind> <name>"` strings sorted by name. Re-exports have the kind `reference`. */
export function read(base = root): Record<string, string[]> {
  const map = (JSON.parse(readFileSync(`${base}deno.json`, "utf8")) as { exports: Record<string, string> }).exports;
  const files = [...new Set(Object.values(map))].sort();
  const output = execFileSync("deno", ["doc", "--json", ...files], {
    cwd: base,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const nodes = (JSON.parse(output) as { nodes: Record<string, DocFileType> }).nodes;
  return Object.fromEntries(
    Object.entries(map).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([subpath, file]) => {
      const symbols = nodes[pathToFileURL(`${base}${file.replace(/^\.\//u, "")}`).href]?.symbols ?? [];
      const names = symbols.map((symbol) => `${symbol.declarations[0]?.kind ?? "unknown"} ${symbol.name}`);
      return [subpath, names.sort((a, b) => a.split(" ")[1]!.localeCompare(b.split(" ")[1]!))];
    }),
  );
}

/** Lines that differ between two records, as `+ subpath: symbol` and `- subpath: symbol`. */
export function compare(recorded: Record<string, string[]>, actual: Record<string, string[]>): string[] {
  const lines: string[] = [];
  for (const subpath of new Set([...Object.keys(recorded), ...Object.keys(actual)])) {
    const before = new Set(recorded[subpath] ?? []), after = new Set(actual[subpath] ?? []);
    for (const symbol of before) if (!after.has(symbol)) lines.push(`- ${subpath}: ${symbol}`);
    for (const symbol of after) if (!before.has(symbol)) lines.push(`+ ${subpath}: ${symbol}`);
  }
  return lines;
}

if (import.meta.main) {
  const actual = read();
  if (process.argv.includes("--write")) {
    writeFileSync(record, `${JSON.stringify(actual, null, 2)}\n`);
    console.log(`Recorded ${Object.keys(actual).length} subpaths in tests/package/exports.json.`);
  } else {
    let recorded: Record<string, string[]> = {};
    try {
      recorded = JSON.parse(readFileSync(record, "utf8"));
    } catch {
      // A missing record is a difference like any other: every symbol is reported as added.
    }
    const changes = compare(recorded, actual);
    if (changes.length) {
      console.error(changes.join("\n"));
      console.error("The public API changed. Run `mise run build:exports` and add a changeset that explains it.");
      process.exitCode = 1;
    } else console.log(`Public symbols match tests/package/exports.json (${Object.keys(actual).length} subpaths).`);
  }
}
