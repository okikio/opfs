# Follow one question through a user journey

Consider a fictional application whose users report incomplete exports. The useful result is a file containing the requested records, with an understandable error when the export cannot complete.

First trace the reported action: the user chooses a filter, requests an export and downloads the result. Identify the code that interprets the filter, the operation that produces the file and the component that retrieves it. Keep the report separate from behavior reproduced in the current environment.

The next decision may be whether the data operation loses records or the application sends an incomplete request. Call the existing export operation with a small fixture whose expected records are known independently. Retain the input, configuration, result and any failed attempt. Then exercise the application with the same case.

If the direct operation is correct and the application is incomplete, inspect the request construction before adding a new worker. If both are incomplete, investigate the shared owner. If setup fails, retain that limitation and leave the export question open. None of these outcomes requires a positive result to produce useful knowledge.

Record an anchor with the observation, its scope, the source and conditions, what the team can decide and the remaining question. Build the implementation plan from the verified owner and its affected consumers. Include the failure behavior, cleanup and acceptance case.

After the change, run the focused regression and repeat the user's export action. Inspect the generated file. State which inputs and environments were checked; do not infer every export is correct from one fixture. The [acceptance record](../project/acceptance.md) connects this final evidence to the original problem.
