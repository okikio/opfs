# Select the capability and the decisions it affects

Identify the requested mode, reader, task, sources and scope before acting.
Start with the customer outcome and the question that controls the next
decision. Use [anchor-based product development](guides/product/README.md) for
early direct experiments, the research/experiment cadence, evidence checkpoints,
and progress anchors. Discovery and narrow probes establish the questions;
substantial implementation follows an explicit question and evidence plan.
Read the selected skill's software-quality guide once per task. Comments, docs,
naming, imports, formatting, readability and correctness apply inside every
capability; they do not depend on loading an umbrella or a separate docs skill.

Treat this first selection as provisional. After tracing the owning code, and
before the first edit or a new kind of work, [recheck the decisions and load
any missing guidance](guides/software-quality.md#recheck-after-discovery).
Before proposing code, [find the reusable owner](guides/software-quality.md#check-for-reuse-before-designing),
including local components and blocks when the change renders UI.

The project keeps its own instructions, supported hosts, tools and delivery
requirements. Use the [generic profile](handbook/profiles/generic.md) unless its
current instructions select another policy. The [handbook](handbook/README.md)
explains the method; its [playbook](handbook/playbook.md) selects procedures and
evidence gates. Skills carry out the engineering inside those procedures.
[Guidance ownership](GUIDANCE.md) explains which source answers each question.

| Requested work | Capability |
| --- | --- |
| Frame product unknowns and an experiment plan | `plan-changes` |
| Test a material documentation or dependency claim early | `explore-ecosystems` |
| Plan before implementation | `plan-changes` |
| Refactor, migrate or remove legacy paths | `refactor-code` |
| Test design, regression or reproduction | `test-code` |
| Review code or report findings | `review-code` |
| Measure or assess performance | `benchmark-code` |
| Validate and exercise the real capability/artifact | `verify-behavior` |
| Write docs, comments or explanatory diagrams | `write-docs` |
| Group/stage authorized changes and write commits | `commit-changes` |
| Draft a reviewer-facing PR explanation | `prepare-pull-requests` |
| Release candidate, changelog or authorized publication | `release-software` |

Ordinary implementation stays with the actual domain owner below. Diagnosis,
review, planning and drafts do not authorize fixes or external publication.
Choose companions by changed decisions, not every technology mentioned.

| Decision | Domain/runtime companion |
| --- | --- |
| HTTP/service/gateway | `build-apis` |
| Authentication/session/provider and auth schema | `build-auth` |
| PostgreSQL, ClickHouse, queries, migrations, projections | `build-data` |
| Durable jobs, workers, replay, recovery | `build-workflows` |
| CLI grammar, streams, exits | `build-clis` |
| Reusable API, exports and resource ownership | `build-libraries` |
| Mise, CI, generators, harness and packaging mechanics | `build-devtools` |
| Deno execution or Deno/JSR package contract | `deno-software` |
| Python code/runtime | `python-software` |
| Rust source, Cargo, memory, SIMD, Wasm or native FFI | `rust-software` |
| Public utility packages from `okikio/utils` and their exact APIs | `use-utils` |
| Okikio libraries such as `@okikio/undent` | `use-okikio` |
| Material dependency comparison or integration | `explore-ecosystems` |
| Renderer/browser/hydration/focus/motion execution | `build-web` |
| Site content, routes, publishing and Astro | `build-sites` |
| Product sessions, URL/cache/local state | `build-web-apps` |
| Visual hierarchy, Apple interaction, motion purpose and catalogs | `design-interfaces` |
| Detailed accessibility audit | `accessibility` |
| Exact installed shadcn primitives/registry | `shadcn` |

A review of Deno auth code needs review-code, build-auth and deno-software.
A small Astro React island fix needs build-web for renderer/lifetime and the
state or publishing owner for the changed contract; it does not imply Next.js.
A benchmark still needs correct output, readable fixtures and accurate comments.
Keep one discovery, plan and verdict; do not recursively load every companion.
If one is unavailable, inspect the contract and state the consequential limit.

Read required resources in bounded outputs and recover truncated portions.
Read the [shared quality contract](guides/software-quality.md) once, then only
applicable detail before making that decision. Each skill states its reading
boundary. Resource indexes are lookup maps, not reading checklists. Historical
entrypoints are available through Git rather than the active skill tree.

For upkeep, run this collection's `deno task validate` and inspect an isolated
bundle from `deno task bundle`. Structural checks establish metadata, routing
and installation integrity. Model behavior and customer outcomes need their
own evidence. Source directories share files; use the documented bundle or
whole-pack adoption procedure before installing them elsewhere.
