# Run the smallest experiment that can change the decision

Read the [core method](README.md) first. Experiment design starts with the
customer question and a possible decision, not with a new harness. Research
suggests what to try. Execution checks what actually happens in the relevant
environment. Repeat this loop while the observations can change the decision.

## Write the probe before constructing infrastructure

State the question, current expectation, alternative explanations, and smallest
observable difference. Identify the existing command or public API, exact
version and configuration, representative input, independent expected result,
and evidence location. Decide what each plausible result would mean. Set a
proportionate time limit or stopping condition before a potentially long run.

Start at the first sufficient option:

1. Existing executable, example, public operation, or customer task.
2. One small fixture or script around that operation.
3. A controlled scenario with the few real dependencies needed for the question.
4. The application or deployed flow when the claim depends on integration.

This is a choice of scope, not a mandatory sequence. A queue failure needs the
relevant queue behavior. A browser option may need only a direct browser run.
An end-to-end authorization question cannot be settled by a mock identity.
Explain any added scaffolding by the observation it enables. Stop building it
when the question can be answered. Preserve a successful small reproduction so
the next person can rerun it without the full product stack.

Check current command help and exported APIs. Do not create a plausible-looking
command from memory. Keep disposable probes outside production ownership until
their behavior and reuse justify adoption. A probe need not become a permanent
test. Keep a regression test when it protects a real contract the change owns.

## Make observations interpretable

Begin with a known baseline and a small correctness oracle independent of the
implementation. For an export, compare exact source and output identifiers and
fields. For retrieval, inspect the returned content, not just status or exit
code. Preserve the unmodified observation before extracting a summary.

Change one factor when doing so isolates a useful distinction. Test relevant
combinations when effects can interact. One-factor-at-a-time diagnosis can miss
an option that works only in combination. A small factorial matrix may be more
informative than many unrelated probes. Use balanced or randomized order,
fresh sessions, repeat runs, or paired inputs when state, caching, drift, or
rotation could confound the comparison. Choose these controls for a concrete
risk, not as a ritual for every smoke test.

Record all attempts and conditions. Do not omit timeouts, crashes, empty
responses, or unsuccessful configurations from denominators. Keep configuration
and version identifiers, timestamps, stdout/stderr or equivalent observations,
status, relevant metadata, and the limits of each measurement. Retain response
bodies when they are relevant, including useful information in 404 or 500
responses. An error status describes transport/application behavior; it does
not justify silently discarding the body or its metadata. Apply the project's
data retention and secret-handling rules to captured evidence.

When a test fails, distinguish setup failure, transport failure, invalid output,
incorrect output, resource exhaustion, and an unsupported capability. A harness
bug is evidence about the harness. Correct it and retain the earlier attempt as
invalid for the original claim. Do not rewrite failed evidence to look successful.

## Browser and rotating-proxy example

For an authorized retrieval task, ask whether reachability or delay changes
with the network route, the browser configuration, or their interaction. Verify
the provider's current terminology and route behavior first. "Residential" and
"backconnect" may describe different attributes, so do not assume they are
mutually exclusive product categories.

A compact exploratory matrix can compare the direct route and the available
provider routes with the stock configuration, then selected configuration
changes and their combinations. Use an unchanged target set and a known working
control. Inspect actual returned content. Capture connection and page stages
where observable, exit address or a privacy-appropriate identifier, address
family, session identity, browser build, configuration, and error details.

If testing timezone, language, locale, or geolocation consistency, record what
was configured and what the browser and network actually exposed. Approximate
IP location can be wrong. A browser locale does not identify an entire browser
fingerprint. Do not treat changed settings as proof of what a remote system
observed or why it accepted or rejected a request.

Rotation can change the exit address between requests or subresources. Where
the provider supports it, a stable session or sticky route makes a comparison
more interpretable. Otherwise record rotation and narrow the conclusion. A
configuration that appears faster on a different address is not isolated
evidence of a browser-setting effect. Compare factors and interactions before
attributing a cause. This is a proposed experiment design, not a claim that a
particular proxy or browser configuration works.

## Decide what the result permits

| Result | What to do |
| --- | --- |
| Required behavior observed | Preserve the narrow feasibility anchor; test the next relevant integration or reliability question |
| Expected effect absent | Record the tested conditions and alternative explanation; rule out only what the evidence can exclude |
| Unexpected behavior | Retain it, check the measurement, and revise the question if it changes the product decision |
| Inconclusive comparison | Name the missing distinction; improve the probe or decide that the difference is immaterial |
| Setup blocked | State the exact unavailable prerequisite and smaller valid alternative; leave the intended question open |
| Sufficient evidence for a reversible decision | Decide and proceed; retain a trigger to revisit the assumption |

Define exploratory and confirmatory claims separately. A quick run can reveal
an available capability or a deterministic defect. Estimates of speed,
reliability, or resource capacity need representative work, repeated observations,
and uncertainty appropriate to the stakes. Do not repeatedly sample until a
preferred winner appears. If an exploratory finding suggests a winner, use a
fresh comparison or explicitly label the evidence as exploratory.

Stop when further information is unlikely to change the named decision enough
to justify its cost. Leave expensive unknowns explicit with an owner and revisit
condition. Do not optimize experiment count, research hours, or documentation
volume. Optimize the useful decisions the evidence supports.

## Keep the loop visible

Track research and active experimentation as the work proceeds, using the
research and experiment loop in the [core method](README.md). After each useful result,
write a short [anchor](anchors.md), choose the next question, and update the
plan. For a blocked experiment, report the last actual observation, the blocked
operation, and the next attempt that could resolve it. Avoid a long impasse
described only as implementation progress.
