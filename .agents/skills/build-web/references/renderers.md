# Renderers, islands, SSR, and hydration

These are anonymized illustrative examples adapted from historical project
reviews. Local paths, identifiers, and commands describe example ownership;
they do not establish maintained APIs or executed evidence for this project.
Trace the active consumer, verify public package sources for the installed
version, and run the relevant checks before adoption.


Use this reference when a route mixes Astro, Solid, React, plain scripts, custom elements, server islands, or client-side navigation. The goal is one DOM owner per subtree and deterministic server/client output.

## Contents

- Renderer evidence
- Escalation ladder
- Astro client and server directives
- Solid runtime contract
- React and cross-renderer handoffs
- SSR and hydration invariants
- Navigation and lifetime
- Failure signatures
- Verification
- Sources and freshness

## Renderer evidence

Before selecting a renderer, inspect:

- the direct import from the `.astro` file;
- the installed `@astrojs/<renderer>` integration;
- JSX transform and type settings;
- component registry target and behavioral primitive;
- icon plugin compiler;
- server renderer and hydration test environment;
- client directive and urgency;
- whether server HTML is required;
- resources acquired after mount and cleanup on disposal.

Type-compatible JSX does not prove that a component belongs to the configured renderer. React, Solid, Preact, and Astro components can expose similar file extensions while requiring different runtimes and lifecycle rules.

## Escalation ladder

Choose the lowest owner that meets the behavior:

1. Semantic HTML for links, buttons, forms, disclosure, media, tables, progress, and headings.
2. CSS for presentation, simple transitions, responsive state, and preference queries.
3. A page-local Astro script for narrow DOM behavior that does not need component state.
4. A custom element when behavior must be reusable across documents without a framework owner.
5. A framework island when fine-grained state, renderer primitives, or complex lifecycle justify hydration.
6. A server island when personalized/dynamic server HTML can be deferred independently of a cacheable page.
7. A full application router when long-lived navigation and application state dominate the surface.

The illustrative homepage separates two owners: native `<details>` owns FAQ disclosure, while a Solid island owns a WebGL depth scene. Hydrating the FAQ would add a renderer without adding capability.

## Astro client and server directives

Framework components render static HTML by default. A `client:*` directive hydrates a directly imported framework component:

| Directive | When it runs | Appropriate use | Main risk |
|---|---|---|---|
| `client:load` | Immediately | Above-fold interaction required at load | Competes with critical work |
| `client:idle` | Idle/load fallback; optional timeout | Noncritical interactive UI | Interaction may arrive before hydration |
| `client:visible` | Intersection observer; optional root margin | Below-fold or expensive island | Visibility is initial hydration, not later suspension |
| `client:media` | Matching media query | Truly media-specific functionality | Duplicates CSS visibility policy |
| `client:only="react"` / `"solid-js"` | Client render only | Browser-only component with no useful server output | Blank/fallback-first content and renderer hint required |
| `server:defer` | Independent request after shell | Personalized server fragment in cacheable page | Adapter/runtime and fallback required |

`client:only` skips server rendering, so Astro cannot infer the renderer. Use the framework string documented for the installed integration and provide useful `slot="fallback"` content. Do not use `client:only` merely to silence an SSR error; isolate and fix nondeterministic or browser-only behavior.

```astro
---
import SearchPanel from "../components/SearchPanel.tsx";
import AccountSummary from "../components/AccountSummary.astro";
---

<SearchPanel client:load initialSearch={validatedSearch} />
<AccountSummary server:defer>
  <div slot="fallback" aria-busy="true">Loading account summary…</div>
</AccountSummary>
```

The fallback must preserve layout and communicate state. A server island is not a client framework island: it defers server rendering and still needs an adapter.

## Solid runtime contract

Solid components execute once to create a reactive graph; they do not rerun like React functions. Preserve live access paths:

```tsx
import { createMemo, onCleanup, onMount, splitProps } from "solid-js";

function Chart(props: { points: readonly number[]; class?: string }) {
  const [local, rest] = splitProps(props, ["points"]);
  const maximum = createMemo(() => Math.max(0, ...local.points));

  let canvas!: HTMLCanvasElement;
  onMount(() => {
    const observer = new ResizeObserver(() => draw(canvas, local.points));
    observer.observe(canvas);
    onCleanup(() => observer.disconnect());
  });

  return <canvas ref={canvas} data-max={maximum()} {...rest} />;
}
```

Do not write `const { points } = props` or `const points = props.points` when the value must remain reactive. Use direct property access, an accessor, `splitProps`, or `mergeProps`. Use:

- signals for mutable local state;
- memos for pure derived state reused by consumers;
- effects for synchronization with external systems, not for ordinary derivation;
- `onMount` for browser-only setup after initial render;
- `onCleanup` in the owning reactive scope for listeners, observers, timers, frames, subscriptions, roots, and animations.

Returning a function from `onMount` is not Solid cleanup. Register `onCleanup` explicitly. Cleanup follows reactive ownership, which is not always the same as physical DOM insertion/removal; retained presence systems require a deliberate owner-retention design.

## React and cross-renderer handoffs

React and Solid may coexist at route level, but never mount both into the same DOM subtree. Keep shared contracts serializable or framework-neutral:

```text
server/domain data
  -> validated plain view model
  -> Astro document
      -> React island A
      -> Solid island B
```

Do not pass renderer-specific contexts, elements, hooks, signals, refs, or event objects between those renderer islands. If both islands need the same remote data, either render it into their initial models or define a server/query contract; do not synchronize through hidden DOM mutation.

Renderer-specific libraries must align:

- Kobalte and Corvu are Solid primitives; Base UI is React-oriented.
- A shadcn registry can generate different source for different renderers.
- Unplugin Icons needs a compiler/JSX mode matching the consuming renderer.
- `client:only="react"` is not valid evidence for a Solid file and vice versa.
- Auth clients may have generic, React, Solid, TanStack React, and TanStack Solid entrypoints with different provider requirements.

## SSR and hydration invariants

Server HTML and the first client render must agree on structure, ids, attributes, and initial styles. Sources of mismatch include:

- `Date.now()`, randomness, locale/time zone, unstable iteration order;
- reading `window`, media queries, storage, viewport, or permissions during render;
- environment values that differ between server and client;
- async data fetched independently on each side;
- animation libraries applying client initial styles that were absent in server HTML;
- invalid HTML repaired differently by the browser;
- component libraries generating unstable ids;
- auth/session capability determined again in the browser.

Use an explicit server snapshot:

```tsx
type InitialPreferences = {
  colorScheme: "light" | "dark";
  reducedMotion: boolean;
};

function PreferencesIsland(props: { initial: InitialPreferences }) {
  const [preferences, setPreferences] = createSignal(props.initial);

  onMount(() => {
    // Reconcile browser-only preferences after hydration; do not change the
    // first render that must match the server snapshot.
    setPreferences(readBrowserPreferences(props.initial));
  });

  return <PreferenceControls value={preferences()} />;
}
```

For motion, compute the initial style with a pure render-time function and start the runtime after mount. The uploaded Solid motion experiment tests serialized initial, `initial={false}`, omitted-initial, SVG, CSS-variable, and transform cases by rendering server markup and hydrating while collecting mismatch diagnostics.

Do not suppress hydration warnings without proving that the differing subtree is intentionally non-authoritative.

## Navigation and lifetime

Astro client-side navigation can execute page initialization repeatedly. Register idempotently or bind cleanup to navigation:

```ts
let pageController: AbortController | undefined;

document.addEventListener("astro:page-load", () => {
  pageController?.abort();
  pageController = new AbortController();

  document.addEventListener("click", handleDelegatedClick, {
    signal: pageController.signal,
  });
});
```

Prefer event delegation to adding listeners to every link on every page load. Do not prevent default behavior for all hash links without preserving focus, history, reduced motion, and invalid-selector handling. Astro's client router already provides route announcement and reduced-motion behavior for its transitions; custom code must not fight those contracts.

`transition:persist` retains an element or island across navigation. It changes lifetime and prop behavior. Decide whether new props should flow; `transition:persist-props` retains existing props. Persisting every shell island can retain stale auth, subscriptions, and memory.

## Failure signatures

| Signature | Likely contract error | Inspect next |
|---|---|---|
| `NoMatchingRenderer` or `client:only` failure | Missing/wrong integration or hint | Direct import, integration, renderer string |
| Hydration mismatch/first-paint flash | Nondeterministic initial state | Server HTML versus first client render |
| Solid prop stops updating | Reactive prop destructured/read eagerly | Props access paths and `splitProps` |
| Duplicate click after navigation | Repeated listener registration | `astro:page-load`, delegation, cleanup |
| Browser API error during build | DOM access during render/module evaluation | Mount gate and server import graph |
| Static content absent until JS | Unnecessary client-only island | Native/Astro server output path |
| Island hydrates but remains stale | Initial snapshot copied without synchronization | State ownership and update contract |
| Memory/CPU grows across routes | Resource or persisted island not disposed | Frames, observers, listeners, roots |
| Component renders with wrong behavior | Renderer-specific primitive copied | Registry and peer dependencies |

## Verification

1. Run framework typecheck plus the production build, not only editor diagnostics.
2. Capture raw server HTML and assert required content, initial styles, headings, and fallback states.
3. Hydrate representative routes while collecting console mismatch/warning output.
4. Disable JavaScript and evaluate the stated progressive-enhancement contract.
5. Navigate repeatedly and assert listener/observer/frame/subscription counts return to baseline.
6. Test slow hydration, interaction before hydration, fallback rendering, and island load failure.
7. Verify every `client:only` has a renderer hint and meaningful fallback.
8. Inspect built chunks to confirm static components did not become accidental islands.
9. Test reduced motion, route announcement, focus movement, and back/forward navigation.
10. Run renderer-specific component tests in the same JSX/test environment as production.

## Sources and freshness

- Astro template directives: https://docs.astro.build/en/reference/directives-reference/ (reviewed 2026-07-17).
- Astro view transitions: https://docs.astro.build/en/guides/view-transitions/ (reviewed 2026-07-17).
- Solid props: https://docs.solidjs.com/concepts/components/props (reviewed 2026-07-17).
- Solid `onMount` and `onCleanup`: https://docs.solidjs.com/reference/lifecycle/on-mount and https://docs.solidjs.com/reference/lifecycle/on-cleanup (reviewed 2026-07-17).
- Historical source scope: marketing, application, and experimental motion reviews, adapted here into anonymized renderer-ownership examples.
- Client directives, transition persistence, Solid runtime details, and experimental renderer adapters are version-sensitive. Verify installed versions before using an option not shown in repository source.
