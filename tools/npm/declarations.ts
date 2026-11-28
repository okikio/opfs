/** Preserve native Deno types across the npm build's emitted module graph. @module */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type ESTree, parseSync, Visitor } from "rolldown/utils";

/** This explicit leaf reference keeps Deno globals out of portable ambient discovery. */
const denoReference = '/// <reference types="deno-types" />\n';

/** The npm builder emits one ESM import target per public subpath. */
interface ManifestType {
  readonly exports?: Readonly<Record<string, { readonly import?: string }>>;
}

/** Resolve an emitted local module to its declaration without leaving the package directory. */
function declarationPath(root: string, parent: string, specifier: string): string {
  const target = specifier.endsWith(".d.ts")
    ? specifier
    : specifier.endsWith(".js")
    ? `${specifier.slice(0, -3)}.d.ts`
    : undefined;
  if (target === undefined) {
    throw new Error(`Native Deno declarations reference an unsupported emitted module: ${specifier}`);
  }
  const path = resolve(parent, target);
  const contained = relative(root, path);
  if (contained === ".." || contained.startsWith(`..${sep}`) || isAbsolute(contained)) {
    throw new Error(`Native Deno declarations reference a file outside the npm package: ${specifier}`);
  }
  return path;
}

/** Parse real dependency and type syntax; comments and string values cannot establish a native file contract. */
function inspectDeclaration(path: string, source: string): { dependencies: readonly string[]; nativeFile: boolean } {
  const parsed = parseSync(path, source);
  const failure = parsed.errors[0];
  if (failure !== undefined) throw new SyntaxError(`Cannot inspect declaration ${path}: ${failure.message}`);
  const dependencies = new Set<string>();
  let nativeFile = false;

  /** Only a module-bearing AST node can add a declaration edge. */
  function dependency(node: ESTree.Expression | null): void {
    if (node?.type === "Literal" && typeof node.value === "string") dependencies.add(node.value);
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
    TSImportType(node) {
      dependency(node.source);
    },
    TSExternalModuleReference(node) {
      dependency(node.expression);
    },
    TSTypeReference(node) {
      const name = node.typeName;
      nativeFile ||= name.type === "TSQualifiedName" && name.left.type === "Identifier" &&
        name.left.name === "Deno" && name.right.name === "FsFile";
    },
  }).visit(parsed.program);
  return { dependencies: [...dependencies], nativeFile };
}

/**
 * Attach the official Deno declaration dependency to its public npm leaf.
 *
 * Follow emitted relative imports, re-exports and import types before changing
 * the leaf. Every reachable local declaration must exist, and the graph must
 * retain a real `Deno.FsFile` type reference. Re-exporting the resource owners
 * therefore needs no duplicate signature in the entrypoint. External package
 * types and the complete API remain the installed consumer compiler's contract.
 */
export async function preserveDenoDeclarations(directory: string): Promise<void> {
  const root = resolve(directory);
  const manifest: ManifestType = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const runtime = manifest.exports?.["./driver/deno"]?.import;
  if (typeof runtime !== "string" || !runtime.endsWith(".js")) {
    throw new Error("The native Deno driver must have one emitted ESM entrypoint.");
  }
  const entry = declarationPath(root, root, runtime);
  // Set iteration visits added paths once, including graphs whose declarations form a cycle.
  const files = new Set([entry]);
  let declaration = "";
  let nativeFile = false;
  for (const path of files) {
    const source = await readFile(path, "utf8");
    if (path === entry) declaration = source;
    const inspected = inspectDeclaration(path, source);
    nativeFile ||= inspected.nativeFile;
    for (const specifier of inspected.dependencies) {
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) continue;
      files.add(declarationPath(root, dirname(path), specifier));
    }
  }
  if (!nativeFile) throw new Error("The native Deno declaration graph lost its Deno.FsFile contract.");
  // dnt drops the source directive. Place it before all code, once, after the entire local graph passes.
  if (!declaration.startsWith(denoReference)) await writeFile(entry, `${denoReference}${declaration}`);
}
