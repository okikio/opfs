# Keep touch interactions usable on phones

Use the gesture section for a custom drag, swipe, or hold. Use the mobile
browser section when scrolling, browser controls, safe areas, or the on-screen
keyboard change what the user can reach.

## Give the gesture one owner

First check native controls and the installed primitive. A native scrolling
carousel or an existing sheet may already handle the gesture, focus, and
dismissal. When a custom gesture is needed, name who owns the pointer stream,
which axis stays with native scroll, and which action the gesture can commit.

- **Track while held.** Follow pointer displacement on the owned axis, except
  for deliberate resistance at bounds. Drive related effects, such as sheet
  and backdrop, from one progress value. Keep per-frame writes local to the
  renderer or driver; commit application state at the interaction boundary.
- **Settle after release.** Start at the displayed position. Use directional
  release velocity where a flick is meaningful; choose thresholds against the
  action's cost. A fast flick may dismiss a sheet; it should not turn a
  reversible preview into an irreversible action. A re-grab takes over from
  the displayed position and invalidates the previous completion.
- **Cancel without committing.** If using pointer capture, track the owning
  pointer ID. Handle `pointercancel`, unexpected `lostpointercapture`, and
  unmount; make teardown safe to call twice because normal release also loses
  capture. Cancel the driver and discard its stale callbacks. On cancellation,
  settle at a valid state; on unmount, release resources with the owner.

Scope `touch-action` to the interaction surface before pointer contact. The
allowed axes belong to the browser: for a custom horizontal drag, preserve
vertical scrolling with `pan-y` and preserve pinch zoom where supported with
`pan-y pinch-zoom`. Inspect ancestors too. Give a vertical sheet a dedicated
handle if its body needs vertical scrolling. Keep links and buttons in the
body independently operable.

Provide a click or tap alternative for authored drag functionality unless
dragging is essential, plus a keyboard path. Under reduced motion, keep useful
direct tracking and remove nonessential fling or bounce. For a timed hold,
make progress reflect elapsed time and cancel on early release; route any
confirmation alternative through the same action owner.

**Example:** In a receipt detail sheet, scrolling the receipt body should not
dismiss it. Dragging the handle can move the sheet and fade its backdrop from
the same progress value. If the browser cancels the pointer stream, settle at
the last committed snap state and keep focus inside the open sheet. The Close
button and Escape use the same dismissal path and return focus to the opener. Check a short flick, a slow drag
below threshold, a re-grab during settling, and cancellation with the sheet
still open.

## Diagnose mobile browser behavior

| Symptom | First check |
| --- | --- |
| A tap leaves hover styling stuck | Limit decorative hover to hover-capable inputs; retain visible focus and press feedback. |
| A tap flashes or responds late | Separate the browser highlight and activation from slow application work. Preserve visible press and focus feedback if changing the highlight. Check native buttons and viewport settings before adding a touch handler; do not disable pinch zoom to fix latency. |
| A bottom action falls below browser chrome | Choose a stable small viewport (`svh`) when the layout should fit with toolbars visible, or a dynamic one (`dvh`) when it should track toolbar changes. Test the on-screen keyboard separately. |
| A fixed action meets the home indicator or cutout | If the shell opts into edge-to-edge layout, apply safe-area insets to the affected control or container without double padding. |
| Focusing a field zooms or hides its action | Check rendered input text size and keyboard behavior in the target browser. Preserve user zoom; verify the field, its error, and the submit action remain reachable. |
| Reaching a scroll edge moves the page behind a sheet | Inspect the actual scroll container and its axis. Scope `overscroll-behavior` to that container when needed; preserve ordinary page scrolling and browser navigation elsewhere. |
| A carousel fights vertical page scrolling | If the strip only needs horizontal scrolling, try native overflow and scroll snap first. For a custom drag, give the browser the vertical axis and keep pinch zoom. Test a swipe, a vertical scroll, and the keyboard path. |
| A long press selects a handle or icon | Scope any selection suppression to the control. Keep receipts, references, and other copyable text selectable. |
| The installed app has a mismatched status bar or clipped header | If standalone mode is supported, check it separately from a browser tab, including theme, orientation, and safe areas. |

For forms, use the correct semantic input type and use `inputmode` or
`enterkeyhint` when they help users enter the expected value. Check supported
locale decimal input and validation separately from the keyboard hint.

Use emulation for layout and early checks. For claims about native scroll,
touch feel, focus zoom, browser chrome, or the keyboard, exercise the affected
sequence on representative hardware. Record device, browser, and what was
observed; mark hardware behavior unverified if no device is available.

Sources: Emil Kowalski's [gestures](https://github.com/emilkowalski/skills/blob/5206a950b715e0cabe7043ea0b2304332b91494e/skills/gestures/SKILL.md)
and [mobile-native](https://github.com/emilkowalski/skills/blob/5206a950b715e0cabe7043ea0b2304332b91494e/skills/mobile-native/SKILL.md)
([MIT notice](../../design-interfaces/references/sources/emil-design-eng/LICENSE)).
Browser contracts: [Pointer Events](https://www.w3.org/TR/pointerevents3/),
[overscroll behavior](https://drafts.csswg.org/css-overscroll-1/),
[viewport units](https://web.dev/blog/viewport-units),
[HTML input hints](https://html.spec.whatwg.org/multipage/interaction.html#input-modalities:-the-inputmode-attribute),
[CSS scroll snap](https://www.w3.org/TR/css-scroll-snap-1/),
[WebKit safe areas](https://webkit.org/blog/7929/designing-websites-for-iphone-x/),
and [WCAG dragging movements](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html).
