# Verify the package the consumer will install

Identify the actual package, tool or generated dependency and the public entrypoint the consumer needs. Compare source availability, published availability and installed behavior separately.

| Check | Evidence |
| --- | --- |
| Public contract | Export map, executable entrypoint, required feature and supported runtime. |
| Resolution | Exact source or release, registry, lockfile and integrity information. |
| Consumer access | The intended local, CI or deployed identity can fetch the required artifact. |
| Generation | Real specification, generator, platform and produced output when generation is required. |
| Installed operation | A consumer executes the installed files rather than reaching into the checkout. |
| Lifecycle | Startup, errors, signal handling, permissions, writable paths and cleanup where relevant. |

A source repository can contain an export that has not been published. A placeholder package with a matching name does not supply that API. Verify the exact release and real consumer before writing an installation recipe.

Keep action, binary, compiler, checker and runtime versions distinct when a toolchain uses several components. Shared tooling is a versioned interface; inspect the complete compatible invocation and output contract.

For unavailable generated dependencies, report the exact native job or publication needed and the resulting consumer check. Do not invent generated code, rewrite a lock to hide the failure or infer CI access from an operator's local credentials.
