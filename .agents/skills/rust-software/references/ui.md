# Choose a UI from the actual native and browser journeys

Define the user actions, required platforms, accessibility, text input, window
behavior and startup/memory budgets. A rendering demo is not an application
readiness test. Keep product state and transformations separate from host UI
adapters where this preserves the same behavior without needless abstraction.

## GPUI requires fresh source inspection

GPUI's platform support is evolving. Do not repeat an old blanket claim that it
is desktop-only, or assume a browser module provides desktop feature parity.
The inspected Zed upstream revision on 2026-11-26 includes `gpui_web` and Wasm
selection in `gpui_platform`. Pin the exact repository revision or published
crate and verify its dependency/feature graph before using it.

At revision `a3ce8d5e88e35697b2ba1cf9cb3c6816089b8281`:

- `gpui_web` documents one document-owned canvas and one top-level window.
  A second window or reopening a closed one returns `WebWindowError`.
- Its platform prefers WebGPU and can fall back to WebGL2. Verify the product's
  actual rendering path and adapter availability.
- `gpui_platform` defaults to `multithreaded`. Its manifest says the browser
  threaded path needs nightly and a page with cross-origin isolation; with the
  feature off, the documented web path builds on stable.
- Source offers `single_threaded_web()` and web initialization. Those names are
  evidence at this revision, not a promise about every released GPUI package.
- The upstream README calls the project pre-1.0 and warns of breaking changes.

These are source observations. This research did not build or execute a GPUI
application. Require a direct minimal app test before adoption. Check release
availability separately from code existing on the repository's main branch.

## Test what the user will actually do

Verify startup, first interactive frame, keyboard focus, screen-reader output,
IME/composition, clipboard, drag/drop, resizing, scale changes and text shaping.
Test visible/hidden windows, suspension, device loss, background tasks and cleanup.
Observe resource lifetime when a view or window closes; retained state can outlive
the UI that created it. Exercise repeated open/close behavior where supported.

For browser targets, test network credentials, permissions, canvas/input sizing,
worker setup and isolation headers in actual supported browsers. Do not use Node
as proof of browser input, accessibility or rendering behavior.

Measure the whole frame budget, not only a rendering function: state updates,
layout, text, paint, upload and presentation. Use representative lists and edit
patterns. A shared string or arena can reduce copies while retaining a large
graph; inspect retained memory and cleanup as well as frame latency.

If required native behavior has no browser/Wasm equivalent, preserve the product
requirement and state the gap. Evaluate an alternative Rust UI, a host-specific
UI over a portable core, or a different declared Wasm host through real fixtures.
Do not label an incomplete showcase as a shipping cross-platform application.

Sources: [GPUI](https://gpui.rs/),
[pinned platform](https://github.com/zed-industries/zed/blob/a3ce8d5e88e35697b2ba1cf9cb3c6816089b8281/crates/gpui_platform/src/gpui_platform.rs),
[pinned manifest](https://github.com/zed-industries/zed/blob/a3ce8d5e88e35697b2ba1cf9cb3c6816089b8281/crates/gpui_platform/Cargo.toml),
[pinned web contract](https://github.com/zed-industries/zed/blob/a3ce8d5e88e35697b2ba1cf9cb3c6816089b8281/crates/gpui_web/src/gpui_web.rs).

Read the [reproducible evidence requirements](evidence-index.md) before relying on a research observation.
