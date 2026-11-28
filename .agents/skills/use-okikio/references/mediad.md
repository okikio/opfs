# MediaD Architecture and Parser Patterns

Use this reference for recurring MediaD package architecture, media streaming/parser design, long-running media operations, and the conventions copied from MediaD into other Okikio repositories.

## Library-first ownership

MediaD separates generic programming models from concrete media capabilities:

```text
apps / clis
    |
    v
packages/media/*
    |
    +--> focused media engines / Web APIs
    |
    v
utils/*
```

`utils/` owns generic execution/lifecycle mechanics. `packages/media/` owns media semantics. Do not move a concrete media concept into `utils/` merely because several packages use it.

Use focused capability packages and one-way dependencies. Avoid vague `shared`, `common`, `helpers`, or `misc` packages.

## Naming and public API shape

Use package and namespace context to keep operations short:

```ts
import * as format from '@media/format';
import * as track from '@media/track';
import * as inspect from '@media/inspect';

const mime = format.mime('mp4');
const video = track.video(tracks);
const result = await inspect.get(ctx, source);
```

One word is preferred when it remains exact. Schemas end in `Schema`; schema-derived project data normally ends in `Type`; behavior interfaces use the domain noun.

Use `get` for addressable retrieval and `read` for real reading/sequential consumption.

## Media cost ladder

Prefer the cheapest operation that satisfies the request:

```text
direct byte copy
    |
    v
encoded-track remux
    |
    v
decode + encode transcode
```

Do not use a universal heavyweight media engine when direct streaming or encoded packet/container work is sufficient.

Planning should explain why each track/resource takes a particular path.

## Positional output and bounded memory

Media container writers can rewrite earlier metadata. Output abstractions therefore need positional writes when the selected media engine can seek/rewrite.

Do not assume output chunks can always be concatenated. Large output should use streamed/disk-backed writers rather than a complete `Blob` or `ArrayBuffer`.

## Task semantics

A long-running media operation separates:

- current state: authoritative snapshot;
- terminal `done`: authoritative result;
- events/observables: progress and lifecycle observation.

Observables do not own cancellation or the terminal result. `AbortSignal` is cancellation authority; disposal cleans up resources after work ends or can no longer continue.

A pause method is not real pause semantics unless the underlying operation cooperates with a pause gate or engine pause capability.

## Parser architecture

The HLS/DASH work adopts data-oriented, streaming parser ideas inspired by the Wikitext package.

Useful shape:

```text
bytes
  |
  v
syntax/token events
  |
  v
protocol semantic events/state
  |
  +--> diagnostics
  +--> retained model
  +--> writer/rewriter
  `--> presentation/playback projection
```

Keep source spans/ranges through the hot path when possible. Materialize strings and trees only for consumers that need them.

## Chunk invariance

Streaming parsers must produce the same semantic result regardless of input chunking. Test:

- one complete chunk;
- one byte per chunk;
- random chunking;
- splits inside UTF-8 sequences;
- splits at delimiters and token spans.

Formally, concatenated input and incremental chunks should produce equivalent semantic events apart from timing/object identity.

## M3U and HLS

Generic M3U syntax and HLS protocol semantics are separate layers. HLS can use M3U syntax events while owning HLS tags, state, validation, timeline, refresh/delta behavior, low-latency state, variables, encryption declarations, byte ranges, discontinuities, date ranges, renditions, and content steering.

Preserve unknown/vendor directives so unrelated edits do not destroy extensions.

Do not use `split(',')` for HLS attribute lists because quoted values can contain commas. Use an explicit scanner/state machine with source spans.

## DASH and XML

Use a maintained XML parser when it already provides the structural/namespace contract. For DASH semantic identity, dispatch by namespace URI plus local name, not by author-chosen prefix.

A semantic XML parser is not automatically a byte-lossless editor. Keep lossless lexical editing as a separate requirement.

## Documentation standard

MediaD treats internal parser state, lookup tables, regular expressions, track scoring, buffer limits, retry policy, resource factories, and cleanup invariants as documentation targets. Public wrappers are not the only important contracts.

Comments explain what must remain true and why. They do not narrate syntax.

## Verification

For media work, combine:

- schema and pure planner tests;
- unit tests for state/selection/ranges;
- integration fixtures from source through output;
- browser capability tests for WebCodecs/File System/OPFS/MSE when claimed;
- lifecycle tests for abort/cleanup/pause/terminal ordering;
- parser conformance and chunk-invariance suites;
- Mitata benchmarks for representative parsing/media paths when selected;
- throughput, heap, request count, write count, long-task, and cancellation-latency measurements when those properties matter.

Do not call media behavior complete from type checks alone.
