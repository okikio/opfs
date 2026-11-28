# Organize work around ownership and use

Choose a design that lets the intended user complete the task and lets maintainers locate the contract that controls it. Inspect existing capabilities before adding another owner.

Skills: `plan-changes`, `refactor-code`, `build-libraries`.

| Decision | Read |
| --- | --- |
| Who maintains the artifact, and where does it execute? | [Ownership and placement](ownership.md) |
| Which existing capability can supply the behavior? | [Reuse](reuse.md) |
| Where should a maintained file or command live? | [Files and task interfaces](files.md) |
| What identity is reviewed, built and released? | [Candidates](candidates.md) |
| Where does elapsed time go? | [Timing](timing.md) |
| Which automation should be added next? | [Evolution](evolution.md) |

Use the detailed [library architecture guide](../../guides/library-first-architecture-guidebook.md) for reusable API and composition decisions. Preserve the target repository's actual layout; directory names in an example do not establish ownership.
