# Give the team an observation it can act on

An anchor connects evidence to a product decision. It lets a teammate answer:
what did we learn, why does it matter, what can we decide now, and what still
needs an answer? It should be understandable without knowing the internal
implementation. Keep the precise technical evidence available behind it.

## Write the update around the answered question

Use this compact shape when it helps:

> **Question:** What customer problem were we trying to understand?
> **Observed:** What happened, under which conditions, and when?
> **Meaning:** What does that establish, and what does it leave open?
> **Decision:** What will we do, stop doing, or investigate next?
> **Evidence:** Where are the reproducible input, configuration, and result?

Say "the direct exporter returned all four variants, while the application
returned two" before naming the configuration assignment responsible. Explain
that this supports checking application wiring before adding another worker.
That gives technical and nontechnical teammates the same basis for action.

Keep implementation activity visible when useful, but do not use it as a
substitute for results. "Added the relay" is work performed. "A request through
the relay returned the expected content under these conditions" is an observed
capability. Neither alone proves that all difficult sites are now reachable.

## State the strength and scope of the evidence

Separate:

- **Reported:** a customer or teammate described the symptom; it has not yet
  been reproduced in the current environment.
- **Documented or source-inspected:** current material describes a capability;
  it has not yet been executed here.
- **Directly observed:** the specified probe produced the saved result.
- **Integrated:** the relevant application path produced the required result.
- **Customer outcome observed:** relevant customer behavior or outcome was
  measured under stated conditions.

These describe different claims, not a universal ladder that every task must
climb. A source-inspected fact can decide a licensing or ownership question.
Actual usability and value require evidence about relevant people and behavior.

Do not round an inconclusive comparison into a win. Explain whether the next
step is to collect a missing measurement, reduce confounding, test a different
question, or accept a reversible decision because the distinction is immaterial.
For a blocker, name the unavailable operation and prerequisite, the attempted
alternatives, and the remaining question. Do not claim an answer to the feature
question merely because setup failed.

## Keep anchors current and reusable

Give important anchors an identifier, observation time, source revision,
environment/configuration, result artifact, and next owner or action. Record
the knowledge change relative to the last update. Revisit an anchor when its
inputs, runtime, provider, workload, or product promise change enough to affect
the decision. Mark an earlier anchor superseded and retain the reason.

Keep raw evidence separate from interpretation so another person can challenge
the conclusion. Redact secrets and follow relevant retention rules without
discarding the useful result. Link an implementation decision or issue back to
the anchor that justified it. A later failed integration should refine the
earlier component anchor's scope, not silently erase it.

Avoid artificial confidence percentages or completion estimates. Give a date
or estimate only when the scope and remaining uncertainty support it. A useful
update can say that a specific option failed and that the team has stopped
investing in it. Momentum comes from a better decision, not a positive tone.
