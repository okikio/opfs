# Improve engineering work without losing required behavior

Trace the required work before optimizing how it runs. A shorter workflow is useful when it preserves the same correctness, supported consumers and release obligations.

Skills: `test-code`, `benchmark-code`, `deno-software`, `build-devtools`, `rust-software`.

| Decision | Read |
| --- | --- |
| What source, owners and work are affected? | [Source and ownership](source.md) |
| Can existing tooling supply the mechanism? | [Native capabilities](native-tools.md) |
| What must run, and what result can be reused? | [Selection and caching](selection-cache.md) |
| Which tests are meaningful and independently runnable? | [Tests](tests.md) |
| Does the change improve comparable work? | [Measurements](measurements.md) |
| What evidence is needed for review and resumption? | [Handoff](handoff.md) |

Select runtime skills from the code's actual execution contract. Deno, Python, Rust, browser and other hosts keep their own tooling and supported environments. A documentation example does not authorize a toolchain migration.
