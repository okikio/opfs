# CLI distribution and installed execution

Use this reference when a CLI is packaged, compiled, published, installed,
upgraded, or expected to work outside the source checkout.

## Distribution is a separate contract

Source execution can hide undeclared assumptions:

```text
source tree
  workspace imports
  local config
  global tools
  developer caches
  writable repository paths
  dynamic source discovery
```

The installed artifact has a different environment. Verify it explicitly.

## Define the source of truth

Record:

- package/workspace that owns the executable;
- executable/bin name;
- source entrypoint;
- generated command registry/help/completion/manual source;
- build/compile command;
- package/publication targets;
- runtime requirements;
- files intentionally shipped;
- install-time generated or copied assets.

Do not maintain separate hand-edited command graphs for source and compiled
execution.

## Package distribution

For npm/JSR/other package installs, inspect:

- `bin`/export mapping;
- ESM/runtime conditions;
- declaration output if programmatic APIs are public;
- production dependencies, peers, optional dependencies;
- side effects/import-time behavior;
- package inclusion/exclusion;
- license/readme/changelog;
- generated completion/manual files where shipped;
- package-manager lifecycle scripts;
- supported runtime/engine versions.

Create/dry-run the actual package archive and inspect its contents. Workspace
links are not a clean consumer.

## Compiled binaries

For `deno compile` or another compiler/bundler:

- verify static/dynamic command discovery;
- include required config/templates/assets deliberately;
- verify runtime permissions and external file expectations;
- check current working directory assumptions;
- verify subprocess/browser/native dependency behavior;
- run on the claimed operating system/architecture where possible;
- verify version/help without project files;
- verify completion/manual strategy for binary installs.

Do not assume a module imported dynamically from the source filesystem exists in
one-file output.

## Installed filesystem contract

Document:

- executable location/PATH expectations;
- config directory and precedence;
- cache/data/state/log directories and XDG/platform behavior;
- whether user files survive uninstall;
- where completion/manual assets are installed;
- temporary/runtime files and cleanup;
- migration path for renamed config/state;
- offline/proxy behavior where claimed.

Avoid writing mutable runtime state into the package/install directory.

## Upgrade and replacement

When changing command names, config paths, or data formats:

1. identify whether compatibility is actually required;
2. migrate current users/consumers when required;
3. update completion/man/docs/package metadata;
4. remove obsolete internal aliases after a deliberate replacement unless the
   external contract requires them;
5. verify old state handling and actionable failure for unsupported versions.

## Uninstall

Define which files belong to the tool versus the user. Uninstall should remove
owned binaries/completions/cache as appropriate without deleting user project
data or durable outputs by surprise.

## Failure signatures

| Symptom | Likely cause |
|---|---|
| works from repo, fails after install | workspace/local-path dependency |
| `--help` works, subcommand missing | dynamic discovery not packaged |
| generated manual lists old option | generation drift |
| binary reads templates from source path | asset not embedded/copied |
| package includes tests/secrets/.agents | inclusion policy missing |
| uninstall removes user data | ownership not defined |
| completion command runs project initialization | discovery coupled to execution |
| upgrade creates duplicate config sources | old/new path reconciliation missing |

## Verification

Run the artifact, not only the source:

1. build/compile/package from a clean tree;
2. inspect package/binary contents and hashes;
3. install or unpack into a clean temporary environment;
4. run help/version/no-argument behavior;
5. run representative success, invalid-input, operational-failure, and
   cancellation paths;
6. verify stdout/stderr/exit status;
7. verify config/cache/data locations;
8. verify completion/manual generation or installation;
9. exercise upgrade/migration when changed;
10. verify uninstall/cleanup ownership where the product claims it.

Use `deno-software` or `build-devtools` for runtime/package/release mechanics as
appropriate. This reference owns the CLI's installed behavioral contract.
