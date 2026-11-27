import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { groupFiles } from "./types.ts";

describe("tracked TypeScript selection", () => {
  it("keeps copied guidance inert while checking local agent programs", () => {
    const root = mkdtempSync(join(tmpdir(), "opfs-type-selection-"));
    try {
      // The index includes both copied examples and local validation, just as a staged adoption does.
      const files: Readonly<Record<string, string>> = {
        "mod.ts": "export {};\n",
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
          files: [".agents/skills-local/check.ts", "mod.ts"],
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
