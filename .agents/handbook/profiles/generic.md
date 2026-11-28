# Generic project profile

Use the current project's language, runtime, layout, task runner and dependencies. Start with the intended user or caller action, inspect the actual source and choose the smallest useful step. The method applies to applications, libraries, command-line tools, internal workflows and research tasks.

Bind only the fields the task needs:

| Contract | Establish from current evidence |
| --- | --- |
| Outcome | Reader or customer, useful action, problem and decision. |
| Source | Repository or source set, branch and revision, applicable instructions, local changes and owned scope. |
| Runtime | Installed versions, supported hosts, native commands and required public APIs. |
| Dependencies | Existing capabilities, public exports, resolved versions, publication status and access constraints. |
| Investigation | Consequential unknown, relevant probe, controls, allowed effects, evidence and cleanup. |
| Delivery | Requested artifact or journey, meaningful checks, publication or deployment only when required. |
| Ownership | Decision owner, implementation owners, reviewer and unresolved prerequisites. |

An existing architecture is a starting point to inspect. Change it when the requested work or a demonstrated limitation justifies the cost. Keep examples conditional: a Python project retains its Python contract, a native Rust tool retains its declared hosts, and a library need not acquire a web preview or cloud stack.

Require truthful support claims. If a project promises browser or Wasm behavior, verify the required operation there. If it does not, assess portability as a design choice rather than silently adding a new delivery gate.

Use early experiments when they can change a decision. Scale records and checks to risk and uncertainty. A working cadence can be chosen locally; elapsed time alone does not establish evidence quality.
