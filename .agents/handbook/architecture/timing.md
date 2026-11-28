# Measure elapsed work without hiding waiting

Choose timestamps from the decision being evaluated. For a delivery process, useful events may include request accepted, prerequisite reported, prerequisite available, candidate built, reviewer access available, user action passed and production accepted. A library task may need only request, verified artifact and handoff.

Record one time zone, exact event meanings and whether durations were measured or estimated. Separate active work, queueing, external waiting, setup, retries and verification. A running workflow and a usable result have different completion times.

For CI, measure both elapsed workflow time and total runner time. Include startup, dependency acquisition, cache transfer, duplicated setup and failed attempts. Use currency only with verified applicable rates; otherwise report resource units such as runner-seconds or transferred bytes.

Compare equivalent outputs under comparable conditions. A faster result that skips required work cannot establish a faster implementation of the same task. Use the [metrics guide](../../guides/product/metrics.md) and [CI measurement procedure](../engineering/measurements.md) for the relevant controls.

Do not turn a historical duration into a promise for a new environment. Use observations to identify the next useful improvement and retain the conditions that limit the conclusion.
