# Verify the connected user action

Use these branches only when the agreed journey includes the capability. Trace all owners that must be active for the user's action to work.

| Capability | Contract to trace | Acceptance evidence |
| --- | --- | --- |
| First administrator or staff access | Account owner, supported setup route, session and required consent. | The intended person can use the actual sign-in or setup path; unavailable interaction is reported. |
| External identity provider | Registered client, credential pair, callback origins, feature settings, account policy and stored identities. | Allowed and rejected identities, account linking, repeated callbacks and existing access behave as specified. |
| Cross-repository activation | Each source change, setting, content publication, artifact and runtime route. | Code, configuration, published content, deployed build and final fetch are checked separately. |
| Content migration or tools | Approved sources, destination schema, stable mappings, write scope and actual client. | Validation, conflict handling and read-back preserve required content, including intentional incompleteness. |
| Browser presentation | Anonymous or signed-in route, supported viewports, input methods, assets and error states. | Built page, keyboard and form behavior, retries, asset bytes and relevant locale/time behavior work. |

A disabled signup or provider setting does not by itself establish the status of existing sessions. A public read tool does not prove private editing, authentication consent or another host's integration. Trace the current contract before making either claim.

Record implemented, published, activated and accepted states with their evidence. Assign an owner and reversal or recovery action for each activation step. A later requested capability receives its own acceptance contract without rewriting the earlier result.
