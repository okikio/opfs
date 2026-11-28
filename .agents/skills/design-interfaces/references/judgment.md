# Interface design judgment

## The decision model

A user reads an interface to decide what is happening and what to do next.
Hierarchy directs attention; spacing groups related information; typography
distinguishes roles; feedback makes state changes understandable. Evaluate each
choice against that task before applying a visual preference.

Use this reference for visual creation, redesign, critique, or polish. Browser
semantics and renderer lifetimes belong to the selected web implementation
skill. They constrain the design even when they do not choose its appearance.

## Start with representative content

Review the actual entry state and the state after the primary action. For a
table, use long names, missing values, large numbers, loading, failure, selected
rows, and narrow viewports. For a marketing page, use the real title, explanatory
copy, primary action, supporting evidence, and the intended content sequence.

Do not design only against evenly sized placeholder cards. A layout that
depends on short labels is a content contract; either justify that limit or
make the layout tolerate realistic text. For a systematic stress test or a
wrap, truncation, or disclosure decision, use the [Break UI catalog](rendered-content.md).

When reviewing an existing surface, compare observed output with the brief and
local design system. Capture enough states to support the finding. Source code
can prove a missing label or unbounded layout rule; it cannot by itself prove
that rendered optical alignment looks wrong.

## Direction and hierarchy

Choose a direction from audience, brand, task, and content. Describe it through
concrete choices rather than a mood adjective alone. For example, a monitoring
tool may use compact rows, restrained status colors, tabular numerals, and a
clear alert hierarchy. A campaign page may use larger type and a stronger image
sequence. Neither treatment is a universal default.

Ask:

- Can the reader identify the primary action and the most important fact?
- Are headings, labels, values, help, and diagnostics visibly different roles?
- Does the grouping follow the user's decisions rather than component folders?
- Does repeated decoration compete with state or content?
- Does an existing token/component already express the needed role?

Preserve a coherent existing language. Introduce a distinctive detail when it
supports the brief, not because every interface must have unusual fonts,
gradients, a hero illustration, or an animated background.

## Typography, spacing, and density

Use a small, explainable hierarchy. Verify long headings, localization, wrapping,
zoom, and real data. Tabular numerals help comparisons in numeric columns;
proportional text remains appropriate for ordinary prose. Choose font loading
with the asset owner so first paint and fallback metrics remain usable.

Spacing communicates relationships. Use a consistent rhythm, then allow
intentional exceptions for optical alignment or a different information role.
Dense work surfaces can be appropriate for repeated scanning. Density still
needs readable text, usable hit areas, and clear focus/selection.

Nested curves often look coherent when the outer radius accounts for inner
radius and padding. Treat this as an optical starting point, not an arithmetic
law for every shape. Shadows and borders should communicate elevation,
containment, or separation. Inspect them at the actual scale and background.

## States and interaction cost

Design hover, focus, pressed, selected, disabled, pending, success, and failure
where the control supports those states. Focus must remain visible independently
of hover. Do not make touch users depend on hover-only information.

Keep the user's action available and the system's response clear. Distinguish
empty results from unavailable data, pending work from successful completion,
and a denied action from a broken service. Error recovery should preserve useful
input and identify an actionable next step.

Native semantics provide keyboard and assistive behavior that styling must
preserve. A visually attractive clickable `div` has not replaced a button's
contract. Automated accessibility scans provide supporting evidence; exercise
the changed keyboard/focus path and inspect the relevant rendered states.

## Motion explains change

Before adding movement, name what it communicates: origin, continuity,
reordering, feedback, or intentional personality. If that explanation is weak,
try a static transition or immediate update.

Frequent menus and repeated data operations should avoid accumulated waiting.
Longer movement may need different timing from a short press response. Do not
turn a preferred duration, spring, or easing curve into a universal pass/fail
rule. Entry and exit have different purposes; symmetric timing is not required.

Exercise rapid reversal, repeated activation, navigation, reduced motion, and
interruption. Reduced motion may keep essential state feedback through opacity
or an immediate change. The chosen implementation must retire listeners,
animations, measurements, and other resources with its real framework owner.

Transforms and opacity are often useful starting points for animation, but
compositor suitability does not prove low cost. Filters, layers, large surfaces,
measurement, and device constraints can dominate. Measure a reported stutter in
the actual flow before claiming a performance fix.

## Compare evidence and report

Use before/after screenshots at comparable viewport and state for appearance.
Use interactions for keyboard, focus restoration, reduced motion, interrupted
movement, and repeated actions. Use traces for performance claims. A successful
build supports implementation integrity but proves none of those alone.

For each finding, connect the observed state to a user consequence and a
specific correction. Avoid line findings that merely restate a taste rule.
If the requested work is a critique, stop at findings and proposals. If it is
implementation, verify the changed flow and state the remaining evidence gap.

## Sources and limits

Synthesized from the supplied design-skills collection: baseline-ui,
interface-design, frontend-design, make-interfaces-feel-better,
fixing-accessibility, fixing-motion-performance, emil-design-eng, and
12-principles-of-animation, inspected 2026-10-14. These are supplied examples,
not one normative standard or a guarantee of visual quality. This reference
retains decision criteria rather than copying vendor rule catalogs or
unconditional tool instructions. Renderer-specific overlays are selected only
after inspecting the current renderer and version.
