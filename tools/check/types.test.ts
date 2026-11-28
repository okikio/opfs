import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { groupFiles, usesBunTypes } from "./types.ts";

describe("Bun type dependencies", () => {
  const dependencies = {
    "side-effect import": 'import "bun-types";',
    "named import": 'import { file } from "bun";',
    "type-only import": 'import type { BunFile } from "bun-types";',
    "inline type-only import": 'import { type BunFile } from "bun-types";',
    "named re-export": 'export { file } from "bun";',
    "type-only re-export": 'export type { BunFile } from "bun-types";',
    "star re-export": 'export * from "bun:sqlite";',
    "nested dynamic import": 'async function open() { return import("bun:sqlite"); }',
    "literal template import": "async function open() { return import(`bun:sqlite`); }",
    "import type expression": 'type File = import("bun-types").BunFile;',
    "typeof import expression": 'type Bun = typeof import("bun");',
    "TypeScript external module reference": 'import Bun = require("bun-types");',
    "escaped module name": 'import "bun\\x2dtypes";',
    "leading type reference": '// License\n/// <reference types="bun-types" />\nexport {};',
    "type reference with another attribute": "/// <reference preserve=\"true\" types='bun-types' />\nexport {};",
  };
  for (const [name, source] of Object.entries(dependencies)) {
    it(`recognizes ${name}`, () => {
      expect(usesBunTypes("dependency.ts", source)).toBe(true);
    });
  }

  const examples = {
    "quoted fixture": "const fixture = 'import \"bun-types\";';",
    "module-name string": 'const name = "bun:sqlite";',
    "template fixture": 'const fixture = `import("bun:sqlite")`;',
    "line comment": '// import "bun-types";\nexport {};',
    "block comment": '/* import "bun:sqlite"; */\nexport {};',
    "type reference in a block comment": '/* /// <reference types="bun-types" /> */\nexport {};',
    "type reference after code": 'export {};\n/// <reference types="bun-types" />',
    "type reference after a directive": "'use strict';\n/// <reference types=\"bun-types\" />\nexport {};",
    "type-reference text inside another attribute": "/// <reference data=\"types='bun-types'\" />\nexport {};",
    "similarly named dependency": 'import "bun-types-extra";',
    "computed import": 'const name = "bun:sqlite"; const module = import(name);',
  };
  for (const [name, source] of Object.entries(examples)) {
    it(`ignores ${name}`, () => {
      expect(usesBunTypes("example.ts", source)).toBe(false);
    });
  }

  it("reports the source path when syntax prevents classification", () => {
    expect(() => usesBunTypes("broken.ts", "import {")).toThrow(/broken\.ts/);
  });
});

describe("tracked TypeScript selection", () => {
  it("preserves guidance and installed-consumer owners while checking local programs", () => {
    const root = mkdtempSync(join(tmpdir(), "opfs-type-selection-"));
    try {
      // The index includes both copied examples and local validation, just as a staged adoption does.
      const files: Readonly<Record<string, string>> = {
        "mod.ts": "export {};\n",
        "tests/fixtures.test.ts": "const fixture = 'import \"bun-types\";';\nexport { fixture };\n",
        "tests/package/prepare.ts": "export {};\n",
        "tests/package/consumer/deno.json": "{}\n",
        "tests/package/consumer/types/portable.ts":
          "// @ts-expect-error The source host must not satisfy this assertion.\nvoid Deno;\nexport {};\n",
        "tests/package/consumer/types/deno.ts": "declare const file: Deno.FsFile;\nexport { file };\n",
        ".agents/validation/deno.jsonc": "{}\n",
        ".agents/validation/run.ts": "export {};\n",
        ".agents/validation/snapshot.test.ts": "export {};\n",
        ".agents/skills-local/check.ts": "export {};\n",
        ".agents/guides/example.ts": "export {};\n",
        ".agents/references/example.mts": "export {};\n",
        ".agents/handbook/deno.jsonc": "{}\n",
        ".agents/handbook/example.ts": "export {};\n",
        ".agents/skills/deno-software/deno.json": "{}\n",
        ".agents/skills/deno-software/examples/server.ts": "export {};\n",
        ".agents/skills/deno-software/scripts/validate.ts": 'import "bun-types";\n',
      };
      for (const [name, source] of Object.entries(files)) {
        const path = join(root, name);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, source);
      }
      execFileSync("git", ["init", "--quiet", root]);
      execFileSync("git", ["-C", root, "add", "."]);

      expect(groupFiles(root)).toEqual([
        {
          bun: false,
          files: [".agents/skills-local/check.ts", "mod.ts", "tests/fixtures.test.ts", "tests/package/prepare.ts"],
        },
        {
          config: ".agents/validation/deno.jsonc",
          bun: false,
          files: [".agents/validation/run.ts", ".agents/validation/snapshot.test.ts"],
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
