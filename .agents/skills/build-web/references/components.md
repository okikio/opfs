# Component systems, primitives, styles, and assets

These are anonymized illustrative examples adapted from historical project
reviews. Local paths, identifiers, and commands describe example ownership;
they do not establish maintained APIs or executed evidence for this project.
Trace the active consumer, verify public package sources for the installed
version, and run the relevant checks before adoption.


Use this reference when selecting, generating, copying, repairing, or verifying UI components. A component file is the visible tip of a renderer, primitive, style, token, icon, font, and accessibility contract.

## Contents

- Component evidence inventory
- Generated component contract
- Primitive selection
- When the component already uses Sonner
- Component API design
- Styling and token ownership
- Accessibility and interaction
- Icons, fonts, and media
- Integration and upgrade procedure
- Failure signatures
- Verification
- Sources and freshness

## Component evidence inventory

For every component family inspect:

- `components.json` or other registry configuration;
- registry URL, style, target renderer, aliases, icon library, and generated path;
- package manifest and direct imports;
- headless behavior primitive and peer versions;
- variant builder and class merge helper;
- stylesheet entrypoint, layer order, generated classes, tokens, themes, and Tailwind scanning;
- renderer integration, JSX compiler, icon compiler, and test environment;
- wrapper components that add application policy;
- accessible semantics, keyboard map, focus ownership, portal/layer behavior, and form integration;
- which files are generated and which are application-owned.

Trace the route's imports into the application's feature compositions and
reusable primitives. A registry file such as `components.json` owns registry
aliases, and the application's `package.json` declares the renderer and
component dependencies.
Verify the local primitive and its callers before importing a recipe from
another renderer. For example, a site may use Solid and Kobalte;
similarly named dialogs and buttons are not interchangeable.

## Generated component contract

Treat generated source as a synchronized set:

```text
registry configuration
  -> renderer-specific generated source
  -> behavioral primitive packages
  -> variants/class utilities
  -> generated or base stylesheet
  -> semantic tokens and theme
  -> application wrapper and tests
```

Before copying a component, search for every non-platform import and class prefix. A `button.tsx` that references `z-*`, CSS variables, `cva`, or a registry helper will render incorrectly if only the TSX moves.

Choose an ownership policy:

- generated internals remain close to upstream and are regenerated intentionally;
- application wrappers add analytics, permissions, domain defaults, and composition;
- patches to generated code are recorded and covered by behavior tests;
- registry upgrades are reviewed as source changes, never accepted only because generation succeeded.

Do not run a generator across an unrelated dirty worktree without reviewing its planned files. Snapshot the affected component/style inventory first.

## Primitive selection

Prefer native HTML where its semantics and behavior fit. Use a headless primitive when the interaction requires a complete state machine such as dialog focus trapping, roving focus, menu keyboard behavior, combobox selection, or collision-aware popovers.

For Solid Primitives, treat the repository as an ecosystem of granular packages rather than a single hooks library. Search the monorepo by concern and inspect each candidate's README, package status badge, server tests, peer dependencies, and sibling helpers. Examples in the uploaded monorepo include:

- lifecycle and ownership: `@solid-primitives/lifecycle`, `rootless`, `refs`, `props`;
- browser signals: `media`, `page-visibility`, `connectivity`, `permission`, `platform`;
- observers: `intersection-observer`, `resize-observer`, `mutation-observer`;
- scheduling: `scheduled`, `raf`, `idle`;
- interaction: `event-listener`, `keyboard`, `pointer`, `gestures`, `active-element`;
- collections/state: `list`, `map`, `set`, `immutable`, `mutable`, `deep`;
- transitions/presence: `presence`, `transition-group`, `spring`;
- network/persistence: `fetch`, `broadcast-channel`, `cookies`, `db-store`.

For frontend library discovery, Emil's [curated UI library list](https://github.com/emilkowalski/skills/blob/5206a950b715e0cabe7043ea0b2304332b91494e/skills/pick-ui-library/SKILL.md)
is a starting point. Check native behavior and local primitives first, then
verify candidate renderer support, installed exports, accessibility, SSR,
and maintenance before recommending a change.

Package existence does not prove production maturity or suitability. Determine:

- `make*` low-level/non-reactive primitive versus `create*` reactive owner;
- server result and whether it is safe during SSR;
- cleanup semantics and owning Solid scope;
- equality and update behavior;
- package stage/maturity;
- browser support and fallback;
- whether another sibling package must be installed.

Do not install the whole ecosystem. Select the narrow capability and verify its actual exported API in the installed version.

## When the component already uses Sonner

For missing, duplicated, misplaced, or wrongly styled toasts, trace the
call through the installed Sonner API to the app's Toaster owner and theme.
Check that the calling surface and Toaster mount together; before adding a
second Toaster or raising z-index, inspect host lifetime and stacking. For
async actions, keep a single notification identity through pending and
terminal states, and report success only after the operation accepts it.
Errors that need action should also be reachable in the owning UI. Verify
toast visibility, screen reader announcement, and keyboard access in the
actual modal or page that triggers it.

Use Emil's [Sonner recipes](https://github.com/emilkowalski/skills/blob/5206a950b715e0cabe7043ea0b2304332b91494e/skills/ask-sonner/SKILL.md)
for the symptom at hand and verify API details against the installed version.

## Component API design

Prefer an API that exposes state and semantics rather than implementation accidents:

```ts
type DialogController = {
  open: boolean;
  onOpenChange(open: boolean): void;
};

type ConfirmDeleteProps = DialogController & {
  resourceName: string;
  pending: boolean;
  onConfirm(): Promise<void>;
};
```

Define:

- controlled versus uncontrolled ownership;
- initial/default value separately from current value;
- stable item identity;
- event ordering and cancellation;
- pending, disabled, readonly, invalid, and unavailable semantics;
- slot/child composition and prop forwarding;
- ref forwarding and DOM ownership;
- portal container and layering policy;
- SSR output and hydration behavior;
- cleanup and exit behavior.

Avoid boolean-prop explosions. Use variants or composed subcomponents when multiple independent behaviors produce incoherent combinations. Do not hide authorization inside a visual `disabled` prop; server policy remains authoritative.

## Styling and token ownership

Keep one semantic token source and an intentional layer order:

```css
@import "tailwindcss";
@import "tw-animate-css";
@import "shadcn/tailwind.css";
@import "./base.css";

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --radius-lg: var(--radius);
}
```

Verify the actual toolchain syntax before copying. Tailwind v4 `@theme`, `@custom-variant`, and layer behavior should not be backported to a different major version by appearance.

Component styling must survive:

- light/dark and forced-colors modes;
- 200% text zoom and narrow containers;
- long translated text and unknown content length;
- focus-visible, hover-capable and coarse-pointer devices;
- invalid, pending, disabled, read-only, selected, expanded, and destructive states;
- user font loading failure;
- portal content outside a scoped CSS ancestor.

Do not encode semantic state only in color. Do not remove focus outlines without a visible replacement. Prefer logical properties where bidirectional layouts matter.

## Accessibility and interaction

Start from the semantic element:

- action: `<button type="button">`;
- navigation: `<a href>`;
- disclosure: `<details><summary>` when its behavior fits;
- input: native labeled form control;
- grouped controls: `<fieldset><legend>`;
- data: semantic `<table>` with caption/headers when tabular;
- status: a restrained live region when an update needs announcement.

When a primitive implements ARIA patterns, test the complete keyboard interaction and accessible tree. A `role` without required keyboard/state behavior is worse than a native element.

For dialogs and overlays verify:

- trigger has an accessible name;
- initial focus is intentional;
- focus stays inside modal content and returns to the correct trigger;
- Escape behavior and outside interaction match task risk;
- background becomes inert/inaccessible when modal;
- nested portals and z-index do not split the interaction tree;
- destructive action explains consequence and does not make cancellation hard.

For repeated icon buttons, include the affected item in the accessible name, such as “Remove invoice 1042,” not twelve identical “Remove” controls.

## Icons, fonts, and media

Renderer ownership matters:

- Astro Icon renders icons in `.astro` templates.
- Unplugin Icons produces framework/compiler-specific virtual components for Solid or React islands.
- local SVG collections need provenance, sanitization, viewBox consistency, and naming policy.
- decorative icons use `aria-hidden="true"`; meaningful icons need a visible label or verified accessible name.

Avoid wildcard inclusion of complete icon sets unless bundle analysis proves the integration remains on-demand. The uploaded Astro configs include wildcard collections; treat that as a review target, not a recommended default.

Fonts need an owner, exact variants, subsets, fallback stack, metric compatibility, preload budget, and license/provenance. Preload only critical faces used above the fold. A page that preloads every configured family delays more important resources.

Images and canvas need dimensions/aspect ratio, responsive source policy, alt/fallback behavior, loading priority, and failure state. Complex canvas/WebGL visuals need a meaningful static alternative; do not expose decorative canvases to the accessibility tree.

## Integration and upgrade procedure

1. Classify renderer and component behavior.
2. Inspect the registry and upstream primitive source for the installed version.
3. Inventory generated files, styles, tokens, aliases, and dependencies.
4. Generate/copy into an isolated diff.
5. Reapply application wrappers and deliberate patches.
6. Test semantics before visual polish.
7. Test renderer build, SSR/hydration, and portal behavior.
8. Compare bundle, CSS, icons, fonts, and runtime resources.
9. Record unsupported variants or interactions.

Never claim parity with a shadcn or upstream component by matching its public prop names. Verify behavior, DOM, keyboard, focus, forms, styles, and failure modes.

## Failure signatures

| Signature | Likely cause | Next inspection |
|---|---|---|
| Component renders unstyled | CSS layer/token/generated class missing | Registry config and style entrypoint |
| Dialog opens but focus escapes | Primitive/wrapper contract incomplete | Focus scope, portal, modal settings |
| Solid component stops reacting | Props destructured or copied | Live access paths and wrappers |
| React component imported into Solid island | Registry target mismatch | Source imports and Astro integration |
| Icons work in Astro but fail in island | Wrong Unplugin compiler/JSX mode | Vite plugin and virtual import |
| Thousands of icons in output | Wildcard/eager collection inclusion | Plugin config and bundle graph |
| Dark portal has light tokens | Theme scoped below portal root | Token scope and portal container |
| Button submits unexpectedly | Missing `type="button"` | Rendered HTML/form context |
| Menu works by pointer only | Incomplete ARIA primitive or wrapper | Keyboard matrix and roles |
| Layout shifts when font loads | Missing metrics/dimensions/preload policy | Font fallback and waterfall |

## Verification

- Run registry or generated-source diff in isolation.
- Run renderer typecheck and production build.
- Render the component server-side and hydrate it with diagnostics captured.
- Test accessible name, role, states, keyboard sequence, focus entry/return, and form behavior.
- Test portals inside real layouts, dialogs, scroll containers, and nested overlays.
- Test content-length, zoom, RTL, forced colors, reduced motion, touch, and narrow container cases.
- Inspect CSS output for required generated classes and token definitions.
- Inspect bundle contents for icon collections, duplicate primitives, and accidental framework runtimes.
- Count listeners/observers/frames across mount/unmount.
- Verify image/font/icon failure and fallbacks.

## Sources and freshness

- Historical source scope: site, application, and Solid Primitives reviews from 2026-07-17, adapted into anonymized component examples.
- Solid Primitives official catalog: https://primitives.solidjs.community/ (reviewed 2026-07-17).
- Solid props and `splitProps`: https://docs.solidjs.com/concepts/components/props (reviewed 2026-07-17).
- Astro Icon and Unplugin Icons are detailed in `build-sites/references/icons.md`.
- Registry schemas, generated component source, Tailwind directives, and package maturity are version-sensitive. Inspect installed source rather than copying current examples blindly.
