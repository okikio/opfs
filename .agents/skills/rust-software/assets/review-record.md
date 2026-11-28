# Rust review finding

- Source repository, full head/base revisions and requested review scope:
- Applicable source rules, packages/targets and adjacent consumers inspected:
- Finding priority and whether it is new, pre-existing or a new-policy gap:
- Exact file/symbol/source location:
- Observed behavior or source deduction:
- Customer/resource/correctness consequence:
- Smallest reproduction, input and independent expected result:
- Actual output, toolchain/host/features and raw evidence:
- Proposed correction and invariant it must preserve:
- Regression and connected-host evidence required:
- Remaining uncertainty and checks that were not run:

Keep acknowledged unfinished integration separate from hidden regressions.
Do not infer a whole workspace passes from an extracted module test, or a target
works from source inspection. Review authority does not authorize live fixes.
