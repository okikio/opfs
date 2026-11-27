# Human and automation interaction

Use this reference when the CLI reads from stdin/TTY, prompts, pages output,
shows progress, handles destructive work, accepts secrets, or must behave well
both interactively and under automation.

## Interaction is a capability contract

Do not equate “running in a terminal” with “interactive.” Treat these separately:

- stdin is a TTY;
- stdout is a TTY;
- stderr is a TTY;
- input is redirected/piped;
- output is redirected;
- explicit `--no-input`/noninteractive policy;
- CI environment signal;
- color/progress/pager preference;
- reduced-motion preference when terminal animation is used.

A command can have a TTY stderr and redirected stdout, or piped stdin and a TTY
stdout. Test combinations that matter to the output contract.

## No-argument behavior

A bare command should either:

- show concise orientation/help; or
- perform a safe, obvious default action.

It must not need a valid project config merely to print help/version. Avoid an
unbounded interactive wizard as an unexpected default in automation.

Useful root help usually includes:

- one-sentence purpose;
- common commands;
- one or two examples;
- how to get subcommand help;
- next action rather than every possible detail.

## Prompts

Prompting is a source of values, not a hidden fallback for every missing field.
Define when prompts are allowed and how they participate in source precedence.

For every prompt:

- check interactivity before waiting;
- support explicit noninteractive behavior;
- define cancellation/EOF;
- keep defaults distinct from authored values where provenance matters;
- hide secret input;
- avoid prompting for values that automation must always provide explicitly;
- ensure retry/validation does not trap a user forever.

In CI/redirection/`--no-input`, fail immediately with an actionable missing-field
message or use a documented safe default. Never hang.

## Destructive and expensive operations

For deletes, migrations, writes to production systems, high-cost operations, or
irreversible changes, separate inspection/plan from mutation when practical.

Before apply, show:

- target identity;
- current state;
- proposed changes;
- expected side effects/cost;
- affected files/resources;
- rollback or lack of rollback;
- confirmation requirement.

Do not ask for confirmation after mutation has already started. Automation should
have an explicit `--apply`, `--yes`, or equivalent contract chosen by the
product, not TTY heuristics alone.

## Standard streams

### stdout

Stable command results or requested machine output. Machine-readable stdout must
not contain progress, color, LogTape prefixes, stack traces, or prompts.

### stderr

Operational diagnostics, warnings, progress, and public errors when that is the
CLI's contract.

### stdin

Input data or interactive responses. Use `-` as a stdin/stdout sentinel only
when the command's ownership is unambiguous. A command that already consumes
stdin for a data stream cannot also assume it can prompt on stdin.

## Color, progress, animation, and pagers

Select presentation from the exact stream:

- no ANSI color into machine/file output unless explicitly forced;
- progress should use stderr when stdout is a result stream;
- disable or simplify animation in non-TTY and reduced-motion contexts;
- rate-limit high-frequency progress updates;
- ensure final state remains readable after progress clears;
- pagers only for human-oriented TTY output;
- paging must never block automation;
- never page binary, JSONL stream, or redirected output.

For very large results, prefer explicit paging/query options or streaming rather
than materializing everything just to pipe it to a pager.

## Secrets

Avoid secrets in argv because process listings, shell history, telemetry, and
support captures can expose them. Prefer, according to the product contract:

- environment variables;
- stdin;
- permission-controlled files;
- OS/provider secret stores;
- interactive hidden input.

Never echo secret values in:

- command results;
- diagnostics/errors;
- config explanation;
- debug dumps;
- support bundles;
- shell-completion/man output.

Redaction is route-specific. Stable results, config explanation, diagnostics,
and support bundles can have different policies. Test the exact route.

## Recovery-oriented messages

A useful failure states:

1. what failed in user terms;
2. the affected target/run/file/resource;
3. whether mutation happened and how far;
4. safe next command/action;
5. how to inspect/retry/resume/rollback;
6. where detailed diagnostics live.

Keep raw provider/database failures in structured diagnostics with safe public
mapping. Do not expose internal stack traces as normal user guidance.

## Failure signatures

| Symptom | Cause |
|---|---|
| command hangs in CI | prompt without interactivity policy |
| JSON output contains spinner | stdout/result and diagnostic presentation mixed |
| pager opens in pipe | TTY decision based on wrong stream |
| prompt appears while reading stdin data | input source ownership collision |
| secret appears in config explain | provenance/redaction contract missing |
| user confirms after first mutation | plan/apply ordering wrong |
| `--quiet` loses requested result | diagnostic and result suppression conflated |
| errors say “failed” with no recovery | provider exception rendered directly |

## Verification

Run representative subprocess cases with:

- all streams attached to TTY where testable;
- stdout redirected;
- stderr redirected;
- stdin piped/closed;
- explicit noninteractive mode;
- prompt accept/reject/cancel/EOF;
- quiet/silent/color/no-color/progress options;
- secret-bearing failure;
- destructive dry-run/apply flow;
- large output/pager threshold when applicable.

Assert exact stdout, stderr, exit code, mutation state, and absence of leaked
secrets. Do not call interaction behavior verified from parser unit tests alone.
