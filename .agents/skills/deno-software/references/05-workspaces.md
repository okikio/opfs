# Workspaces and monorepos

## Contents

- Supported member shapes
- Root declaration
- Workspace member identity
- Deno members versus npm members
- Workspace protocol
- Root and member configuration matrix
- Imports and dependency ownership
- Tasks and working directories
- Type checking in workspaces
- Tests, formatting, and linting
- Publishing workspace packages
- Private workspace packages
- Containerization and deployment
- Cross-package refactor procedure
- Workspace audit checklist

Deno workspaces can contain Deno-first packages, Node-first packages, and hybrid
packages. Treat a workspace as a resolver and tooling scope, not merely a list
of directories.

## Supported member shapes

A root Deno workspace may include members containing:

1. only `deno.json(c)`;
2. both `deno.json(c)` and `package.json`;
3. only `package.json`.

A package.json-only member can still be resolved by its `name` when listed in
the Deno workspace. This is important for gradual adoption.

## Root declaration

Use Deno's singular `workspace` field:

```jsonc
{
  "workspace": [
    "packages/*",
    "apps/*",
    "!packages/internal-fixtures"
  ]
}
```

Patterns:

- `packages/*` matches one directory level;
- `examples/*/*` matches exactly two levels;
- `packages/**` recursively finds members containing a config file;
- `!pattern` excludes previously matched members;
- nested Deno workspaces are not supported.

Do not replace an existing npm workspace declaration blindly. A hybrid root may
need both `deno.json.workspace` and `package.json.workspaces` because different
tools consume them.

## Workspace member identity

A Deno package is resolvable by bare name when the member has:

```jsonc
{
  "name": "@acme/contracts",
  "version": "1.0.0",
  "exports": {
    ".": "./src/mod.ts",
    "./schema": "./src/schema.ts"
  }
}
```

Resolution follows this conceptual sequence:

1. Deno starts from the executing package.
2. It finds the parent workspace root.
3. It matches an import against member package names.
4. It confirms the matched directory is a declared member.
5. It resolves the requested subpath through that member's exports.

Consequences:

- sibling Deno packages should import by package name, not relative traversal;
- undeclared deep imports bypass the intended contract and must be removed;
- container builds must preserve the root config, dependent members, and the
  relative directory structure;
- a package name without exports is not a complete Deno package API.

## Deno members versus npm members

### Deno-first member

```jsonc
{
  "name": "@acme/core",
  "version": "1.0.0",
  "exports": "./src/mod.ts",
  "imports": {
    "zod": "npm:zod@^4"
  }
}
```

### npm-first member

```json
{
  "name": "@acme/react-adapter",
  "version": "1.0.0",
  "type": "module",
  "exports": "./dist/index.js",
  "dependencies": {
    "@acme/shared-npm": "workspace:^"
  }
}
```

### Hybrid member

Document responsibility explicitly. For example:

```text
deno.jsonc:
  Deno source entrypoints, JSR package metadata, Deno tooling

package.json:
  npm build artifacts, npm exports, peer dependencies, npm publication
```

Never assume the two exports maps are equivalent. One may point to TypeScript
source for JSR while the other points to generated JavaScript and declarations
for npm.

## Workspace protocol

`workspace:*`, `workspace:^`, and `workspace:~` are supported in `package.json`
dependency fields for npm workspace packages.

They do not belong in `deno.json.imports`.

Meaning at publication time:

- `workspace:*` uses the workspace package version;
- `workspace:^` produces a compatible caret range;
- `workspace:~` produces a patch-compatible tilde range.

Deno-first sibling packages do not need `workspace:` aliases. Their package
names and exports resolve through workspace membership, and Deno rewrites
workspace references to registry references when publishing to JSR.

## Root and member configuration matrix

Use this operational model:

### Root-only policy

These must be defined at the workspace root because resolution or process policy
must be consistent:

- `workspace`;
- `scopes`;
- `minimumDependencyAge`;
- `nodeModulesDir`;
- `vendor`;
- `allowScripts`;
- `links`;
- `lock`;
- `unstable`;
- catalogs;
- reporter settings that cannot vary in one invocation.

### Member package identity

These belong to members, not the workspace root:

- `name`;
- `version`;
- `exports`;
- `publish: false` for Deno package opt-out.

### Inherited or merged configuration

These may appear at root and member level:

- `compilerOptions`;
- `imports`;
- top-level and tool-specific excludes;
- lint rules and include/exclude;
- format style and include/exclude;
- tests and benchmarks include/exclude;
- tasks;
- publish include/exclude.

Member-specific configuration generally narrows or overrides root behavior.
Consult the current workspace matrix for edge-case merge semantics.

## Imports and dependency ownership

Root imports are useful for versions shared by Deno members:

```jsonc
{
  "workspace": ["packages/*"],
  "imports": {
    "@std/expect": "jsr:@std/expect@^1.0.20",
    "zod": "npm:zod@^4"
  }
}
```

Do not automatically centralize every dependency. Keep a dependency member-local
when:

- only one package uses it;
- versions intentionally differ;
- publication should expose a package-local contract;
- centralization would hide ownership.

Use npm catalogs for npm version centralization across package.json members.
Catalogs are not a JSR dependency mechanism.

## Tasks and working directories

Root tasks orchestrate. Member tasks implement package-specific behavior.

A task defined in a member runs with that member config's directory as its
working directory. A same-named member task takes priority over the inherited
root task.

```jsonc
// root deno.jsonc
{
  "workspace": ["packages/*"],
  "tasks": {
    "check": "deno fmt --check && deno lint && deno check && deno test"
  }
}
```

```jsonc
// packages/api/deno.jsonc
{
  "name": "@acme/api",
  "version": "1.0.0",
  "exports": "./src/mod.ts",
  "tasks": {
    "dev": "deno run -P=development --watch src/main.ts"
  }
}
```

Run member tasks deliberately:

```bash
deno task --cwd=packages/api dev
```

Audit every task for assumptions about:

- working directory;
- executable lookup;
- local `node_modules/.bin`;
- environment files;
- generated artifacts;
- sibling paths;
- permission sets.

## Type checking in workspaces

Workspace members are partitioned and checked as separate projects. Root
compiler options are inherited, then member options are merged.

```jsonc
// root
{
  "workspace": ["apps/web"],
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true
  }
}
```

```jsonc
// apps/web
{
  "compilerOptions": {
    "lib": ["esnext", "dom", "dom.iterable"]
  }
}
```

Do not add DOM libraries to the root merely because one frontend package needs
them. Keep environment-specific globals at the member module.

Existing tsconfig project references can coexist. Determine precedence and which
tools still consume them before deleting any TSConfig.

## Tests, formatting, and linting

From the root:

```bash
deno check
deno test
deno fmt --check
deno lint
```

These traverse members according to each member's configuration.

During iteration, run affected members or paths. Before completion, run the root
gates whenever shared config, contracts, aliases, or lockfiles changed.

## Publishing workspace packages

Running `deno publish` in a workspace considers Deno members with `name` and
`exports`. Publishable members require a version.

Opt a Deno-only internal package out explicitly:

```jsonc
{
  "name": "@acme/internal-tools",
  "publish": false,
  "tasks": {
    "generate": "deno run -P=generate ./generate.ts"
  }
}
```

Critical nuance:

- `package.json.private` is an npm publication guard;
- it is not read as a Deno/JSR publication opt-out;
- package.json-only workspace members are not JSR candidates;
- hybrid Deno members intended to stay private still need `publish: false` in
  `deno.json(c)`.

For interdependent JSR packages:

1. ensure every public dependency is exported and versioned;
2. dry-run from the workspace;
3. publish dependencies before dependents when separate publication ordering is
   needed;
4. verify Deno rewrites workspace references correctly;
5. consume the published package from a clean fixture.

## Private workspace packages

“Private” can mean three different things:

1. **Workspace-local only:** use a Deno member with `publish: false`.
2. **Private npm registry package:** configure `.npmrc`, declare it as an npm
   dependency, and authenticate in local/CI environments.
3. **Private source repository import:** configure supported repository/module
   authentication and avoid embedding secrets in source or config.

Do not say “private package” until the intended distribution model is clear.

## Containerization and deployment

A workspace package does not become standalone merely because its source folder
was copied.

Include:

- root Deno configuration;
- lockfile;
- the target member;
- every transitive workspace member;
- expected relative paths;
- package.json and node_modules installation metadata when used;
- generated artifacts required at runtime.

Verify the container from a clean build context. Do not rely on a developer
machine's global Deno cache.

## Cross-package refactor procedure

1. Build the member graph and identify cycles.
2. Locate the owning package for each contract.
3. Change schemas/types at the owner.
4. Update exports before consumers.
5. Migrate every consumer by package name.
6. Remove old exports, aliases, and compatibility paths.
7. Update package metadata and versions.
8. Run member tests in dependency order.
9. Run root checks.
10. Dry-run publication or package builds.
11. Test clean consumption.

## Workspace audit checklist

Check for:

- duplicate package names;
- matched directories without a config file;
- nested workspace declarations;
- member names missing exports;
- publishable packages missing versions;
- Deno private packages lacking `publish: false`;
- sibling relative imports;
- deep imports bypassing exports;
- `workspace:` mistakenly used in Deno imports;
- catalogs attempting to manage JSR packages;
- root-only options declared in members;
- competing root catalogs in both manifests;
- task name collisions with different semantics;
- inconsistent compiler environments;
- circular package dependencies;
- undeclared generated-file dependencies;
- container definitions that copy only one member;
- npm and JSR publication surfaces that diverge accidentally.
