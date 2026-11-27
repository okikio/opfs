# Dependencies, manifests, imports, and TypeScript configuration

## Contents

- First classify the repository
- What `deno.jsonc` owns
- What `package.json` owns
- `preferPackageJson`
- Imports are dependency and resolution aliases
- Scopes
- Exports are the Deno package API
- JSR versus npm decision model
- `package.json` dependency guidance
- Node modules modes
- Catalogs
- Lockfiles and package-manager ownership
- Supported TypeScript configuration
- Dependency change validation

This reference exists because Deno can consume both Deno-native and Node/npm
project metadata. The files overlap, but they are not interchangeable. Before
editing dependencies, decide which file owns each contract.

## First classify the repository

Record one mode before making changes:

| Mode               | Dependency source of truth                  | Package publication                | Typical use                                 |
| ------------------ | ------------------------------------------- | ---------------------------------- | ------------------------------------------- |
| Deno-first         | `deno.json(c).imports`                      | JSR through `deno publish`         | Deno libraries, services, CLIs              |
| package.json-first | `package.json` dependency fields            | npm through npm-compatible tooling | Existing Node packages and framework apps   |
| Hybrid             | Explicit split documented by the repository | JSR, npm, or both                  | Gradual migration or dual-ecosystem package |

Never infer ownership from file presence alone. A hybrid repository can contain
both files while only one owns dependencies.

## What `deno.jsonc` owns

A Deno config can own:

- import-map entries through `imports` and root-only `scopes`;
- Deno package metadata through `name`, `version`, and `exports`;
- workspace membership;
- Deno tasks;
- lint, format, test, benchmark, lockfile, permission, and compiler policy;
- publication inclusion/exclusion;
- npm resolution behavior such as `nodeModulesDir`;
- supply-chain policy such as `minimumDependencyAge` and `allowScripts`.

It is not a drop-in replacement for all `package.json` fields.

## What `package.json` owns

Use `package.json` when the contract is Node/npm-facing:

- npm `dependencies`, `devDependencies`, `peerDependencies`, and
  `optionalDependencies`;
- npm workspace protocol references such as `workspace:*`;
- npm publication metadata, including `files`, `main`, `module`, `types`, npm
  `exports`, `engines`, and `publishConfig`;
- npm lifecycle scripts;
- package-manager and framework conventions expected by external tooling;
- npm's `private` publication guard.

Deno reads many of these fields for compatibility, but that does not make them
Deno package metadata.

## `preferPackageJson`

Set `preferPackageJson: true` only when `package.json` is intentionally the
dependency source of truth. Then `deno add`, `deno install <package>`, and
`deno remove` target `package.json` instead of `deno.json`.

Do not enable it while continuing to maintain overlapping dependency aliases in
`deno.json.imports`. Resolve ownership first.

```jsonc
{
  "preferPackageJson": true
}
```

## Imports are dependency and resolution aliases

The `imports` field maps an import specifier used by source code to a module,
package, URL, or local path.

```jsonc
{
  "imports": {
    "@std/path": "jsr:@std/path@^1.1.0",
    "zod": "npm:zod@^4.0.0",
    "@/": "./src/",
    "fixtures/": "./test/fixtures/"
  }
}
```

```ts
import { join } from "@std/path";
import { z } from "zod";
import { loadConfig } from "@/config.ts";
```

Rules:

1. Exact aliases map one specifier.
2. Prefix aliases end with `/` on both sides and map subpaths.
3. Local source imports still use explicit extensions after resolution.
4. Root workspace imports are inherited by members.
5. Member imports can add or override aliases for that member.
6. `imports` is not the package's public API. Use `exports` for that.
7. Do not place `workspace:*`, `workspace:^`, or `workspace:~` in
   `deno.json.imports`.
8. `catalog:` in a member's `deno.json.imports` is supported for npm catalog
   dependencies in current Deno, but catalogs cannot point to JSR packages.

## Scopes

`scopes` apply alternate mappings only to modules loaded under a path prefix.
Use them for controlled version partitioning, not routine dependency aliases.
They belong at the workspace root, not workspace members.

```jsonc
{
  "imports": {
    "library": "npm:library@^3"
  },
  "scopes": {
    "./legacy/": {
      "library": "npm:library@^2"
    }
  }
}
```

Avoid scopes when a clean package API or dependency upgrade is possible.

## Exports are the Deno package API

`exports` declares which modules consumers and sibling workspace members may
import from a Deno package.

Single entry:

```jsonc
{
  "name": "@acme/parser",
  "version": "1.2.0",
  "exports": "./src/mod.ts"
}
```

Multiple entries:

```jsonc
{
  "name": "@acme/parser",
  "version": "1.2.0",
  "exports": {
    ".": "./src/mod.ts",
    "./schema": "./src/schema.ts",
    "./testing": "./src/testing.ts"
  }
}
```

Consumers may import `@acme/parser`, `@acme/parser/schema`, and
`@acme/parser/testing`. Files not exported are private implementation details,
even when physically present in the package.

Do not confuse Deno `exports` with npm conditional exports. Deno package exports
map public subpaths directly to source modules. A dual-published package may
need a separate npm `exports` map describing generated JavaScript and type
artifacts.

## JSR versus npm decision model

Do not apply “JSR first” as an ideological rule. Choose using the package's
actual contract.

Choose JSR when:

- the package is designed for Deno or runtime-neutral ESM;
- source TypeScript and documentation quality are first-class;
- the package uses web APIs or explicit Deno adapters;
- JSR contains the canonical, maintained package;
- npm compatibility through JSR is adequate for downstream consumers;
- no required Node-specific installation behavior is missing.

Choose npm when:

- the npm package is canonical and better maintained;
- framework or ecosystem tooling expects npm metadata or `node_modules`;
- the package uses Node APIs Deno supports;
- native addons, lifecycle scripts, generated binaries, or peer dependency
  behavior are required and verified;
- no equivalent JSR package has comparable maturity;
- the project is package.json-first.

Prefer built-in web or Deno APIs when they fully solve the problem. Avoid adding
a package merely to follow a registry preference.

For every non-trivial dependency, verify:

```text
canonical registry and package:
maintainer and release activity:
license:
runtime support:
module format and exports:
types:
peer dependencies:
lifecycle scripts:
native binaries/addons:
required node_modules layout:
permissions and side effects:
package size and graph impact:
```

## `package.json` dependency guidance

When `package.json` owns dependencies:

- use normal npm package names and semver ranges;
- use `workspace:*`, `workspace:^`, or `workspace:~` only for sibling npm
  packages in dependency fields;
- preserve dependency class. Do not move runtime dependencies into
  devDependencies merely because tests are the first visible caller;
- preserve peer dependency intent for libraries and plugins;
- inspect optional dependencies and platform filters;
- do not manually mirror every npm dependency into `deno.json.imports`;
- run `deno install` when package.json dependency resolution requires it;
- verify lifecycle scripts and native packages under Deno rather than assuming
  Node compatibility implies installation compatibility.

## Node modules modes

`nodeModulesDir` is root-only in a workspace.

| Value    | Meaning                                            |
| -------- | -------------------------------------------------- |
| `none`   | No local `node_modules`; use Deno's global cache   |
| `auto`   | Deno creates and maintains local `node_modules`    |
| `manual` | External install command owns local `node_modules` |

Current defaults depend on whether a root `package.json` exists. Never hard-code
a mode without checking framework and package assumptions.

Use `jsrDepsInNodeModules: true` only when tooling outside Deno must discover
JSR dependencies in `node_modules`. It rewrites JSR packages through JSR's npm
compatibility registry. Do not enable it by default in Deno-native repositories.

## Catalogs

Catalogs centralize npm dependency versions across workspace members.

```jsonc
{
  "workspace": ["packages/*"],
  "catalog": {
    "zod": "^4.0.0",
    "typescript": "^5.9.0"
  }
}
```

Members may reference the default catalog from `package.json`:

```json
{
  "dependencies": {
    "zod": "catalog:"
  }
}
```

Current Deno also permits catalog references from member `deno.json.imports`.
Important restrictions:

- catalogs resolve npm packages only;
- catalog definitions are workspace-root-only;
- JSR dependencies remain direct `jsr:` mappings;
- if both root manifests define catalogs, `package.json` wins rather than
  merging;
- use named catalogs only for an intentional multi-version policy.

## Lockfiles and package-manager ownership

A migration must not casually replace the existing lockfile.

1. Identify which commands and deployment systems consume each lockfile.
2. Preserve the incumbent lockfile while Deno compatibility is proven.
3. Generate or update `deno.lock` deliberately.
4. Avoid dependency upgrades during a runtime migration unless required.
5. Verify a clean install in CI or a clean fixture.
6. Remove a foreign lockfile only when every consumer has migrated and the
   deletion is an explicit deliverable.

Use frozen lock behavior in CI where reproducibility matters.

## Supported TypeScript configuration

Deno recommends its defaults for Deno-first code. Add compiler options only to
solve a demonstrated requirement.

Deno can discover existing `tsconfig.json` files in workspace packages. It
supports these root fields:

```jsonc
{
  "extends": "...",
  "files": ["..."],
  "include": ["..."],
  "exclude": ["..."],
  "references": [{ "path": "..." }],
  "compilerOptions": {}
}
```

Only `compilerOptions` belongs in `deno.json`; the other TSConfig root fields do
not. Use workspace/package scopes and Deno tool include/exclude fields when they
express the requirement. Retain `tsconfig.json` when Node tooling or finer
project-reference/include semantics require it.

Precedence:

1. a referenced TSConfig takes precedence over its referrer;
2. a deeper root TSConfig takes precedence over a parent root TSConfig;
3. parent `deno.json.compilerOptions` take precedence over overlapping TSConfig
   compiler options;
4. workspace member compiler options merge with inherited root options, with
   member values taking precedence.

Common Node-oriented options to remove from Deno-first configuration:

- emit/output options: `outDir`, `outFile`, `rootDir`, declaration emit;
- transpilation target and helper options;
- source map emit options;
- CommonJS interop options;
- `resolveJsonModule`; use JSON import attributes;
- `skipLibCheck`; Deno already avoids checking dependencies by default unless
  all-module checking is requested.

Common options that may remain useful when justified:

- `strict` and individual strictness controls;
- `noUncheckedIndexedAccess`;
- `exactOptionalPropertyTypes`;
- `noImplicitOverride`;
- `noFallthroughCasesInSwitch`;
- `useUnknownInCatchVariables`;
- `checkJs` and `allowJs` for JavaScript migration;
- `jsx`, `jsxImportSource`, and JSX-related options;
- `lib` for environment-specific globals such as DOM, web worker, or Deno
  namespaces;
- decorator options only when required by the chosen framework or library.

Do not claim an option is supported from memory. Check the current Deno
TypeScript compatibility reference or run Deno and inspect diagnostics.

## Dependency change validation

After modifying dependencies or resolution:

```bash
deno install
deno list
deno list --depth 2
deno outdated
deno audit
deno check
deno test
```

Also verify:

- each documented import path;
- execution from root and affected members;
- clean installation without an existing cache or node_modules where practical;
- lifecycle and native-package behavior;
- lockfile diff;
- no duplicate manifest ownership;
- no stale aliases or deep imports remain.
