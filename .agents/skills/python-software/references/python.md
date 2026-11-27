# Python engineering rules

Use these rules when the repository contains Python. The repository's existing Python toolchain and external contracts remain authoritative; do not force JavaScript-specific syntax into Python or invent a second style system merely because another Okikio project uses TypeScript.

## Inspect the local Python contract first

Before editing, inspect:

- `pyproject.toml`, lockfiles, supported Python versions, and package layout;
- formatter, linter, type checker, test runner, and task commands;
- public modules and generated artifacts;
- runtime entrypoints, workers, services, scripts, and notebooks involved in the request;
- external serialization formats and database schemas that constrain field names.

Reuse the repository's selected tools. Do not add Ruff, Black, mypy, Pyright, pytest, uv, Poetry, or another tool simply because it is popular if the repository already has an owner for that concern.

## Name Python code for its role

Follow normal Python syntax for Python identifiers, normally `snake_case` for functions, variables, parameters, modules, and attributes, and `PascalCase` for classes and type aliases where appropriate.

That Python syntax rule does **not** imply that every JSON key, database column, wire field, or persisted record should be converted to snake case. Preserve the exact external or durable contract while modeling it. Normalize only when the project intentionally owns a distinct internal shape and the conversion has a real semantic purpose.

Prefer short concrete names and precise verbs. Avoid vague modules such as `helpers.py`, `common.py`, `shared.py`, or `misc.py` when the code has a concrete capability name.

Use `get` for addressable retrieval and `read` for actual file, stream, cursor, socket, or sequential consumption when that distinction improves the API.

## Keep data and behavior clear

Use dataclasses, `TypedDict`, Pydantic models, Standard Schema-compatible adapters, or plain classes only when they match the repository's existing contract and runtime needs. Do not duplicate the same data shape across multiple type systems without a concrete integration requirement.

Type annotations should protect public contracts, non-obvious records, callback shapes, generic behavior, and return values whose meaning is not obvious. Avoid annotation ceremony that adds no useful constraint.

Keep orchestration thin. Put deterministic parsing, normalization, selection, planning, and calculation into ordinary functions that can be tested without network, filesystem, process, or database state.

## Make lifetime and side effects explicit

Keep network, filesystem, process, database, and sink side effects at concrete ownership points.

Use the repository's normal cancellation mechanism. When async Python is involved, preserve `asyncio` cancellation rather than swallowing `CancelledError` as a generic failure. Use context managers or explicit close/dispose methods for resources whose lifetime must end deterministically.

Injected clients, pools, sessions, files, and databases are borrowed unless the API explicitly transfers ownership.

If construction acquires several resources, release earlier acquisitions when a later step fails. Preserve the primary operation error if cleanup also fails.

Make retries, backoff, request limits, queue limits, concurrency, resume state, and checkpoints visible where they affect behavior. Any collection or queue that can grow with input needs a limit or a documented finite upper bound.

## Document non-obvious internal contracts

Use docstrings and local comments to teach behavior a reader cannot safely infer from the syntax alone.

Document important private functions and state too, including:

- complex regular expressions;
- parsers and parser tables;
- cache and retry invariants;
- leases, generations, checkpoints, or publication rules;
- binary offsets and encodings;
- resource factories and cleanup ordering;
- benchmark fixtures or workloads whose construction affects results.

Do not add docstrings that only repeat the function name. Explain purpose, important inputs, ownership, limits, failure behavior, and examples when the function is reusable.

## Preserve exact external data

When consuming APIs or files, verify selectors, response fields, pagination, error shapes, and version-sensitive behavior against the real source before hard-coding fallbacks.

Keep external field names intact while they still represent the external contract. For example, a provider's `created_at`, `createdAt`, or `x-request-id` field remains exact until an explicit project-owned transformation changes its semantics.

For append-only outputs, resumable ingestion, crawling, or event processing, make durable identity, replay position, checkpoint publication, and duplicate handling explicit. Do not hide them inside generic helpers.

## Test the claimed runtimes and outputs

Use the test runner and assertion library already selected by the Python repository. Do not replace the repository's testing system merely to match the TypeScript projects.

Test at the appropriate layers:

- pure unit behavior;
- schema and serialization contracts;
- error and cancellation paths;
- resource cleanup;
- integration behavior against real or faithful dependencies;
- CLI/service entrypoints;
- generated files and installed-package imports;
- representative performance workloads when performance is part of the claim.

Prefer small targeted runs while diagnosing a live-system or large-dataset issue, then run the canonical full gates before declaring the change complete.

Record the exact commands that ran and any native environment that was unavailable. Compilation or static typing alone does not prove Python runtime behavior.
