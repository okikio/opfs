# Break UI: verify text and data in the actual layout

Use this when a review or test needs to establish whether the affected
interface still works with difficult content. Start with the user's action:
what must they read, tell apart, or reach to complete it?

## Inventory every rendered text slot in scope

Trace visible text in the affected view and its states: headings, labels,
buttons, table cells, badges, inline help, errors, empty states, tooltips,
toasts, and any compact alternate layout. Include authored or translated copy
alongside record fields. For each slot record the component and container,
source or message key, accepted type and limits, and what the user must be able
to read or recover. Include accessible names where shortening visible text
could change what assistive technology announces.

Exercise the accepted boundary with ordinary and difficult values. Test
invalid input or service failure separately; a missing required value is not
a valid extreme. Use synthetic data and reserved example domains, injected
through the real formatting/data boundary using an existing fixture or preview
where possible. Don't add a production worst-case toggle for a review.

## Choose cases by what can break

| Slot or condition | Example cases to adapt to its contract | What to check |
| --- | --- | --- |
| Names and free text | Single character; long hyphenated name; wide unbroken run; whitespace or newlines if accepted; combining accents, CJK, RTL text with punctuation, joined emoji | Glyphs and meaningful characters survive; wrapping, initials, ordering, and direction are usable. Text that resembles markup stays literal when the contract is plain text. |
| IDs, filenames, emails, links | Long token without spaces; two filenames with the same prefix but different versions or extensions; plus-addressed email on `example.com`; long URL with a query | One value cannot push other fields away; the distinguishing portion and a path to the full value remain available. Display shortening must not alter copy, link destination, or record identity. |
| Translated labels and generated copy | Long compound words, expanded translations, short labels, plural forms at zero and one; longest error or badge beside longest record name | Labels and recovery instructions remain readable; controls retain their accessible name, target, and focus. |
| Numbers and money | Null vs. zero; negative and large values; widest valid precision; grouping, currency and sign in supported locales; values on both sides of a rounding or compact-notation threshold | Exact values stay readable where the task depends on precision. An approximation keeps its sign and currency and has a usable route to the exact value. Verify formatting independently of the component's own formatter. Don't treat a missing value as zero. |
| Collections | Empty, singleton, page size and page size plus one; duplicate display names; one unusually tall item amid ordinary rows | Empty states and pagination are correct; row identity and actions remain distinct; unusual height does not hide neighboring content. |
| Dates and times | Future date; just before and after a day boundary in the display timezone; long absolute and relative forms | Date, ordering and wording follow the product policy; the widest displayed form fits. |
| Media and state | Missing, failed, slow, or unusually shaped image; loading, partial results, unavailable data, and denied actions | Text and actions remain usable around placeholders; errors have a recovery path; layout still makes sense when controls are absent. |
| Environment | Actual narrow container, zoom or large text, fallback fonts, supported writing directions, touch, and theme | Inspect clipping, overlap, page scrolling, focus, contrast and access to the full content. A responsive screenshot alone cannot prove keyboard or touch access. |

Combine plausible extremes that compete for the same space; for example, put
a long translated status and a wide negative amount beside a long merchant
name. Keep a normal control fixture for comparison. Pick cases for actual
fields and supported environments; this table does not define product limits.

## Decide how each slot should respond

Ask why the user is on this screen and what they need before the next action.
Decide what must stay exact in place, what is useful to skim, and what can wait
until a detail view. A transaction list helps someone identify a charge; the
receipt review helps them compare the original with the extracted value before
confirming. The signed charge and the amount being confirmed need their full
precision. A chart tick or an overview that communicates scale may only need
an approximation, with a nearby path to the exact value. Give a repeated task
more weight than a theoretical reduction in taps or pixels.

Compare treatments on the same normal and difficult content. These are options,
not an order of operations or a complete list:

- **Reflow a group or change the layout.** Give required content its own line
  before it competes with controls or padding. Try stacking, giving one field
  more room, or moving supporting fields to details. Review padding and gaps at
  the actual narrow width: reduce wasted space without shrinking tap targets or
  crowding distinct groups. A page can fit and still be hard to use. Inspect
  single-character columns, awkward orphaned words or digits, detached signs
  or units, and wraps that make a label look attached to the wrong value.
- **Shorten what people scan.** An end ellipsis can work for a secondary label;
  preserve the suffix or extension when similar names differ there. If two
  rows still look the same, show a safe distinguishing cue before opening them.
  Keep exact identity, link destination, and copy behavior. For private rows,
  use information the viewer is already allowed to see; don't fetch the hidden
  content to manufacture a preview or an accessible name.
- **Disclose details on demand.** A short preview or clamped description can
  link to details or offer a labeled expansion. The user should be able to find,
  open and close it with touch or keyboard and keep their place. Hover can be
  an extra affordance. A hover-only tooltip or screen-reader-only full value
  leaves sighted touch and keyboard users without the information.
- **Compact a number when the task permits rounding.** Use the product locale
  and currency with [`Intl.NumberFormat`](https://402.ecma-international.org/13.0/#numberformat-objects)
  (`{ style: 'currency', currency: 'CAD', notation: 'compact' }`). For example,
  `500001.25` can display as `$500K` in `en-CA` and `500 k $` in `fr-CA`.
  Choose precision and a threshold for the surface; test both sides and check
  the sign, unit and exact-value path. If two values round to the same label
  and the difference affects the next decision, keep them exact. Formatting
  changes the presentation; the stored value, arithmetic, copy of an exact
  value, and amount being confirmed keep their precision. Don't make it a
  global amount-component fallback or add `K` by hand.
- **Explain missing or unavailable data.** Provide a fallback where absence is
  valid and keep unavailable, empty, and zero distinct.

Check the result at normal and enlarged text, at the actual narrow container
width, and with the neighboring content that competes for space. Look at the
wrap and spacing as well as the overflow measurement. For a disclosure, also
exercise the path to the full value. Record the choice in terms of the user's
task and the tradeoff; leave unresolved product choices explicit.

Record the slot, concrete fixture and state, expected behavior, observed
effect, and owning source. Say which tested slots held up and which states or
environments weren't exercised. In a source-only review report risks and a
replay plan. Keep authorized fixes and temporary fixture cleanup separate from
the review.

Adapted from Emil Kowalski's
[Break UI skill](https://github.com/emilkowalski/skills/blob/5206a950b715e0cabe7043ea0b2304332b91494e/skills/break-ui/SKILL.md)
and [worst-case catalog](https://github.com/emilkowalski/skills/blob/5206a950b715e0cabe7043ea0b2304332b91494e/skills/break-ui/CATALOG.md)
([MIT notice](sources/emil-design-eng/LICENSE)).
