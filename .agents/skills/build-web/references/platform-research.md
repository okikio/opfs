# Resolve a web-platform question

Use this reference for an unresolved HTML, CSS, DOM, browser security or capability
question. Start with the actual feature, installed host and browser support target.
Search primary platform documentation for that one capability, inspect compatibility
and failure behavior, and test the affected browser path. A broad UI task is not
permission to install a search CLI or fetch every guide.

Prefer native controls and progressive enhancement where they satisfy keyboard,
focus, validation and accessibility requirements. Choose a fallback from the
project's actual support policy; report an absent policy rather than inventing one.
Verify newly available behavior using feature detection and real target browsers.
Record sources only when they affect a decision, and distinguish source claims
from observed behavior. Do not introduce a second browser-policy authority.

Useful primary owners: [MDN](https://developer.mozilla.org/),
[WHATWG HTML](https://html.spec.whatwg.org/), and
[web.dev Baseline](https://web.dev/baseline).
The previous modern-web-guidance snapshot and its mandatory latest-CLI recipes
are retained in Git, not as active execution instructions.
