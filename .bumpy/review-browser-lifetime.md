---
"@okikio/opfs": patch
---

Persistent browser fixtures now separate native acquisition and retirement from the ordinary test-body budget. Keep
using `deno task test:browser`; assertions, capability oracles, retries and the global suite timeout are unchanged.

For the five Firefox byte, cancellation, isolation and reopen scenarios, run:

```sh
deno task test:browser --project=firefox tests/browser/opfs.spec.ts --retries=0
```

A retained Firefox trace showed the first functional evaluation starting only about 100ms before the test's shared
30-second deadline. Browser launch, page creation, navigation and fixture readiness had already consumed that budget;
the timeout then closed the page. A later test failed during browser acquisition before running library behavior. This
was not evidence that the round-trip operation itself waited 30 seconds.

Each persistent context now launches with a native deadline of at most 30 seconds, shortened when its acquired owner has
less time left. Separate 90-second fixture setup/teardown retains native retirement time. The native acquisition settles
through Playwright's cancellation mechanism; the fixture does not leave a `Promise.race()` loser running after it times
out. Context close is registered immediately and returns one settling promise; profile removal follows context release
in reverse ownership order.

```mermaid
flowchart LR
  profile[Acquire disposable profile] --> launch[Launch within remaining owner budget]
  launch --> own[Register context release]
  own --> behavior[Run behavioral assertions]
  behavior --> close[Await native context close]
  close --> remove[Remove owned profile]
```

The same-profile reopen case retains its authored write, native close, reopen and independently observed read. Its
explicit 180-second scenario budget accounts for two acquisitions and closes. Its 30-second scenario reserve plus the
acquisition owner's additional 30-second retirement reserve leave at least 60 seconds before the scenario deadline at
acquisition dispatch. The second launch checks that remaining lifetime before dispatch. It still caps each native launch
at 30 seconds. Profiles now use the same disposable owner rather than leaving cache/profile trees in report output.
These are finite operational budgets, not new performance claims or a guarantee that an unresponsive OS call can be
interrupted. Actual supported browser failures remain gate failures.
