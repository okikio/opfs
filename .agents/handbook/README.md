# Engineering handbook

Use this handbook to connect a requested outcome to the people, code, evidence and operating steps that can deliver it. Start with the [first useful action](start/first-value.md), then follow the [playbook](playbook.md) for the task. A library change, a command-line tool and a deployed application can use the same method with different acceptance evidence.

The [generic profile](profiles/generic.md) is the default. Bind the guidance to the repository's existing runtime, commands, dependencies and supported hosts. A project can select additional constraints through its own instructions and [project profile](profiles/project.md).

## Know which document answers the question

| Document | What it owns | Entry |
| --- | --- | --- |
| Skill | How to perform a capability, with the technical resources needed for its decisions. | [Capability router](../START.md) |
| Guide | A shared method or engineering rule that applies across capabilities. | [Software quality](../guides/software-quality.md), [product method](../guides/product/README.md) |
| Reference | Detailed contracts, examples and sources for one technical question. | The selected skill's resource links |
| Playbook | The sequence of procedures, decisions and evidence gates for a task. | [Task flow](playbook.md) |
| Handbook | Explanations, operating practices and templates that make the playbook usable. | This folder |
| Project instructions and decisions | The actual tools, owners, supported environments, requirements and accepted tradeoffs. | The target repository's instructions and decision records |

Use current user requirements and repository instructions to determine scope. Verify implementation claims against the actual source and consumers. A proposed procedure describes what a project must bind and exercise; it does not establish that the project already has those commands or automation.

## Find the part needed for the next decision

| Need | Read |
| --- | --- |
| Begin a task and define useful completion | [Start](start/README.md) |
| Connect questions, probes and decisions | [Product work](product/README.md) |
| Adopt the collection or bind project choices | [Adoption](adoption.md), [profiles](profiles/README.md) |
| Choose ownership, reuse, files and deployment placement | [Architecture](architecture/README.md) |
| Open a project, verify services, deliver or recover a candidate | [Procedures](procedures/README.md) |
| Check a service from its real consumer | [Service contracts](services/README.md) |
| Record a project, test, candidate or incident | [Project templates](project/README.md) |
| Preserve intent through parallel work and interruption | [Agent work](agents/README.md) |
| Change tests, builds or CI without losing required work | [Engineering](engineering/README.md) |
| Deliver Rust on the hosts the project supports | [Rust](rust/README.md) |
| Start a focused engineering task | [Task prompts](tasks/README.md) |
| Diagnose a failure and retain its lesson | [Failures](failures/README.md) |

Read the selected route and the details it needs. A small change can use a short task record. Deployment, credentials, cloud services, model providers and a new tracking system are required only when the agreed outcome needs them.
