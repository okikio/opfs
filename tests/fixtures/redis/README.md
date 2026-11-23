# Native Redis and Valkey comparison

Run `deno task test:redis-provider` with Docker. Testcontainers builds the native hiredis recipe from signed Debian
packages, then starts the pinned server and native client on a private network. The C shim fixes credentials, database
and operation names; hiredis owns protocol framing and reply parsing. Binary keys include empty keys and NUL bytes, so
`%b` carries explicit lengths rather than C string termination. Inputs are capped at 1 KiB keys and 1 MiB values.

The client authenticates, selects database 3 and checks SET/GET/PTTL receipts. Every reply and connection is released.
Socket and command deadlines bound failures; fixture scopes own the containers and network. A Docker build writes
package, repository, source and binary receipts under `/oracle/receipts`.

The exact old Python SDK fixture is `provider.ts.snapshot`; `source-map.json` records its identity. It is inert
historical evidence. The new native recipe needs its own successful provider run before it is runtime-qualified. Its
build uses a native test dependency, not a production package dependency.

The [hiredis public API](https://github.com/redis/hiredis#synchronous-api) defines binary-safe `%b`, reply types,
timeout setup and reply/connection ownership.
