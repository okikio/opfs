# Research behind the method

These primary sources explain the established practices behind the method.
Check the current source when its details affect a decision. Repository source and local experiments still
control claims about a specific implementation. The term “anchor” names this collection's record of an observation and next
decision; it does not claim a new scientific method.

| Primary source | Relevant contribution | Limit |
| --- | --- | --- |
| Teresa Torres, [Assumption Testing](https://www.producttalk.org/assumption-testing/) | Break a proposed solution into assumptions; find a small test that changes a decision; compare alternatives | An assumption test supplies evidence for its scope, not certainty about the whole product |
| Marty Cagan, [Build to Learn FAQ](https://www.svpg.com/build-to-learn-faq/) | Product discovery centers on outcomes and value, usability, feasibility, and viability risks | Product opinion and practice guidance; not experimental proof of this pack's effectiveness |
| GOV.UK Service Manual, [How the alpha phase works](https://www.gov.uk/service-manual/agile-delivery/how-the-alpha-phase-works) | Test risky assumptions with a minimal prototype; concentrate on difficult parts | Public-service delivery context; its complete process is not imposed on every repository |
| NIST, [One factor at a time](https://www.itl.nist.gov/div898/handbook/pri/section2/pri212.htm) | Changing factors individually can miss interactions | Experiment structure still depends on the question, cost, and feasible controls |
| Strategyzer, [Test Card](https://www.strategyzer.com/library/validate-your-ideas-with-the-test-card) | State an assumption, test, measure, and criterion before interpreting the result | A filled card is not evidence; exploratory probes may refine later criteria |
| Strategyzer, [Learning Card](https://www.strategyzer.com/library/capture-customer-insights-and-actions-with-the-learning-card) | Separate observation, learning, and resulting action | A plausible interpretation still needs scrutiny and scope |
| Google SRE, [Monitoring Distributed Systems](https://sre.google/sre-book/monitoring-distributed-systems/) | Relate latency, traffic, errors, and saturation to service behavior | Operational telemetry alone does not establish customer value or durable completion |
| Marty Cagan, [Discovery Judgement](https://www.svpg.com/discovery-judgement/) | Match discovery effort to risk and consequence | Professional judgment remains necessary; no universal experiment quota |

## Source and local policy have different roles

A source provides a documented claim or an implementation to inspect. Local
experiments establish behavior for recorded inputs, versions and conditions.
A project's operating rules choose its cadence, permissions, supported hosts
and delivery gates. None of the sources above establishes a universal time
ratio, mandatory provider, toolchain or deployment architecture.

For the optional utility ecosystem, start with
[`okikio/utils`](https://github.com/okikio/utils) and
[use-utils](../../skills/use-utils/SKILL.md). Verify the resolved package source,
public exports, installed artifact and consumer behavior. A source manifest's
version is not proof that a matching registry release exists.
