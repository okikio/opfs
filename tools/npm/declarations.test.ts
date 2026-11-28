import { describe, it } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect } from "@std/expect";
import { withReleases } from "../../tests/close.ts";
import { preserveDenoDeclarations } from "./declarations.ts";

/** Own a small emitted declaration tree through the assertion and preserve cleanup failures. */
async function withDeclarations(
  files: Readonly<Record<string, string>>,
  action: (directory: string) => Promise<void>,
): Promise<void> {
  await withReleases(async (releases) => {
    const directory = await mkdtemp(join(tmpdir(), "opfs-deno-declarations-"));
    releases.push(() => rm(directory, { recursive: true, force: true }));
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({
        exports: { "./driver/deno": { import: "./esm/deno/driver.js" } },
      }),
    );
    for (const [path, source] of Object.entries(files)) {
      const destination = join(directory, path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, source);
    }
    await action(directory);
  });
}

describe("native Deno declarations", () => {
  it("preserves a native signature declared directly at the public leaf", async () => {
    const source = "export declare function write(file: Deno.FsFile): void;\n";
    await withDeclarations(
      { "esm/deno/driver.d.ts": source },
      async (directory) => {
        await preserveDenoDeclarations(directory);
        expect(await readFile(join(directory, "esm/deno/driver.d.ts"), "utf8"))
          .toBe(`/// <reference types="deno-types" />\n${source}`);
      },
    );
  });

  it("follows imports, re-exports and import types through a cyclic declaration graph", async () => {
    const source = 'export { NativeFile } from "./file.js";\nexport interface Metadata { readonly host: "deno"; }\n';
    const file = 'import type { File } from "./types.js";\n' +
      'export declare class NativeFile { constructor(file: File); readonly metadata: import("./driver.js").Metadata; }\n';
    await withDeclarations({
      "esm/deno/driver.d.ts": source,
      "esm/deno/file.d.ts": file,
      "esm/deno/types.d.ts": "export type File = Deno.FsFile;\n",
    }, async (directory) => {
      await preserveDenoDeclarations(directory);
      await preserveDenoDeclarations(directory);
      expect(await readFile(join(directory, "esm/deno/driver.d.ts"), "utf8"))
        .toBe(`/// <reference types="deno-types" />\n${source}`);
      expect(await readFile(join(directory, "esm/deno/file.d.ts"), "utf8"))
        .toBe(file);
      expect(await readFile(join(directory, "esm/deno/types.d.ts"), "utf8"))
        .toBe("export type File = Deno.FsFile;\n");
    });
  });

  it("does not treat comment or string text as a native file type", async () => {
    const source = '/** Deno.FsFile is only mentioned here. */\nexport type Label = "Deno.FsFile";\n';
    await withDeclarations(
      { "esm/deno/driver.d.ts": source },
      async (directory) => {
        await expect(preserveDenoDeclarations(directory)).rejects.toThrow(
          /lost its Deno\.FsFile contract/u,
        );
        expect(await readFile(join(directory, "esm/deno/driver.d.ts"), "utf8"))
          .toBe(source);
      },
    );
  });

  it("does not accept a native type in a declaration the public leaf cannot reach", async () => {
    await withDeclarations({
      "esm/deno/driver.d.ts": "export type Size = number;\n",
      "esm/deno/unused.d.ts": "export type File = Deno.FsFile;\n",
    }, async (directory) => {
      await expect(preserveDenoDeclarations(directory)).rejects.toThrow(
        /lost its Deno\.FsFile contract/u,
      );
    });
  });

  it("requires every relative target before adding the directive", async () => {
    const source = 'export type File = Deno.FsFile;\nexport * from "./missing.js";\n';
    await withDeclarations(
      { "esm/deno/driver.d.ts": source },
      async (directory) => {
        await expect(preserveDenoDeclarations(directory)).rejects.toMatchObject(
          { code: "ENOENT" },
        );
        expect(await readFile(join(directory, "esm/deno/driver.d.ts"), "utf8"))
          .toBe(source);
      },
    );
  });

  it("refuses declaration imports outside the owned package", async () => {
    const source = 'export type File = Deno.FsFile;\nexport * from "../../../outside.js";\n';
    await withDeclarations(
      { "esm/deno/driver.d.ts": source },
      async (directory) => {
        await expect(preserveDenoDeclarations(directory)).rejects.toThrow(
          /outside the npm package/u,
        );
        expect(await readFile(join(directory, "esm/deno/driver.d.ts"), "utf8"))
          .toBe(source);
      },
    );
  });

  it("reports malformed declaration syntax with its owning file", async () => {
    await withDeclarations(
      { "esm/deno/driver.d.ts": "export type File = ;\n" },
      async (directory) => {
        await expect(preserveDenoDeclarations(directory)).rejects.toThrow(
          /Cannot inspect declaration .*driver\.d\.ts/u,
        );
      },
    );
  });
});
