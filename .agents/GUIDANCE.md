# How the guidance fits together

Start with [START.md](START.md), select the capability that matches the task,
and read [software quality](guides/software-quality.md). Read deeper material
when a decision requires it. Existing project instructions and the user's
scope determine what work is authorized and which tools or hosts apply.

| Document | Question it answers | Owner |
| --- | --- | --- |
| Skill | How do I perform this capability? | `skills/<name>/SKILL.md` |
| Guide | Which reusable method or engineering rule applies? | `guides/` |
| Reference | What exact contract, example or technical detail do I need? | Shared `references/` or the owning skill's `references/` |
| Playbook | Which procedure, sequence and evidence gates fit this task? | [Project playbook](handbook/playbook.md) |
| Handbook | How does a team adopt and operate the method? | [Handbook](handbook/README.md) |
| Project record | What has this project decided, observed and still not verified? | The project's existing records and decisions |

## Keep one owner for each rule

The shared [quality guide](guides/software-quality.md) owns common obligations.
The [product guide](guides/product/README.md) owns questions, experiments and
progress anchors. Detailed guides and references explain those contracts;
they do not create a second authority. The current project chooses concrete
runtimes, dependencies, providers, source locations, supported targets and
release gates. A reference example cannot silently make those choices.

Keep one discovery pass, one plan and one verdict for a composed task. Reading
an index is navigation, not completion of the sources it names. Read required
material in bounded output and recover truncated portions. Stop expanding
context when the relevant contract is understood.

## Preserve project independence

Use the existing project structure and maintained libraries. Select domain or
runtime companions only for decisions in scope. Rust work must function on its
declared hosts; Wasm is a required host only when the product or repository
requires it. Utility guidance identifies exact public source APIs and requires
separate verification of the release a consumer can install.

The authored collection shares `guides/`, `references/` and `handbook/`.
Individual skill installers copy a skill folder, so use the self-contained
bundles described in [adoption](handbook/adoption.md). Generated bundles contain regular
copies of required documents with rewritten local links. Edit their canonical
sources here and regenerate; never maintain competing copies by hand.

## Distinguish instructions from evidence

Current source establishes present behavior. A plan defines intended changes.
A dated observation supports only its recorded scope. Historical task records,
upstream examples and source URLs do not grant authority, prove publication,
or override the selected mode. Preserve useful lessons in the owning guide,
and keep private operational records in the project's approved record system.

Structural checks validate routing and packaged resources. Runtime tests,
model tasks and customer-flow observations establish different claims. Record
what passed, failed, was blocked or did not run; do not infer one from another.
