Media monorepo
==============

Purpose
-------

This repository is the library foundation for the media application, website,
documentation site, and browser extension. Applications are intentionally not
included yet.

The repository uses a library-first dependency direction:

```text
apps (later)
    |
    v
@media/*
    |
    v
@utils/*
```

`utils/` is copied from Kaiju Platform. Keep those utilities generic. Concrete
media behavior belongs in the `@media/*` package family.

Development environment
-----------------------

This repository uses [mise](https://mise.jdx.dev/) for tool versions and
development tasks. `mise.toml` pins Node, Deno, and pnpm. Executable repository
tasks live in `.mise/tasks/` so operational code does not require a visible
root `scripts/` directory.

Install the required tools:

```sh
mise install
```

Install Node workspace dependencies:

```sh
pnpm install
```

List available tasks:

```sh
mise tasks
```

Check the workspace:

```sh
mise run check
```

Run the complete package test suite:

```sh
mise run test
```

Run a package directly with Node:

```sh
node --test packages/media/format/mod_test.ts
```

Run the media packages with Deno:

```sh
deno task test:media
```

Runtime policy
--------------

Use dependencies in this order when the options have equivalent behavior:

1. Web platform APIs.
2. `@std/*` packages from JSR.
3. Existing `@utils/*` programming models when they add required semantics.
4. Focused domain libraries such as Mediabunny.

The media engine uses Mediabunny and WebCodecs. Do not add `ffmpeg.wasm` as a
universal fallback.

Naming
------

Prefer one concrete word when module and package context preserve meaning. Use
two or three words only when the shorter name becomes ambiguous. Constants are
not subject to this word-count preference.

Every Zod schema ends in `Schema`. Project-owned data types normally end in
`Type`. Behavioral interfaces use their concrete noun without `Type`.

Prefer `get` for addressable retrieval. Reserve `read` for actual files,
streams, readers, cursors, or other sequential consumption.

Documentation
-------------

Public and reusable internal symbols need concrete TSDoc. Documentation uses
plain Simplified Technical English. Explain options, examples, concrete impact,
reasoning, ownership, limits, and necessary background. Comments state the rule
that code must preserve instead of restating the next statement.
