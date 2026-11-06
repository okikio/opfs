/** Checks the retained planning handoff, not implemented storage support.
 *
 * Run `node planning/storage/research/validate.ts` from any directory. Optional
 * `--input-dir` and `--original-plan` compare the retained files with the original
 * handoffs. This command reads local files and prints a JSON receipt; it does
 * not fetch URLs, load providers, or certify the implementations in the catalog.
 * @module
 */
import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

type RecordType = { id: string; [key: string]: unknown };
type CatalogType = { entries: RecordType[]; metadata: unknown };
type CrosswalkType = {
  links: { focused_id: string; parent_ids: string[] }[];
  unmapped_focused_ids: string[];
  parent_sha256: string;
};
type PreviewType = {
  entries: { source_record: RecordType; preview_plan: { status: string } }[];
  input_metadata: unknown;
  crosswalk: CrosswalkType;
};

const root = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: { "input-dir": { type: "string" }, "original-plan": { type: "string" } },
});
const load = async (name: string): Promise<unknown> => JSON.parse(await readFile(resolve(root, name), "utf8"));
const digest = async (path: string): Promise<string> => createHash("sha256").update(await readFile(path)).digest("hex");

/** Duplicate identities would make set comparisons hide missing catalog rows. */
function ids(entries: RecordType[]): Set<string> {
  const result = new Set(entries.map((entry) => entry.id));
  strictEqual(result.size, entries.length, "Duplicate IDs");
  return result;
}

/** Parse quoted fields, escaped quotes and CRLF without splitting embedded lines.
 * The retained CSV is a planning input, so malformed quoting fails admission.
 */
function csv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let closed = false;
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (quoted) {
      if (char !== '"') field += char;
      else if (text[at + 1] === '"') {
        field += '"';
        at++;
      } else {
        quoted = false;
        closed = true;
      }
      continue;
    }
    if (char === '"') {
      ok(field === "" && !closed, "Unexpected CSV quote");
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
      closed = false;
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[at + 1] === "\n") at++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      closed = false;
    } else {
      ok(!closed, "Characters follow a closed CSV field");
      field += char;
    }
  }
  ok(!quoted, "Unclosed CSV field");
  if (row.length || field || closed) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const catalog = await load("catalog.json") as CatalogType;
const formats = await load("formats.json") as CatalogType;
const routes = await load("routing.json") as CatalogType;
const preview = await load("preview-routing.json") as PreviewType;
const crosswalk = await load("crosswalk.json") as CrosswalkType;
const implementations = await load("implementations.json") as unknown[];
const catalogIds = ids(catalog.entries);
const formatIds = ids(formats.entries);
strictEqual(catalogIds.size, 895);
strictEqual(formatIds.size, 136);
strictEqual(implementations.length, 14);
deepStrictEqual(ids(routes.entries), catalogIds);
deepStrictEqual(ids(preview.entries.map((row) => row.source_record)), formatIds);
deepStrictEqual(preview.input_metadata, formats.metadata);
deepStrictEqual(preview.crosswalk, crosswalk);
deepStrictEqual(preview.entries.map((row) => row.source_record), formats.entries);
ok(preview.entries.every((row) => row.preview_plan.status === "proposed-not-implemented"));
deepStrictEqual(
  new Set([...crosswalk.links.map((row) => row.focused_id), ...crosswalk.unmapped_focused_ids]),
  formatIds,
);
ok(crosswalk.links.every((row) => row.parent_ids.every((id) => catalogIds.has(id))));
const parentSha = "7fc1fefdfea648cfab176f38b6351b8b5c4d547b5a259ef103861aef8b6851b5";
strictEqual(await digest(resolve(root, "catalog.json")), parentSha);
strictEqual(crosswalk.parent_sha256, parentSha);
const [header, ...rows] = csv(await readFile(resolve(root, "routing.csv"), "utf8"));
ok(header, "Routing CSV must have a header");
const idColumn = header.indexOf("id");
ok(idColumn >= 0);
strictEqual(rows.length, 895);
ok(rows.every((row) => row.length === header.length));
deepStrictEqual(new Set(rows.map((row) => row[idColumn])), catalogIds);

let linksChecked = 0;
const names = (await readdir(root)).sort();
for (const name of names.filter((name) => name.endsWith(".md"))) {
  const text = await readFile(resolve(root, name), "utf8");
  for (const [, destination] of text.matchAll(/\]\(([^)]+)\)/gu)) {
    ok(destination, "A Markdown link must capture its destination");
    if (/^(https?:\/\/|mailto:|#)/u.test(destination)) continue;
    const target = destination.split("#")[0] ?? "";
    ok(!isAbsolute(target), `Nonportable link: ${name}: ${target}`);
    ok((await stat(resolve(root, target))).isFile(), `Broken link: ${name}: ${target}`);
    linksChecked++;
  }
}
const originalChecks: string[] = [];
async function compare(directory: string, pairs: Record<string, string>): Promise<void> {
  for (const [retained, original] of Object.entries(pairs)) {
    deepStrictEqual(await readFile(resolve(root, retained)), await readFile(resolve(directory, original)), retained);
    originalChecks.push(retained);
  }
}
if (values["input-dir"]) {
  await compare(values["input-dir"], {
    "formats.json": "formats-and-profiles.json",
    "implementations.json": "implementation-matrix.json",
    "crosswalk.json": "catalog-crosswalk.json",
    "archive-research.md": "archive-encryption-review.md",
  });
}
if (values["original-plan"]) {
  await compare(
    values["original-plan"],
    Object.fromEntries(
      ["catalog.json", "routing.json", "routing.csv", "catalog-research.md", "protocol-research.md"].map((
        name,
      ) => [name, name]),
    ),
  );
}
const files: Record<string, string> = {};
for (const name of names) {
  const path = resolve(root, name);
  if ((await stat(path)).isFile() && name !== "validation.json" && !name.endsWith(".zip")) {
    files[name] = await digest(path);
  }
}
console.log(JSON.stringify(
  {
    scope: "Planning artifact only; no implementation, interoperability, CI, security or benchmark certification",
    passed: true,
    catalog_records: 895,
    focused_records: 136,
    implementation_comparisons: 14,
    parent_catalog_sha256: parentSha,
    source_records_and_crosswalk_preserved: true,
    all_routes_proposed_not_implemented: true,
    local_markdown_links_checked: linksChecked,
    original_files_compared: originalChecks,
    file_sha256: files,
  },
  null,
  2,
));
