---
name: design-interfaces
description: Design or review the visual hierarchy, layout, typography, density, surfaces, interaction states, and motion purpose of websites and product interfaces. Use for a new interface, redesign, design critique, prototype comparison, dashboard, landing page, component polish, or an interface that feels unclear or generic. Compose with build-sites or build-web-apps for implementation and with build-web for shared browser contracts. Do not activate for a backend change or a frontend logic fix that leaves the design unchanged.
---

# Design interfaces

## Reading boundary

Minimum: read this entrypoint and the linked shared software-quality contract.
Read resources explicitly marked required for the operation; for long guides,
read the applicable sections before making that decision. Use other references
only when they resolve a decision actually in scope. Do not read an entire tree
or recursively select every companion to prove diligence. Recover truncated
required reads. Stop expanding context when the applicable rules and source
behavior are understood; report any material unavailable guidance.

## Shared obligations and companion selection

Read [software quality](../../guides/software-quality.md) before this capability's work.
Comments, docs, naming, imports, readability and correctness are explicit duties
even when no companion is separately selected. Read the applicable detailed
sources linked there before judging those decisions; recover truncated required
reads. The selected capability and real domain/runtime owners share one plan
and verdict. Read this entrypoint and the shared contract first. Read linked detail only
when its decision is in scope; stop when the applicable contract is understood.
Do not recursively load companion skills or historical material for reassurance.



Design makes the user's next action and the system's current state legible.
Visual choices should follow the audience, task frequency, content, brand, and
interaction cost. Distinctiveness is useful when it serves that brief.

## Select the complete task

Read [applying standards](../../guides/applying-standards.md) to select companions and
apply conventions by purpose. If installed, the shared quality contract owns code,
tests, naming, documentation, and delivery. This skill owns visual judgment;
`build-sites` owns publishing and `build-web-apps` owns application state.
Use `build-web` when the task changes or verifies semantics, renderer, motion
execution, keyboard/focus behavior, or browser resources. Verification planning
also needs that owner even when the visible design is only a proposal. A visual review does not authorize implementation.

## Establish the brief

For an existing interface, inspect the rendered surface, representative content,
tokens, components, and the states affected by the request. Use screenshots when
available. If rendering is unavailable, distinguish code findings from visual
findings. For a new interface, infer a provisional brief from the request and
state material assumptions; do not invent a brand or business metric.

Identify the primary user action, information hierarchy, repeated interactions,
required states, responsive constraints, and existing visual language. Preserve
the user's chosen direction unless changing it is within scope.

## Make and test a design decision

1. Describe the direction in concrete terms: type hierarchy, content density,
   spacing rhythm, color roles, surfaces, and interaction feedback.
2. Explain how those choices make the task easier. A dense admin table and a
   campaign page can require different answers to the same layout question.
3. Work through realistic long content, empty/loading/error/success states,
   selected/disabled/focus states, and narrow layouts where applicable.
4. Use motion to explain continuity, origin, or feedback. Judge timing by travel,
   frequency, interruption, and user cost; no universal duration proves quality.
   For proposals to add motion, use [where motion would help](../build-web/references/motion.md#find-where-motion-would-help).
5. Verify rendered hierarchy, reflow, keyboard/focus, contrast, reduced motion,
   and interruption at the level affected by the change. A screenshot proves
   appearance at that state, not accessibility or lifecycle correctness.

## Read only the detail needed

- [Break UI: rendered content](references/rendered-content.md): use when long labels, crowded controls, or wide values make the next action harder to read. Inventory the slots, decide what needs to stay exact or be available on demand, then test the chosen treatment with realistic content. Keep review separate from fixes.
- [Compare prototypes](references/compare-prototypes.md): when asked to compare
  directions, use the same task and content in each. Keep interactive
  exploration in an isolated preview when the comparison calls for one.
- [judgment.md](references/judgment.md): choosing and reviewing hierarchy,
  density, typography, surfaces, state feedback, and motion without applying a
  stylistic checklist mechanically.
- [PRD guide](../../guides/prd-guide.md): when the user problem, audience, product
  scope, or success criterion needs a durable specification.
- [engineering standards](../../guides/engineering-standards.md): deeper code or
  documentation conventions when implementing and more depth is needed.

Report a design finding as observed state, user consequence, concrete change,
and verification. Report an unrendered proposal as a proposal. Do not invent a
visual defect from a component name or claim a measured performance gain from
the CSS property chosen.

## Visual and motion sources

Read [Apple interaction](references/apple-design.md) or
[Emil polish](references/sources/emil-design-eng/README.md) for the relevant
interaction decision. Use [motion judgment](references/judgment.md) and
[renderer execution](../build-web/references/motion.md) to select and verify an
effect. Consult an upstream catalogue only when a concrete effect calls for it;
check its current specification and license. This collection does not vendor
restricted transition packs or claim that a screenshot proves runtime behavior.

The brief, existing design system and judgment reference control stylistic conflicts. Do not import a forced greeting, scan the entire project, run installs or ask for redundant confirmation because an upstream source says so. Apple system-font defaults, anti-default-font advice, fixed timing/keyboard rules and permanent will-change are contextual advice, not universal requirements. Preserve exact selected effect specifications when that is the task; adapt generic examples to the current tokens, renderer and ownership.

For naming an unfamiliar effect, consult Emil's [animation vocabulary](https://github.com/emilkowalski/skills/blob/5206a950b715e0cabe7043ea0b2304332b91494e/skills/animation-vocabulary/SKILL.md). A name describes what to look for; use the local judgment and runtime references to decide whether and how to build it.

Use build-web before choosing animation/presence mechanisms, cancellation, gesture velocity, hydration, focus or reduced-motion execution. Discrete state transitions and direct manipulation have different requirements. Reduced motion needs a useful replacement or terminal state and cleanup, not an arbitrary global near-zero duration. Use accessibility for detailed audits. Measure actual rendering cost before claiming GPU/compositor performance. A source screenshot or a familiar easing curve is not runtime proof.

## Resource navigation

The [complete resource index](references/resources.md) lists this capability’s maintained detail and assets. Use it only to
locate a decision-specific resource; it is not a reading checklist.
