/**
 * Runs selected complete Markdown examples and checks their printed values and behavioral assertions.
 *
 * Documentation owns each executable body. This task owns only selection,
 * source-entry resolution, bounded execution and independently specified outputs.
 * With --check, one bounded Deno compiler checks the same extracted programs without running them.
 */
import { deepStrictEqual } from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { argv, execPath, stdout } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

/** One complete fence selected by its enclosing heading, with its expected console arguments. */
interface ExampleType {
  readonly document: string;
  readonly heading: string;
  readonly expected: readonly (readonly unknown[])[];
  /** Additional fixture-owned assertions invoke the extracted declarations, never a copied example. */
  readonly check?: string;
  readonly capture?: boolean;
  readonly fenceIndex?: number;
}

/** Exact printed results are independent of the implementation under test. */
const examples: readonly ExampleType[] = [
  {
    document: "docs/adapters.md",
    heading: "Implement a complete record backend",
    expected: [[false]],
    check: "await checks.records(createRecords);",
  },
  {
    document: "docs/archive.md",
    heading: "Inspect an archive and preview one member",
    expected: [],
    capture: false,
    check: "await checks.archive(preview);",
  },
  {
    document: "docs/source.md",
    heading: "Follow a remote preview",
    expected: [],
    check: "await checks.remote(preview);",
  },
  {
    document: "docs/encryption.md",
    heading: "What a preview verifies",
    expected: [],
    check: "await checks.encrypted(previewEncryptedZip);",
  },
  {
    document: "docs/extensions.md",
    heading: "Publish an independent extension",
    fenceIndex: 0,
    expected: [],
    check: "await checks.extension(createBufferSource);",
  },
  {
    document: "docs/transfer.md",
    heading: "Restart with the saved checkpoint",
    expected: [],
    check: "await checks.transfer(startUpload, continueUpload, InitialCheckpointError);",
  },
  {
    document: "docs/encryption.md",
    heading: "Authenticate selected encrypted ranges",
    expected: [["hello"], ["authenticated-segments"], ["whole-envelope"]],
  },
  {
    document: "docs/model.md",
    heading: "Save a document, then expose a key-value view",
    expected: [["First draft"], ["dark"], ["First draft"]],
  },
  {
    document: "docs/model.md",
    heading: "See what the convenience constructor hides",
    expected: [["First draft"], [1]],
  },
  {
    document: "docs/source.md",
    heading: "Read a range before composing more layers",
    expected: [[[20, 30]], [[20, 30]]],
  },
  {
    document: "docs/api.md",
    heading: "Resize a file without confusing size with the write cursor",
    expected: [[[97, 98, 99, 0, 0, 88]]],
  },
];

/** Refuses malformed metadata rather than falling back to private source paths. */
function exportsFrom(path: string): Readonly<Record<string, string>> {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof value !== "object" || value === null || !("exports" in value)) {
    throw new Error("deno.json must declare public exports.");
  }
  const exports = value.exports;
  if (typeof exports !== "object" || exports === null || Array.isArray(exports)) {
    throw new Error("deno.json exports must be a subpath map.");
  }
  const result: Record<string, string> = {};
  for (const [key, target] of Object.entries(exports)) {
    if (typeof target !== "string" || !target.startsWith("./")) throw new Error(`Unsupported source export: ${key}`);
    result[key] = target;
  }
  return result;
}

/**
 * Selects exactly one TS fence beneath an exact heading.
 * Headings inside code are ignored, and missing/duplicate examples fail visibly.
 */
function extract(markdown: string, example: ExampleType): string {
  if (Buffer.byteLength(markdown) > 1024 * 1024) {
    throw new Error(`${example.document}: document exceeds the 1 MiB extraction budget.`);
  }
  let heading = "";
  let fence: { language: string; heading: string; lines: string[] } | undefined;
  const matches: string[] = [];
  for (const line of markdown.split(/\r?\n/u)) {
    if (fence !== undefined) {
      if (/^```\s*$/u.test(line)) {
        if (fence.language === "ts" && fence.heading === example.heading) matches.push(fence.lines.join("\n"));
        fence = undefined;
      } else fence.lines.push(line);
      continue;
    }
    const start = /^```([\w-]*)\s*$/u.exec(line);
    if (start !== null) {
      fence = { language: start[1]!, heading, lines: [] };
      continue;
    }
    const title = /^#{1,6} (.+)$/u.exec(line);
    if (title !== null) heading = title[1]!;
  }
  if (fence !== undefined) throw new Error(`${example.document}: unterminated Markdown fence.`);
  if (example.fenceIndex === undefined && matches.length !== 1) {
    throw new Error(
      `${example.document} / ${example.heading}: expected one complete TS fence, found ${matches.length}.`,
    );
  }
  const body = matches[example.fenceIndex ?? 0];
  if (body === undefined) throw new Error(`${example.document}: selected fence is absent.`);
  if (Buffer.byteLength(body) > 64 * 1024) {
    throw new Error(`${example.document}: example exceeds the 64 KiB execution budget.`);
  }
  return body;
}

/**
 * Resolves only documented public imports through the current Deno source map.
 * This is source-example evidence; installed-package resolution has its own gate.
 */
function imports(body: string, root: string, exports: Readonly<Record<string, string>>): string {
  const output = body.replace(/\bfrom\s+(["'])@okikio\/opfs([^"']*)\1/gu, (_match, _quote: string, suffix: string) => {
    const key = suffix === "" ? "." : `.${suffix}`;
    const target = exports[key];
    if (target === undefined) throw new Error(`Example imports an undeclared public subpath: @okikio/opfs${suffix}`);
    const path = resolve(root, target);
    const location = relative(root, path);
    if (location === ".." || location.startsWith("../") || location.startsWith("..\\") || !statSync(path).isFile()) {
      throw new Error(`Public export does not name a repository source file: ${key}`);
    }
    return `from ${JSON.stringify(pathToFileURL(path).href)}`;
  });
  if (output.includes("@okikio/opfs")) {
    throw new Error("Example contains an OPFS import outside the admitted static import form.");
  }
  return output;
}

const arguments_ = argv.slice(2);
if (arguments_.length > 1 || (arguments_.length === 1 && arguments_[0] !== "--check")) {
  throw new Error("Usage: node .mise/tasks/examples.ts [--check]");
}
const checking = arguments_[0] === "--check";
const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
const sourceExports = exportsFrom(join(root, "deno.json"));
const reports = join(root, ".tmp", "reports");
mkdirSync(reports, { recursive: true });
if (realpathSync(reports) !== reports) {
  throw new Error("Documentation reports must remain in the repository's physical .tmp/reports directory.");
}
const owned = mkdtempSync(join(reports, "docs-examples-"));
const results: { document: string; heading: string; observed: unknown; stderr: string; behavior?: string }[] = [];
const scripts: string[] = [];
try {
  for (const [index, example] of examples.entries()) {
    const body = extract(readFileSync(join(root, example.document), "utf8"), example);
    const script = join(owned, `example-${index}.ts`);
    writeFileSync(
      script,
      [
        'import { stdout as exampleOutput } from "node:process";',
        `import * as checks from ${JSON.stringify(pathToFileURL(join(root, "tests/fixtures/docs/examples.ts")).href)};`,
        "const observed: unknown[][] = [];",
        `const console = { table(_data?: unknown, _properties?: readonly string[]) {}, log: (...values: unknown[]) => { ${
          example.capture === false ? "" : "observed.push(values);"
        } } };`,
        imports(body, root, sourceExports),
        example.check ?? "",
        "exampleOutput.write(JSON.stringify(observed));",
        "export {};",
        "",
      ].join("\n"),
      { flag: "wx", mode: 0o600 },
    );
    scripts.push(script);
  }
  if (checking) {
    // One compiler owns the complete extracted program set. It never executes examples or fixture assertions.
    const child = spawnSync("deno", ["check", "--config", join(root, "deno.json"), ...scripts], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
      killSignal: "SIGKILL",
    });
    if (child.error !== undefined || child.status !== 0 || child.signal !== null) {
      throw new Error(JSON.stringify({
        mode: "check",
        examples: scripts.length,
        status: child.status,
        signal: child.signal,
        error: child.error?.message,
        stdout: child.stdout?.toString(),
        stderr: child.stderr?.toString(),
      }));
    }
  } else {
    for (const [index, example] of examples.entries()) {
      const script = scripts[index]!;
      const child = spawnSync(execPath, [script], {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10_000,
        maxBuffer: 64 * 1024,
        killSignal: "SIGKILL",
      });
      if (child.error !== undefined || child.status !== 0 || child.signal !== null) {
        throw new Error(
          JSON.stringify({
            document: example.document,
            heading: example.heading,
            status: child.status,
            signal: child.signal,
            error: child.error?.message,
            stdout: child.stdout?.toString(),
            stderr: child.stderr?.toString(),
          }),
        );
      }
      const observed: unknown = JSON.parse(child.stdout.toString("utf8"));
      deepStrictEqual(observed, example.expected, `${example.document} / ${example.heading}: printed result changed.`);
      results.push({
        document: example.document,
        heading: example.heading,
        observed,
        stderr: child.stderr.toString("utf8"),
        ...(example.check === undefined ? {} : { behavior: example.check }),
      });
    }
  }
} finally {
  rmSync(owned, { recursive: true, force: true });
}
stdout.write(
  `${JSON.stringify(checking ? { mode: "check", checkedExamples: scripts.length } : { examples: results }, null, 2)}\n`,
);
