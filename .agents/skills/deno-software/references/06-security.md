# Security, permission sets, and private dependencies

## Contents

- Permission categories
- Named permission sets
- Value forms
- Permission sets versus tasks
- Permission design workflow
- Special considerations by category
- Test, benchmark, and compile permissions
- Private npm registries
- Private source modules and repositories
- Supply-chain controls
- Security review checklist

Deno permissions are executable capabilities. They are part of an entrypoint's
public operational contract and must be reviewed like network ports, database
roles, or filesystem mounts.

## Permission categories

Review each category independently:

| Config key | CLI family                         | Capability                                 |
| ---------- | ---------------------------------- | ------------------------------------------ |
| `read`     | `--allow-read` / `--deny-read`     | Filesystem reads                           |
| `write`    | `--allow-write` / `--deny-write`   | Filesystem writes                          |
| `net`      | `--allow-net` / `--deny-net`       | Network listeners and outbound connections |
| `env`      | `--allow-env` / `--deny-env`       | Environment variable reads/writes          |
| `sys`      | `--allow-sys` / `--deny-sys`       | System information                         |
| `run`      | `--allow-run` / `--deny-run`       | Subprocess execution                       |
| `ffi`      | `--allow-ffi` / `--deny-ffi`       | Native dynamic libraries                   |
| `import`   | `--allow-import` / `--deny-import` | Remote module hosts                        |

Do not collapse these into `-A` without a documented trust decision.

## Named permission sets

Deno 2.5+ can store permission sets in `deno.json(c)`:

```jsonc
{
  "permissions": {
    "development": {
      "read": ["./src", "./config", "./static"],
      "write": ["./.cache"],
      "net": ["localhost:5432", "localhost:8000"],
      "env": ["DATABASE_URL", "LOG_LEVEL"]
    },
    "production": {
      "read": ["./static"],
      "net": ["0.0.0.0:8000", "db.internal:5432"],
      "env": ["DATABASE_URL", "PORT", "LOG_LEVEL"]
    },
    "test": {
      "read": ["./src", "./test", "./fixtures"],
      "write": ["./.tmp/test"],
      "env": ["TZ"]
    }
  }
}
```

Use them with:

```bash
deno run -P=development src/main.ts
deno test -P=test
```

A `default` set can be selected with `-P` and no name:

```jsonc
{
  "permissions": {
    "default": {
      "read": ["./src"]
    }
  }
}
```

Avoid a broad default set in a repository with multiple trust profiles. Named
sets make privilege differences visible.

## Value forms

A permission value may be:

- `true`: allow all for that category;
- `false`: deny the category;
- a string or list of allowed scopes;
- an object with `allow`, `deny`, and `ignore`.

```jsonc
{
  "permissions": {
    "worker": {
      "read": {
        "allow": ["./data", "./config"],
        "deny": ["./data/secrets"],
        "ignore": ["./data/cache"]
      },
      "net": {
        "allow": ["api.example.com:443"],
        "deny": ["169.254.169.254"]
      }
    }
  }
}
```

Interpretation:

- `allow` grants scoped access;
- `deny` explicitly blocks matching access and takes precedence over grants;
- `ignore` is supported for read and environment permissions; ignored
  operations are silently ignored instead of throwing;
- use it only when the application deliberately treats that missing read or
  environment value as optional;
- do not describe `ignore` as a general prompt-suppression control or use it
  for permission categories that do not support it.

Verify exact current precedence and accepted scope syntax using the Deno config
reference when designing a security trust transition.

## Permission sets versus tasks

A task does not automatically inherit a permission set merely because the set
exists. Reference it in the task command:

```jsonc
{
  "tasks": {
    "dev": "deno run -P=development --watch src/main.ts",
    "test": "deno test -P=test",
    "start": "deno run -P=production src/main.ts"
  }
}
```

Keep permission sets semantic. Prefer `production`, `migration`, `test`, and
`codegen` over names like `set1` or `broad`.

## Permission design workflow

For each entrypoint, record:

```text
read:
write:
net listen:
net outbound:
env:
sys:
run:
ffi:
remote import:
reason for every scope:
```

Then:

1. start with no permissions;
2. run the real workflow;
3. grant the narrowest stable scopes;
4. separate optional from required access;
5. add explicit denies for sensitive paths/hosts where useful;
6. encode the set in config;
7. test failure when a forbidden capability is attempted;
8. document deployment-level equivalents.

Do not infer permissions only from direct source imports. Transitive packages,
native code, framework dev servers, and subprocesses may require additional
capabilities.

## Special considerations by category

### Read and write

- Scope to application directories rather than repository root when possible.
- Separate source/config reads from mutable data and cache writes.
- Deny secret folders even when a broader parent is allowed.
- Test symlink and path-normalization behavior for hostile input.
- Do not grant home-directory access merely to satisfy one tool cache without
  checking whether the cache path can be redirected.

### Network

- Separate listen addresses from outbound dependencies in documentation.
- Pin hosts and ports where deployment topology is stable.
- Account for DNS, proxies, redirects, telemetry, and authentication endpoints.
- Use request timeouts, abort signals, response size limits, and TLS validation.
- Remember that local development hosts differ from production hosts.

### Environment

- Grant named variables, not all environment variables, for production.
- Validate required values at startup through a schema.
- Avoid reading secrets during reusable module initialization.
- Do not print complete environment objects during debugging.

### Run

`run` is high impact because a subprocess may exercise capabilities outside the
parent Deno permission model.

- scope allowed executable paths where practical;
- pass argument arrays rather than interpolated shells;
- avoid secrets in process arguments;
- propagate cancellation and signals;
- verify exit status;
- audit what the child process can access at the operating-system level.

### FFI

Treat FFI as native code execution:

- pin and verify library artifacts;
- constrain paths;
- isolate unsafe bindings;
- test supported operating systems and architectures;
- do not represent Deno permissions as a complete sandbox once FFI is enabled.

### Import

Remote import permission is distinct from ordinary application network access.
Prefer locked JSR/npm dependencies over runtime remote URL imports. If remote
imports are necessary, constrain hosts and commit lockfile integrity.

## Test, benchmark, and compile permissions

Do not assume permission-set support is identical across every subcommand or
artifact in every Deno release. Verify the current CLI.

For compiled binaries, permissions may be embedded or constrained at compile
time depending on the current command options. Test the produced binary, not
only `deno run`.

For tests and benchmarks:

- use dedicated sets;
- separate integration tests requiring databases/network from unit tests;
- avoid granting production secrets;
- ensure parallel tests do not share writable state accidentally.

## Private npm registries

Deno uses `.npmrc` for private npm registry configuration. The file must be in
the project root or user home directory.

```ini
@acme:registry=https://registry.example.com/
//registry.example.com/:_authToken=${NPM_TOKEN}
always-auth=true
```

Declare the dependency through the owning manifest:

```jsonc
{
  "imports": {
    "@acme/internal-sdk": "npm:@acme/internal-sdk@^3"
  }
}
```

or:

```json
{
  "dependencies": {
    "@acme/internal-sdk": "^3.0.0"
  }
}
```

Security rules:

- never commit literal auth tokens;
- verify whether the chosen `.npmrc` syntax expands environment variables in the
  current Deno/runtime workflow;
- scope tokens to the registry host and package scope;
- use read-only install tokens in CI where possible;
- keep publish credentials separate from install credentials;
- mask credentials in logs;
- test clean authentication in CI rather than relying on a developer's home
  configuration.

## Private source modules and repositories

Private source repository access is a different mechanism from private npm
registries. Determine whether the dependency is:

- an npm package hosted in a private registry;
- a Git repository dependency;
- an authenticated remote module URL;
- a workspace-local linked package.

Prefer a package registry for versioned organization dependencies. Use local
`links` only for active development, not undocumented production resolution.

## Supply-chain controls

Review and configure:

- lockfile and frozen CI behavior;
- minimum dependency age;
- package age exclusions for controlled internal releases;
- lifecycle script approval through `allowScripts` or explicit approval flows;
- audits and provenance;
- native binaries and install scripts;
- dependency overrides and their removal conditions.

Current Deno applies a default minimum package age unless overridden. Do not
turn it off merely because a newly published version fails to resolve. Confirm
whether the package is trusted and whether a scoped exclusion is justified.

## Security review checklist

- [ ] Permission sets exist for materially different workflows.
- [ ] Tasks explicitly select the intended set.
- [ ] Production does not use unexplained `-A`.
- [ ] Read/write scopes exclude secrets and unrelated directories.
- [ ] Network hosts and ports are documented.
- [ ] Environment access is named and validated.
- [ ] Subprocesses and FFI are treated as privilege escalations.
- [ ] Private registry tokens are not committed.
- [ ] CI authentication is reproducible.
- [ ] Lifecycle scripts and native packages are reviewed.
- [ ] Dependency-age policy is intentional.
- [ ] Forbidden access has negative tests where security matters.
- [ ] Compiled/deployed artifacts are tested under their actual permission
      model.
