
# Web Interface Guidelines

Use these instructions for any user-facing browser interface, regardless of whether the implementation uses Astro, React, Solid, or plain HTML.

Use this file as the universal layer. When writing or reviewing framework-specific code, apply this file first, then apply the Astro, React, or Solid instruction file.

Do not apply this file to backend-only code, commit messages, changelog entries, or source-level TSDoc unless the task is specifically about browser-facing behavior.

## Default stance

Build the smallest durable interface that preserves semantics, accessibility, performance, and clear state ownership.

Prefer:

- Semantic HTML before custom component abstractions.
- Native browser behavior before JavaScript reimplementation.
- Composition before boolean prop configuration.
- Explicit variants before hidden conditional modes.
- Progressive enhancement before client-only rendering.
- Real loading, empty, error, pending, and success states before happy-path UI.
- URL state for shareable navigation state.
- Clear focus behavior for every interaction that opens, closes, hides, disables, or moves content.

Avoid abstractions that hide structure, state ownership, accessibility semantics, or framework APIs.

For complex interface workflows, document or model the full user-visible
lifecycle instead of reducing it to a happy-path component tree. Good UI
architecture shows who owns state, which region can be loading or stale, how
errors recover, where focus moves, and what happens during cleanup or navigation.

## Work in priority order

When writing or reviewing an interface, reason in this order:

1. User task completion and correctness.
2. Native semantics and accessibility.
3. Keyboard, focus, and interaction behavior.
4. Composition API and state ownership.
5. Loading, empty, error, pending, and success states.
6. Server, client, hydration, and navigation states.
7. Layout resilience, styling, theming, and visual states.
8. Performance, bundle cost, and browser work.
9. Tests, examples, and maintainability.

This order matters. A polished component that breaks form submission, focus order, or browser navigation is not ready.

## Design composition before props

Design component APIs around semantic regions and state ownership scopes.

Ask these questions before adding props:

1. What stable regions does this component expose?
2. Which regions are static structure and which are interactive?
3. Where does state live, and who needs to read or update it?
4. Which native element or browser behavior must be preserved?
5. Which framework primitive should express this in the current renderer?

Avoid boolean props for structural variation.

```tsx
// Avoid: one component owns too many hidden modes.
<SearchPanel
  compact
  showFilters
  showSort
  showFooter
  renderResult={(result) => <ResultCard result={result} />}
/>
```

Prefer named regions and explicit composition.

```tsx
<SearchPanel.Provider query={query} onQueryChange={setQuery}>
  <SearchPanel.Root>
    <SearchPanel.Header>
      <SearchField />
      <SearchSort />
    </SearchPanel.Header>

    <SearchPanel.Filters>
      <CategoryFilter />
      <PriceFilter />
    </SearchPanel.Filters>

    <SearchPanel.Results>
      <ResultList />
    </SearchPanel.Results>
  </SearchPanel.Root>
</SearchPanel.Provider>
```

The exact syntax should be native to the framework:

- In React, use children, compound components, and context when descendants share state.
- In Solid, use children, context, signals, accessors, stores, and Solid control flow.
- In Astro, use default and named slots. Hydrate only the interactive island that needs browser state.

## Use examples to prove the API

Every reusable interface pattern should include at least one usage example that proves the API works in context.

For stateful or async interface patterns, prefer examples that show the lifecycle
through named regions rather than a compressed one-line composition. Include
loading, stale, empty, error, retry, success, and cleanup paths when those states
are part of the contract.

The example should show:

- The parent that owns state.
- The regions the caller composes.
- The child components that consume state or actions.
- The native elements produced for links, buttons, forms, lists, and headings.
- The loading, empty, and error path when data is involved.

Avoid examples that only show the happy path.

```tsx
// Better example: state, regions, and async states are visible.
<SearchExperience.Provider source={searchSource}>
  <SearchExperience.Root>
    <SearchExperience.Form />
    <SearchExperience.Status />
    <SearchExperience.Results empty={<EmptyResults />} error={<SearchError />} />
  </SearchExperience.Root>
</SearchExperience.Provider>
```

## Preserve native HTML first

Choose the correct native element before adding ARIA or JavaScript.

Use:

- `<button type="button">` for actions.
- `<a href="...">` for navigation.
- `<form>` for submission workflows.
- `<label>` associated with form controls.
- `<fieldset>` and `<legend>` for grouped controls.
- Proper heading order for document structure.
- `<ul>`, `<ol>`, and `<li>` for real lists.
- `<dialog>` only when the native dialog behavior fits the product and is implemented accessibly.

Avoid:

```html
<div role="button" tabindex="0" onclick="save()">Save</div>
<div onclick="location.href = '/settings'">Settings</div>
```

Prefer:

```html
<button type="button">Save</button>
<a href="/settings">Settings</a>
```

Use ARIA to clarify semantics that cannot be expressed natively. Do not use ARIA to disguise the wrong element.

## Make keyboard and focus behavior explicit

Any interactive component must work with keyboard, pointer, touch, screen readers, browser zoom, and reduced motion.

For overlays, dialogs, menus, popovers, comboboxes, tabs, and custom controls, ensure:

- Opening moves focus intentionally when the pattern requires it.
- Closing restores focus to a useful trigger or next task location.
- Escape behavior is predictable for dismissible surfaces.
- Tab order follows the visual and task order.
- Disabled, hidden, and inert content cannot be focused accidentally.
- Focus indicators are visible and not removed by CSS.
- Keyboard activation does not duplicate native button or link behavior.

Example modal review target:

```tsx
<Modal open={open} onOpenChange={setOpen}>
  <Modal.Title>Delete project?</Modal.Title>
  <Modal.Description>This action cannot be undone.</Modal.Description>
  <Modal.Actions>
    <button type="button" onClick={() => setOpen(false)}>Cancel</button>
    <button type="submit">Delete project</button>
  </Modal.Actions>
</Modal>
```

Review the example by asking:

- Does opening the modal set focus inside the modal?
- Does closing restore focus to the trigger?
- Is the title connected to the dialog name?
- Is the destructive action distinguishable from the cancel action?
- Does Escape close only when dismissal is allowed?

## Design forms as workflows

Forms are not only inputs. They are submission workflows with validation, pending state, recovery, and browser behavior.

When writing a form, ensure:

- Every field has a label or accessible name.
- Related fields use `fieldset` and `legend` where appropriate.
- Inputs have stable `name`, `id`, and `autocomplete` values.
- Submit buttons have an explicit `type`.
- Validation errors are connected to fields, not only shown in a toast.
- Pending state prevents accidental double-submit when needed.
- Failed submission preserves user input unless clearing is safer.
- Success state is visible or navigation is explicit.
- Browser autofill, password managers, and Enter submission are not broken.

Avoid:

```tsx
<form onSubmit={submit}>
  <input placeholder="Email" />
  {error && <Toast>{error}</Toast>}
  <button>Submit</button>
</form>
```

Prefer:

```tsx
<form onSubmit={submit} noValidate>
  <label for="email">Email</label>
  <input
    id="email"
    name="email"
    type="email"
    autocomplete="email"
    aria-invalid={emailError ? "true" : undefined}
    aria-describedby={emailError ? "email-error" : undefined}
  />
  {emailError && <p id="email-error">{emailError}</p>}
  <button type="submit" disabled={isSubmitting}>Create account</button>
</form>
```

Use client-side validation to improve feedback, not to replace server validation.

## Model data states before rendering data

For every data-driven interface, design these states before writing the visual layout:

- Initial state.
- Loading state.
- Empty state.
- Partial state.
- Error state.
- Retry state.
- Refreshing or stale state.
- Success state after mutation.

Avoid hiding stable UI behind full-page spinners when only one region is loading.

```tsx
<SearchResults>
  <SearchResults.Summary />
  <SearchResults.List />
  <SearchResults.Empty />
  <SearchResults.Error />
  <SearchResults.RefreshIndicator />
</SearchResults>
```

Make error messages actionable. Say what failed, what is preserved, and what the user can do next.

## Keep server, client, and hydration scopes safe

Do not let browser-only behavior leak into server-rendered output.

Avoid reading these during server render unless the framework provides a safe abstraction:

- `window`
- `document`
- `localStorage`
- `sessionStorage`
- `matchMedia`
- viewport size
- layout measurements
- random values that affect rendered markup
- time and locale output that can differ between server and client

Use a stable server value first, then enhance on the client.

```tsx
// Avoid when this affects initial SSR markup.
const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches

// Prefer a stable initial render, then client enhancement.
<html data-theme={serverTheme}>{/* client script may refine after load */}</html>
```

Hydration mismatches are bugs unless there is a narrow, documented reason.

## Put navigation state in the URL when it should be shareable

Use URL state for filters, tabs, pages, search queries, selected entities, sort order, and any state the user expects to share, bookmark, refresh, or restore.

Use local component state for ephemeral UI such as open menus, temporary drafts, hover state, and focus state.

Example:

```txt
/products?q=paperback&sort=newest&page=2
```

This is better than hiding the query, sort, and page inside local state when the page itself represents search results.

## Build resilient layouts

Write layout CSS that can survive real content:

- Long names.
- Missing media.
- Translated text.
- User font scaling.
- Narrow viewports.
- Touch targets.
- Dynamic content insertion.
- Error banners and loading placeholders.

Prefer intrinsic and modern layout primitives:

- Flexbox for one-dimensional layout.
- Grid for two-dimensional layout.
- Container queries when component layout depends on container size.
- Logical properties for writing-mode and localization resilience.
- CSS variables for theme tokens and dynamic values.

Avoid layout that only works for the mock data.

```css
.card-title {
  overflow-wrap: anywhere;
}

.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(18rem, 100%), 1fr));
  gap: var(--space-4);
}
```

## Make visual state reflect real state

Every visual state should map to product or interaction state:

- Hover.
- Focus visible.
- Active.
- Selected.
- Expanded.
- Pressed.
- Current.
- Invalid.
- Disabled.
- Pending.
- Loading.
- Success.
- Error.

Do not show a visual state without the matching semantic or interaction state.

```tsx
<button
  type="button"
  aria-pressed={isSelected}
  data-state={isSelected ? "selected" : "idle"}
>
  Grid view
</button>
```

## Use motion as interaction feedback, not decoration by default

Animation must preserve usability.

Ensure:

- Reduced-motion preferences are respected.
- Motion has a functional purpose, such as continuity, spatial orientation, feedback, or affordance.
- Enter and exit states handle interruption.
- Animated hidden content is not focusable.
- Drag, touch, wheel, and pointer interactions preserve native behavior unless overridden intentionally.
- Layout animation does not fight browser scroll or focus.

Example:

```css
@media (prefers-reduced-motion: no-preference) {
  .toast[data-state="open"] {
    animation: slide-in 160ms ease-out;
  }
}
```

## Treat images, media, and icons as content

For images and media:

- Use meaningful `alt` text for content images.
- Use empty `alt=""` for decorative images.
- Include dimensions or layout constraints to avoid layout shift.
- Prefer responsive image formats and source sizes.
- Do not lazy load critical above-the-fold images blindly.
- Add captions where the image needs explanation.

For icons:

- Hide decorative icons from assistive technology.
- Give icon-only buttons an accessible name.

```tsx
<button type="button" aria-label="Open settings">
  <SettingsIcon aria-hidden="true" />
</button>
```

## Keep performance tied to user experience

Optimize the work that changes user experience first.

Watch for:

- Excessive client JavaScript.
- Hydrating static content.
- Large dependency imports for simple UI.
- Re-rendering or recomputing large regions for small changes.
- Layout thrashing from repeated measure and mutate cycles.
- Unbounded observers, timers, animation loops, and event listeners.
- Images without sizing, compression, or responsive variants.

Performance improvements should preserve semantics and accessibility.

## Write interface copy that guides action

Use concise copy that explains state and next steps.

Prefer:

- Button labels that name the action.
- Empty states that explain how to proceed.
- Errors that identify what failed and whether user input was preserved.
- Loading text that describes what is loading.

Avoid generic text like `Submit`, `Error`, or `Something went wrong` when the product can be more specific.

```tsx
<p role="alert">We could not save your billing address. Your changes are still here. Try again.</p>
```

## Design for localization from the start

Avoid hard-coding assumptions that fail in other languages or regions.

Ensure:

- Text can expand without breaking layout.
- Dates, numbers, currencies, and relative times use locale-aware formatting.
- Directionality is considered for icons, spacing, and layout.
- Sort order and casing are locale-aware where product-relevant.
- Copy is not assembled from fragments that cannot be translated naturally.

Avoid:

```tsx
<p>{count} result(s) found</p>
```

Prefer a project i18n helper that handles plurals.

## Comments and docs

Add comments only when they explain intent, constraints, or non-obvious behavior.

Use comments for:

- Focus management decisions.
- Browser API timing.
- Hydration or SSR constraints.
- Accessibility tradeoffs.
- Performance-sensitive measurements.
- Non-obvious framework API decisions.

Avoid comments that repeat the code.

## Test through user behavior

For browser-facing UI, test the DOM behavior the user depends on.

Cover:

- Accessible names and roles.
- Keyboard navigation.
- Focus movement and restoration.
- Form validation and submission.
- Loading, empty, error, and success states.
- URL state and navigation.
- Responsive layout at meaningful breakpoints.
- SSR and hydration when the framework uses them.

Prefer tests that interact through labels, roles, and visible text.

## Review what you wrote

When reviewing an interface, report findings by severity:

- `[BLOCKER]`: prevents task completion, breaks accessibility, risks data loss, creates severe hydration/runtime failure, or exposes sensitive data.
- `[IMPORTANT]`: likely user-facing bug, maintainability issue, performance problem, state ownership issue, or missing meaningful state.
- `[NIT]`: clarity, naming, small style consistency, or optional cleanup.

For every finding, include:

1. The user-visible or maintainer-visible risk.
2. The exact file, component, or pattern.
3. The concrete fix.
4. A short example when the fix is not obvious.

Do not only say that something is wrong. Show how to make it right.

## Common anti-patterns to avoid

Avoid these patterns by default:

- Boolean prop proliferation for structural variation.
- Render props for static layout regions.
- Clickable `div`s where links or buttons belong.
- Toast-only validation errors.
- Full-page spinners for small loading regions.
- Client-only rendering for static or content-heavy pages.
- Browser APIs in server render.
- Missing focus restoration after overlays.
- Hidden content that remains focusable.
- Missing empty and error states.
- URL state trapped in local state when it should be shareable.
- Styling that only works for mock content.
- Animation that ignores reduced motion.
- Over-abstracted component APIs that hide the rendered HTML.
