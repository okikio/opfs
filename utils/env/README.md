`@utils/env`
============

Purpose
-------

`@utils/env` separates environment definitions from environment sources. A
definition owns validation, documentation, and secret classification. A source
owns the raw strings available to one host.

How it fits
-----------

Concrete packages define the environment fields they need. An executable host
selects raw sources and parses those definitions during startup. Importing a
definition never reads ambient process state.

`@utils/env` keeps two related responsibilities separate:

1. an **environment definition** describes, validates, documents, and classifies values;
2. an **environment source** supplies the raw strings available to one host.

They meet only when a host parses a definition:

```ts
import * as env from '@utils/env/zod';
import { z } from 'zod';

const ServiceEnvironment = env.define({
	PORT: z.coerce.number().int().positive().default(8787).meta({
		title: 'HTTP port',
		description: 'Port used by the service listener.',
		examples: ['8787'],
	}),
	DATABASE_URL: env.secret(
		z.string().min(1).describe('PostgreSQL connection string.'),
	),
});

const values = ServiceEnvironment.parseSync(
	env.merge(env.env, { PORT: '4321' }),
);
```

The definition is import-safe. Creating it does not read ambient state, connect to a
provider, or configure a process. The service entrypoint owns the source and decides
when startup validation occurs.

Public vocabulary
-----------------

Import the package as a namespace so the verbs stay short without becoming ambiguous:

```text
env.define(...)       create a definition
env.environment(...)  equivalent concise authoring form
env.compose(...)      combine definitions through canonical field identity

env.env               lazy Deno/Node ambient source
env.record(...)       capture deterministic raw values
env.merge(...)        combine sparse sources by precedence
env.select(...)       read a bounded raw record without defining schemas

env.variable(...)     classify an ordinary host variable
env.secret(...)       classify protected secret material

env.manifest(...)     project deployment metadata
env.example(...)      generate a safe .env.example
env.requirement(...)  explain why a resource selects canonical fields
```

`compose` combines definitions. `merge` combines sources. The different verbs make
the two halves visible at the call site.

Choose an authoring entrypoint
------------------------------

### Zod

```ts
import * as env from '@utils/env/zod';
```

Bare Zod schemas become ordinary variables. The adapter reads metadata through Zod
4's public `.meta()` and `.describe()` APIs:

```ts
const ServiceEnvironment = env.define({
	LOG_LEVEL: z.enum(['debug', 'info', 'warning', 'error']).default('info').meta({
		title: 'Log level',
		description: 'Minimum diagnostic severity emitted by the service.',
		examples: ['info'],
	}),
});
```

Secret classification remains explicit because secrecy is a deployment rule, not a validation property:

```ts
const ServiceEnvironment = env.define({
	API_TOKEN: env.secret(
		z.string().min(1).describe('Token used to call the provider API.'),
	),
});
```

### Valibot

```ts
import * as env from '@utils/env/valibot';
import * as v from 'valibot';

const Port = v.pipe(
	v.string(),
	v.title('HTTP port'),
	v.description('Port used by the service listener.'),
	v.examples(['8787']),
);

const ServiceEnvironment = env.define({ PORT: Port });
```

The adapter uses Valibot's public `getTitle`, `getDescription`, `getMetadata`, and
`getExamples` functions. The original Valibot schema remains the runtime validator and
the source of inferred output types.

### Generic Standard Schema

```ts
import * as env from '@utils/env/standard';
```

Standard Schema defines validation interoperability but does not define a shared
metadata protocol. Generic callers therefore provide environment metadata explicitly:

```ts
const ServiceEnvironment = env.define({
	PORT: env.variable(PortSchema, {
		description: 'Port used by the service listener.',
		example: '8787',
	}),
});
```

The generic entrypoint never inspects private Zod or Valibot properties.

Metadata ownership and precedence
---------------------------------

Schema metadata should describe the value itself:

```text
title
description
examples
deprecated
```

Environment metadata describes the deployment binding:

```text
variable or secret classification
documentation URL
deployment availability
replacement key
```

Explicit metadata passed to `env.variable()` or `env.secret()` overrides schema
metadata. This lets one reusable schema carry a general description while a service
gives the binding a more specific operational meaning.

Secrets never project examples, including examples attached to the schema.

Source-only usage
-----------------

Not every value needs an environment definition. A deployment adapter may need only a few opaque strings:

```ts
import * as env from '@utils/env';

const values = env.select(
	env.merge(env.env, deploymentOverrides),
	['BUNNY_API_KEY', 'BUNNY_RELEASE_ID'],
);
```

This path has no Zod or Valibot dependency.

Canonical field identity
------------------------

Composition permits the same field object to arrive through several imported definitions:

```ts
export const DatabaseUrl = env.secret(
	z.string().min(1).describe('PostgreSQL connection string.'),
);

export const DatabaseEnvironment = env.define({ DATABASE_URL: DatabaseUrl });
export const WorkerEnvironment = env.define({ DATABASE_URL: DatabaseUrl });

const HostEnvironment = env.compose(DatabaseEnvironment, WorkerEnvironment);
```

Independently declaring another field under `DATABASE_URL` is rejected. Silently
choosing one declaration would lose validation or deployment metadata.

Bare Zod and Valibot schemas are canonicalized by schema-object identity, so reusing
the same schema object in several definitions composes safely.

Runtime behavior
----------------

- `env.env` is lazy and performs no read during import.
- Deno reads remain per-key so hosts can grant narrow environment permissions.
- Node access uses `process.getBuiltinModule('node:process')`, avoiding static
  `node:` imports in browser-compatible graphs.
- `env.record()` snapshots values through `Map`, so prototype-shaped external keys remain ordinary data.
- `env.merge()` is sparse: `undefined` falls through to a lower-precedence source.
- Definitions collect all schema issues before throwing `EnvironmentError`; its message lists each field while `.issues` preserves structured failures.
- `parseSync()` rejects schemas that validate asynchronously and directs callers to `parse()`.

Progressive usage
-----------------

The package participates in the complete domain-enrichment example in
`docs/implementation/utils-progressive-usage.md`.  Read that guide when the
individual helpers make sense in isolation but their place in a service,
resource graph, runtime host, or workflow is not yet clear.

`API.md` is the exhaustive public-surface map for this package.  It lists every
package export target, explains each exported name, gives a compact use form,
and expands every detected repository use into a source-backed TypeScript
snippet.  An export with no current consumer stays labelled as unproven instead
of receiving an invented production example.

