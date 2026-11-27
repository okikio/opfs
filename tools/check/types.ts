/**
 * Type-check tracked repository TypeScript programs in their target environments.
 *
 * Deno checks the repository with `deno.json`'s compiler options, which include the DOM and Deno namespaces.
 * Files that load Bun's type definitions are checked in a second `deno check` call: Bun's globals redeclare
 * `URL`, `fetch` and others, and checking them together with everything else reports false errors in files
 * that never run on Bun. Bun dependencies are selected from parsed imports, re-exports, import types and literal
 * dynamic imports, or a leading triple-slash type reference. Strings and ordinary comments do not select a host.
 *
 * A folder with its own `deno.json` (the npm build tool, for example) is checked with that configuration, since
 * its import map is not the package's. Copied guidance owns its examples and configurations upstream, so the
 * four maintained guidance folders under `.agents/` are inert here. Local agent validation remains checked.
 *
 * TypeScript itself then checks the browser and worker projects (`tsconfig.opfs-dom.json` and
 * `tsconfig.opfs-worker.json`), which pin the exact DOM and worker library sets the OPFS driver supports.
 *
 * @module
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { type ESTree, parseSync, Visitor } from "rolldown/utils";
import { spawn } from "../spawn.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));

/** Upstream snapshots, copied guidance and generated declarations are data, not repository programs. */
const inert = [
  /^tests\/upstream\/original\//u,
  /^\.agents\/(?:guides|references|skills|handbook)\//u,
  /\.d\.ts$/u,
];

/** Module names that load Bun's ambient declarations under this repository's import configuration. */
function bunModule(name: string | undefined): boolean {
  return name === "bun-types" || name === "bun" || name?.startsWith("bun:") === true;
}

/**
 * Select Bun's compiler environment from dependency syntax, without executing source or interpreting fixture text.
 * Rolldown exposes the existing Oxc parser without Vite's unrelated import-time host probes.
 * Invalid syntax fails with its source path; it cannot silently assign a file to another environment.
 * Computed import expressions do not establish a literal type dependency.
 */
export function usesBunTypes(file: string, source: string): boolean {
  const parsed = parseSync(file, source);
  const failure = parsed.errors[0];
  if (failure !== undefined) throw new SyntaxError(`Cannot classify Bun dependencies in ${file}: ${failure.message}`);
  let found = false;

  /** Only a module-bearing AST node may supply this value; unrelated literals never reach it. */
  function dependency(node: ESTree.Expression | null): void {
    const name = node?.type === "Literal" && typeof node.value === "string"
      ? node.value
      : node?.type === "TemplateLiteral" && node.expressions.length === 0
      ? node.quasis[0]?.value.cooked ?? undefined
      : undefined;
    found ||= bunModule(name);
  }

  new Visitor({
    ImportDeclaration(node) {
      dependency(node.source);
    },
    ExportNamedDeclaration(node) {
      dependency(node.source);
    },
    ExportAllDeclaration(node) {
      dependency(node.source);
    },
    ImportExpression(node) {
      dependency(node.source);
    },
    TSImportType(node) {
      dependency(node.source);
    },
    TSExternalModuleReference(node) {
      dependency(node.expression);
    },
  }).visit(parsed.program);
  if (found) return true;

  // TypeScript admits reference directives only before code; Oxc includes directive prologues in this body.
  const firstCode = parsed.program.body[0]?.start ?? source.length;
  for (const comment of parsed.comments) {
    if (comment.type !== "Line" || comment.start >= firstCode) continue;
    // The parser has already isolated a real line comment. Match a triple-slash reference and its quoted attributes.
    const reference = /^\/\s*<reference((?:\s+[\w-]+\s*=\s*(?:"[^"]*"|'[^']*'))+)\s*\/>/u.exec(comment.value);
    if (reference === null) continue;
    for (const attribute of reference[1]!.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)) {
      if (attribute[1] === "types" && bunModule(attribute[2] ?? attribute[3])) return true;
    }
  }
  return false;
}

/** Files to check together, and the Deno configuration they use (`undefined` means the root `deno.json`). */
export interface GroupType {
  readonly config?: string;
  readonly bun: boolean;
  readonly files: string[];
}

/** Paths tracked by Git, including staged additions, that match `patterns`. */
const list = (base: string, ...patterns: string[]) =>
  execFileSync("git", ["-C", base, "ls-files", "-z", "--", ...patterns], { encoding: "utf8" }).split("\0")
    .filter(Boolean);

/** Tracked repository programs, grouped by their owned Deno configuration and whether they load Bun's types. */
export function groupFiles(base = root): GroupType[] {
  const configs = list(base, "*/deno.json", "*/deno.jsonc")
    .filter((file) => !inert.some((pattern) => pattern.test(file)))
    .map((file) => file.slice(0, file.lastIndexOf("/") + 1));
  const result = new Map<string, GroupType>();
  for (const file of list(base, "*.ts", "*.mts")) {
    if (inert.some((pattern) => pattern.test(file))) continue;
    const folder = configs.find((prefix) => file.startsWith(prefix));
    const config = folder && list(base, `${folder}deno.json`).length
      ? `${folder}deno.json`
      : folder && `${folder}deno.jsonc`;
    const usesBun = usesBunTypes(file, readFileSync(`${base}/${file}`, "utf8"));
    const key = `${config ?? ""}|${usesBun}`;
    const group = result.get(key) ?? { ...(config ? { config } : {}), bun: usesBun, files: [] };
    group.files.push(file);
    result.set(key, group);
  }
  return [...result.values()];
}

/** Run one checker and report whether it passed, so every group still runs after one fails. */
function passes(program: string, args: readonly string[]): boolean {
  try {
    spawn(program, args);
    return true;
  } catch (reason) {
    console.error((reason as Error).message);
    return false;
  }
}

if (import.meta.main) {
  const results = [
    ...groupFiles().map((group) =>
      passes("deno", [
        "check",
        "--quiet",
        // A nested configuration has no lockfile of its own; `--no-lock` keeps the check from writing one.
        ...(group.config ? ["--config", group.config, "--no-lock"] : ["--frozen", "--unstable-kv"]),
        ...group.files,
      ])
    ),
    passes("node", ["node_modules/typescript/bin/tsc", "-p", "tsconfig.opfs-dom.json"]),
    passes("node", ["node_modules/typescript/bin/tsc", "-p", "tsconfig.opfs-worker.json"]),
  ];
  process.exitCode = results.every(Boolean) ? 0 : 1;
}
