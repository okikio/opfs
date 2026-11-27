# Software quality is part of the selected capability

A code review includes its comments and docs. A benchmark must still be correct.
An auth change needs meaningful names and import-safe ownership. These duties
apply directly; selecting a separate documentation or testing skill is not what
makes them apply. They hold in every repository that
installs this pack.

## Establish the product question and first probe

Read the [anchor-based product method](product/README.md) once per task. Before
substantial solution implementation, identify the customer outcome, decision,
consequential unknowns, existing evidence, and smallest useful probe. Extract
questions from the request and investigate missing technical details. Ask only
when an unresolved human decision would materially change the target. Narrow
discovery and experiments can start immediately to establish this contract.

Use an existing executable, public API, or tiny fixture before building new
scaffolding. Alternate current research with early experiments under the core
method's research and experiment loop. Distinguish observed, documented, hypothesized,
inconclusive, and blocked claims. Preserve unsuccessful observations and their
metadata. Share the customer meaning and next decision as an anchor. Read the
specific product detail only when it governs the decision in front of you.

## Recheck after discovery

For Rust work, read [rust-software](../skills/rust-software/SKILL.md) and the
[Rust product guide](rust/README.md). Inventory the required hosts of each maintained Rust artifact, including
workers and tools. Require Wasm execution only when that host is part of the
project contract. Keep resource limits, correctness and measurements explicit.
This applies to review, planning, benchmarks and CI as well as implementation.
For Rust data-layout or allocation decisions, read [data-oriented design](rust/data-oriented-design.md).
Map operations and lifetimes, isolate mechanisms, and measure complete cost.

The request gives you a starting skill, not the complete list. Once you have
traced the entrypoint, imports and a real caller, compare the decisions you
actually face with [START's owner table](../START.md). Before the first edit,
check that you have read the guidance for those decisions. Repeat the check
before taking on a newly discovered owner or verification layer, or changing
modes (for example, from review to an authorized fix). Review findings do not
authorize fixes.

Read the missing owner's installed `SKILL.md` under `.agents/skills/` and use
its resource index or conditional links to find the specific reference. If
nothing material changed, continue with the guidance already loaded. Keep one
plan and verdict; a technology name or incidental import alone is not a reason
to load another skill.

For example, a receipt review may start with `review-code`. Finding a long
value clipped by a shared component adds `build-web` for the layout and the
Break UI reference under `design-interfaces` for what must stay readable.
Before an authorized edit, check the shared component and its other callers.
A PostgreSQL-only query change does not add UI guidance merely because a page
consumes its results; recheck only if the work now affects a rendered decision.

## Check for reuse before designing

Search for the operation, aliases and real callers. Map the repository's actual
ownership layers before designing. In a layered product example, trace **`utils/` →
`packages/` → `services/` → `workers/`** and check the relevant existing layers
even if a lower-level match appears early. Other projects use their own layout;
do not create these folders to comply with an example. A capability may already
have an owner, a live route, or an executor bound to it.

For rendered changes, start with the route's actual imports and nearby callers.
Check the application's feature compositions and shared primitives before
creating either.
Use the selected web skill's resource index to find its component, registry and
verification guidance. Follow the data back through the relevant owners below
when changing the value or its contract.

1. **Utilities:** Start at the repository's utility documentation and the
   published utility packages it uses. Check the owning export map, implementation and
   tests for generic mechanics such as HTTP, typed clients, query, lifecycle
   and durable execution.
2. **Packages:** Find the concrete capability, provider adapter or data policy
   already using those mechanics. Extend the owner when the needed behavior is
   specific to the product.
3. **Services:** Check existing contracts, handlers and Gateway mounts.
   Reuse an import-safe definition and typed client before adding another
   route, wrapper or transport.
4. **Workers:** Check service-owned workflows, their activity bindings and
   service background hosts, then standalone roles under `workers/`. Reuse an
   admitted job, dispatch loop or host before adding another executor or queue.

Trace the chosen path to a caller and its failure or cleanup behavior. Reuse
the smallest contract that fits; an ordinary read does not need a workflow.
If none fits, name the missing behavior and put the new code in the layer that
owns it. In the plan or review, state what is reused, or why the existing
owner cannot supply it. Do not add a second checklist or copy this rule into
each skill.

For example, to show a job's status, start at the page that shows it and the
component that renders the status. Follow its imports to the shared
client/transport mechanics and the service's declared operation, then confirm
that the service's executor supplies the state. The UI does not need its own
endpoint or executor.

## Apply the complete contract

| Obligation | Required behavior and detailed source |
| --- | --- |
| Scope and authority | Identify the requested mode, reader, task and factual sources before acting. Review, diagnose and plan do not authorize fixes. Preserve dirty work; external writes need authorization. [Base](../references/base.md) and [standards](../references/standards.md) retain the full constraints. |
| Correctness | Trace real exports, callers, errors, ownership, ordering, cancellation and cleanup. Runtime schemas own validated shapes; do not duplicate schema-owned types. [General design](../references/general.md) and [TypeScript](../references/typescript.md) supply detail when those decisions apply. Preserve another language's own contract. |
| Comments | Inspect affected public documentation and important private invariants, units, defaults, fields and fixture construction. Explain the reason, not trivial syntax. Read [comments](../references/comments.md) for comment/API decisions. |
| Documentation | Compare affected examples, commands, reports and design claims with source. Distinguish implemented, proposed and measured behavior. Read [documentation](../references/docs.md); select write-docs for substantial authoring, not to excuse docs in ordinary code work. |
| Naming and imports | Names must work at the call site and in the owning namespace. Resolve real exports and host dependencies, keep imports inert, separate types from values. Direct runner/assertion imports are legitimate. Read the relevant [naming sections](naming-and-folder-structure-guide.md) before judging those decisions. |
| Structure and formatting | Preserve cohesive logic and meaningful ordering; extraction is not automatically readability. Apply the local formatter to changed scope. Read the relevant [formatting sections](code-formatting-guide.md); do not reformat unrelated files. |
| Tests and performance | Use independent oracles and meaningful behavior assertions; green types/tests do not prove a user flow. Read [testing](../references/testing.md) for test decisions and [benchmarking](../references/benchmarks.md) for performance claims. Faster unequal behavior is rejected before timing. |
| Review and completion | Trace the changed contract with [review](../references/review.md), bind claims to evidence with [validation](../references/validator.md), and preserve a recoverable [delivery](../references/delivery.md). Read the applicable detail before declaring completion. |
| Readability and handoff | Read [readability and ownership](readability-and-ownership.md) for substantial work. Explain outcome, user steps, owners, state/failure/recovery, and usable verification. Inspect the actual artifact as a first reader, repair essential gaps, and report a concrete support mechanism or finding with limits. Checks do not prove human comprehension. |

Read this contract once per task, then applicable detail before making its
judgments. Before naming or formatting decisions, read the relevant sections of
[engineering standards](engineering-standards.md), then the decision-specific
naming/formatting guide. This is a section-based prerequisite, not a whole-book
reading requirement. Budget the entire tool response, including merged/parallel outputs.
Read required files in bounded chunks, recover omitted text after truncation,
and select headings in long guides rather than dumping trees. A filename or
truncated output is not evidence that its rules were read.

## Compose the decisions, not every skill

Use [applying standards](applying-standards.md) to resolve a convention at its
actual call site and select only the affected domain or runtime owners.

Choose the requested capability: plan-changes for a plan, refactor-code for a
cutover, test-code for test design or reproduction, review-code for findings,
benchmark-code for measurement, verify-behavior for execution evidence,
write-docs for substantial documentation, commit-changes for Git grouping,
prepare-pull-requests for reviewer prose, release-software for release work.
Ordinary implementation stays with its actual domain owner. Keep one discovery,
one integrated plan and one completion verdict; do not recursively load all
skills or apply a role brief's fixed output template over user/host requirements.

| Decision in scope | Load the installed companion before making it |
| --- | --- |
| HTTP/service/gateway contracts | build-apis; build-auth when authentication/session policy changes |
| Storage/query/migration/ClickHouse projection | build-data; build-auth for auth-owned schema/config |
| Durable jobs, replay, idempotency and recovery | build-workflows |
| CLI grammar/streams/exits | build-clis |
| Reusable APIs/exports/ownership | build-libraries |
| Mise, CI, generators and harness mechanics | build-devtools |
| Deno execution or Deno/JSR package contracts | deno-software, including read-only reviews of Deno code |
| Python runtime/tooling | python-software; preserve the local Python runner and external field spelling |
| Rust packages, binaries, memory, SIMD, Wasm, FFI or Cargo | rust-software; require actual operations on declared native and Wasm hosts |
| Exact utility APIs from `okikio/utils`, when selected by the consumer | use-utils; verify source or installed exports and publication separately |
| Material dependency choice | explore-ecosystems |
| Renderer/browser/focus/hydration/motion execution | build-web; build-sites for publishing, build-web-apps for app state |
| Visual hierarchy and motion purpose | design-interfaces; accessibility for detailed access audits; shadcn for its exact installed primitives |

Add only owners whose decisions are affected, not every technology mentioned.
If a companion is unavailable, inspect its real contract and state the material
limit; do not claim it ran. Detail resources and upstream technical examples
cannot reselect the retired deliver-software umbrella, expand scope, force
installs/prompts or override this entrypoint's mode. Their applicable technical rules remain useful; historical entrypoints live in Git. Current repository facts and explicit user requirements
control historical examples, package names, task commands and version claims.

For substantial changes, carry implementation, obsolete-path removal, internal
validation, actual capability verification and plan reconciliation separately.
Run focused evidence then affected full gates. Inspect the exact built artifact
for artifact claims. Before running stateful work, identify target, credentials,
consequences and cleanup; never borrow ambient production state. Report unrun
or blocked checks honestly, without inventing a guarantee or another toolchain.
