@utils/http public API usage
============================

Purpose
-------

This reference maps every public export target declared by `@utils/http` to its role and to a concrete repository use when one exists.

The package README teaches the programming model progressively.  This file is the exhaustive lookup surface for developers who already know the model.

@utils/http
-----------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `cookie` | namespace | Framework-neutral HTTP protocol utilities. | `cookie.…` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `problem` | namespace | Public contract documented by the source declaration. | `problem.…` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `request` | namespace | Public contract documented by the source declaration. | `request.…` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `response` | namespace | Public contract documented by the source declaration. | `response.…` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |

@utils/http/cookie
------------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `catalog` | export | Public contract documented by the source declaration. | `catalog` | `.agents/tests/public-api-matrix.test.ts:296` uses `catalog`. |
| `compose` | function | Compose cookie definitions, catalogs, selections, and nested arrays. | `compose(...)` | `.agents/tests/public-api-matrix.test.ts:298` uses `compose`. |
| `CookieAttributes` | interface | Static attributes applied whenever a cookie is written. | `value: CookieAttributes` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `cookieCatalog` | function | Create a named immutable cookie catalog. | `cookieCatalog(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CookieDefinition` | interface | Import-safe definition of one stable application cookie. | `value: CookieDefinition` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CookieDefinitionInput` | interface | Input accepted by `cookie.define()`. | `value: CookieDefinitionInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CookieDocument` | interface | JSON-safe cookie definition projection. | `value: CookieDocument` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CookieReadResult` | type | Non-throwing cookie read result. | `value: CookieReadResult` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CookieSameSite` | type | Browser SameSite policy for an application cookie. | `value: CookieSameSite` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CookieValue` | type | Output inferred from a cookie definition's Standard Schema. | `value: CookieValue` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `define` | function | Define one import-safe application cookie contract. | `define(...)` | `.agents/tests/public-api-matrix.test.ts:289` uses `define`. |
| `delete` | export | Public contract documented by the source declaration. | `delete` | `.agents/tests/public-api-matrix.test.ts:304` uses `delete`. |
| `document` | function | Create deterministic JSON-safe cookie documentation. | `document(...)` | `.agents/tests/public-api-matrix.test.ts:299` uses `document`. |
| `get` | function | Parse one cookie and throw a TypeError when its value is invalid. | `get(...)` | `.agents/tests/public-api-matrix.test.ts:301` uses `get`. |
| `safeGet` | function | Parse one cookie from a Request or Headers object. | `safeGet(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `select` | function | Select an immutable key-preserving cookie subset. | `select(...)` | `.agents/tests/public-api-matrix.test.ts:297` uses `select`. |
| `set` | function | Append one Set-Cookie field without overwriting other cookie writes. | `set(...)` | `.agents/tests/public-api-matrix.test.ts:303` uses `set`. |
| `SetCookieOptions` | interface | Optional per-occurrence attributes applied while setting a cookie. | `value: SetCookieOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |

Detected uses
~~~~~~~~~~~~~

`define` appears in `.agents/tests/public-api-matrix.test.ts:289`:

~~~~ typescript
const Cookie = cookie.define({
				id: `matrix.cookie-${index}`,
				description: 'Matrix cookie.',
				name: `matrix_${index}`,
~~~~

`select` appears in `.agents/tests/public-api-matrix.test.ts:297`:

~~~~ typescript
assert.equal(cookie.select(cookies, ['Cookie']).Cookie, Cookie);
			assert.equal(cookie.compose(Cookie, cookie.select(cookies, ['Cookie'])).length, 1);
			assert.equal(cookie.document(cookies).length, 1);
			const requestHeaders = new Headers({ Cookie: `${Cookie.name}=value` });
~~~~

`compose` appears in `.agents/tests/public-api-matrix.test.ts:298`:

~~~~ typescript
assert.equal(cookie.compose(Cookie, cookie.select(cookies, ['Cookie'])).length, 1);
			assert.equal(cookie.document(cookies).length, 1);
			const requestHeaders = new Headers({ Cookie: `${Cookie.name}=value` });
			assert.equal(await cookie.get(requestHeaders, Cookie), 'value');
~~~~

`get` appears in `.agents/tests/public-api-matrix.test.ts:301`:

~~~~ typescript
assert.equal(await cookie.get(requestHeaders, Cookie), 'value');
			const headers = new Headers();
			cookie.set(headers, Cookie, 'value');
			cookie.delete(headers, Cookie);
~~~~

`set` appears in `.agents/tests/public-api-matrix.test.ts:303`:

~~~~ typescript
cookie.set(headers, Cookie, 'value');
			cookie.delete(headers, Cookie);
			assert.ok(headers.get('set-cookie'));
			assert.throws(() => cookie.set(new Headers(), Cookie, 'x', { maxAge: -1 }), TypeError);
~~~~

`document` appears in `.agents/tests/public-api-matrix.test.ts:299`:

~~~~ typescript
assert.equal(cookie.document(cookies).length, 1);
			const requestHeaders = new Headers({ Cookie: `${Cookie.name}=value` });
			assert.equal(await cookie.get(requestHeaders, Cookie), 'value');
			const headers = new Headers();
~~~~

`catalog` appears in `.agents/tests/public-api-matrix.test.ts:296`:

~~~~ typescript
const cookies = cookie.catalog(`matrix.cookies.${index}`, { Cookie });
			assert.equal(cookie.select(cookies, ['Cookie']).Cookie, Cookie);
			assert.equal(cookie.compose(Cookie, cookie.select(cookies, ['Cookie'])).length, 1);
			assert.equal(cookie.document(cookies).length, 1);
~~~~

`delete` appears in `.agents/tests/public-api-matrix.test.ts:304`:

~~~~ typescript
cookie.delete(headers, Cookie);
			assert.ok(headers.get('set-cookie'));
			assert.throws(() => cookie.set(new Headers(), Cookie, 'x', { maxAge: -1 }), TypeError);
~~~~

@utils/http/problem
-------------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `catalog` | export | Public contract documented by the source declaration. | `catalog` | `services/observations/domain/problems.ts:4` uses `catalog`. |
| `causeOf` | function | Return the internal cause retained by a problem tuple, when present. | `causeOf(...)` | `.agents/tests/public-api-matrix.test.ts:280` uses `causeOf`. |
| `compose` | function | Compose problem definitions, catalogs, selections, and nested arrays. | `compose(...)` | `.agents/tests/public-api-matrix.test.ts:277` uses `compose`. |
| `create` | function | Instantiate one problem occurrence as an RFC 9457 tuple. | `create(...)` | `.agents/support/production-fixture.ts:586` uses `create`. |
| `CreateProblemOptions` | interface | Options supplied while creating one problem occurrence. | `value: CreateProblemOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `define` | function | Define one immutable RFC 9457 problem contract. | `define(...)` | `.agents/support/production-fixture.ts:157` uses `define`. |
| `definitionOf` | function | Return the exact imported definition retained by a problem tuple. | `definitionOf(...)` | `utils/server/service/runtime.ts:539` uses `definitionOf`. |
| `document` | function | Create JSON-safe documentation from definitions, catalogs, or selections. | `document(...)` | `.agents/tests/public-api-matrix.test.ts:278` uses `document`. |
| `is` | function | Narrow a value to a problem result and optionally one exact declared universe. | `is(...)` | `utils/server/gateway/runtime.ts:97` uses `is`. |
| `map` | function | Exhaustively translate one problem universe into problem results. | `map(...)` | `.agents/tests/public-api-matrix.test.ts:282` uses `map`. |
| `match` | function | Dispatch a problem result through exhaustive or fallback handlers. | `match(...)` | `.agents/tests/public-api-matrix.test.ts:281` uses `match`. |
| `ProblemBody` | type | Canonical RFC 9457 members plus definition-specific extensions. | `value: ProblemBody` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `problemCatalog` | function | Create a named immutable problem catalog. | `problemCatalog(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ProblemDefinition` | interface | Static immutable RFC 9457 problem definition. | `value: ProblemDefinition` | `utils/server/endpoint/definition.ts:166` uses `ProblemDefinition`. |
| `ProblemDefinitionInput` | interface | Input accepted by {@link define}. | `value: ProblemDefinitionInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ProblemDocument` | interface | JSON-safe problem documentation projection. | `value: ProblemDocument` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ProblemExample` | interface | Concrete problem example retained for generated references. | `value: ProblemExample` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ProblemExtensionContract` | interface | Contract for extension members appended to the RFC 9457 body. | `value: ProblemExtensionContract` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ProblemHeaders` | type | Immutable headers attached to a problem result. | `value: ProblemHeaders` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ProblemProviderMetadata` | interface | Provider metadata retained for internal problem catalogs. | `value: ProblemProviderMetadata` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ProblemResult` | type | Logical RFC 9457 response tuple returned before server materialization. | `value: ProblemResult` | `utils/server/endpoint/types.ts:390` uses `ProblemResult`. |
| `ProblemResultMetadata` | interface | Hidden metadata retained by a problem tuple. | `value: ProblemResultMetadata` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ProblemRetryPolicy` | type | Retry guidance attached to a problem definition. | `value: ProblemRetryPolicy` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ProblemSeverity` | type | Public severity classification used by documentation and diagnostics. | `value: ProblemSeverity` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ProblemStatus` | type | Supported RFC 9457 HTTP error status. | `value: ProblemStatus` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `select` | function | Select an immutable key-preserving problem subset. | `select(...)` | `.agents/tests/public-api-matrix.test.ts:276` uses `select`. |
| `validateExtensions` | function | Validate definition extension values against the optional Standard Schema contract. | `validateExtensions(...)` | `.agents/tests/public-api-matrix.test.ts:283` uses `validateExtensions`. |

Detected uses
~~~~~~~~~~~~~

`define` appears in `.agents/support/production-fixture.ts:157`:

~~~~ typescript
const RepositoryUnavailable = problem.define({
	id: 'validation:repository-unavailable',
	type: 'https://validation.kaiju.test/problems/repository-unavailable',
	status: 503,
~~~~

`select` appears in `.agents/tests/public-api-matrix.test.ts:276`:

~~~~ typescript
const selectedProblems = problem.select(problems, ['ProblemA']);
		assert.equal(problem.compose(ProblemA, selectedProblems).length, 1);
		assert.equal(problem.document(problems).length, 2);
		const first = problem.create(ProblemA, { cause: new Error('cause') });
~~~~

`compose` appears in `.agents/tests/public-api-matrix.test.ts:277`:

~~~~ typescript
assert.equal(problem.compose(ProblemA, selectedProblems).length, 1);
		assert.equal(problem.document(problems).length, 2);
		const first = problem.create(ProblemA, { cause: new Error('cause') });
		assert.equal(problem.causeOf(first) instanceof Error, true);
~~~~

`create` appears in `.agents/support/production-fixture.ts:586`:

~~~~ typescript
return problem.create(ImportRejected, { detail: error.message, instance: new URL(ctx.id, 'https://validation.invalid').pathname });
			}
			throw error;
		}
~~~~

`is` appears in `utils/server/gateway/runtime.ts:97`:

~~~~ typescript
if (problem.is(authentication)) return finishProblem(authentication);
		applyHeaders(headers, authentication?.headers);
		const assertion = await runConcern(options.concerns?.assert, route.assertions, state);
		if (problem.is(assertion)) return finishProblem(assertion);
~~~~

`definitionOf` appears in `utils/server/service/runtime.ts:539`:

~~~~ typescript
const definition = problem.definitionOf(result);
		if (!operation.problems.includes(definition) && !FrameworkProblemDefinitions.includes(definition)) {
			return await toResponse(hono, problem.create(ServerProblems.UndeclaredResult, {
				instance: new URL(request.url).pathname,
~~~~

`causeOf` appears in `.agents/tests/public-api-matrix.test.ts:280`:

~~~~ typescript
assert.equal(problem.causeOf(first) instanceof Error, true);
		assert.equal(problem.match(first, problems, { ProblemA: () => 'a', ProblemB: () => 'b' }), 'a');
		assert.equal(problem.map(first, problems, { ProblemA: () => problem.create(ProblemB), ProblemB: () => problem.create(ProblemA) })[1], 503);
		assert.deepEqual(await problem.validateExtensions(ProblemB, { retry: true }), []);
~~~~

`match` appears in `.agents/tests/public-api-matrix.test.ts:281`:

~~~~ typescript
assert.equal(problem.match(first, problems, { ProblemA: () => 'a', ProblemB: () => 'b' }), 'a');
		assert.equal(problem.map(first, problems, { ProblemA: () => problem.create(ProblemB), ProblemB: () => problem.create(ProblemA) })[1], 503);
		assert.deepEqual(await problem.validateExtensions(ProblemB, { retry: true }), []);
		assert.equal((await problem.validateExtensions(ProblemB, { retry: 'no' })).length, 1);
~~~~

`map` appears in `.agents/tests/public-api-matrix.test.ts:282`:

~~~~ typescript
assert.equal(problem.map(first, problems, { ProblemA: () => problem.create(ProblemB), ProblemB: () => problem.create(ProblemA) })[1], 503);
		assert.deepEqual(await problem.validateExtensions(ProblemB, { retry: true }), []);
		assert.equal((await problem.validateExtensions(ProblemB, { retry: 'no' })).length, 1);
	});
~~~~

`document` appears in `.agents/tests/public-api-matrix.test.ts:278`:

~~~~ typescript
assert.equal(problem.document(problems).length, 2);
		const first = problem.create(ProblemA, { cause: new Error('cause') });
		assert.equal(problem.causeOf(first) instanceof Error, true);
		assert.equal(problem.match(first, problems, { ProblemA: () => 'a', ProblemB: () => 'b' }), 'a');
~~~~

`validateExtensions` appears in `.agents/tests/public-api-matrix.test.ts:283`:

~~~~ typescript
assert.deepEqual(await problem.validateExtensions(ProblemB, { retry: true }), []);
		assert.equal((await problem.validateExtensions(ProblemB, { retry: 'no' })).length, 1);
	});
~~~~

`catalog` appears in `services/observations/domain/problems.ts:4`:

~~~~ typescript
export const ObservationProblems = problem.catalog('observations', {
	Unavailable: problem.define({
		id: 'observations:unavailable',
		type: 'https://api.kaiju.land/problems/observations-unavailable',
~~~~

`ProblemDefinition` appears in `utils/server/endpoint/definition.ts:166`:

~~~~ typescript
ProblemDefinition
> {
	assertPath(definition.path);
	if (pathParameters(definition.path).length > 0 && definition.param === undefined) {
~~~~

`ProblemResult` appears in `utils/server/endpoint/types.ts:390`:

~~~~ typescript
| ProblemResult<OperationProblem<Operation>>
	| (Operation['rawResponse'] extends true ? Response : never);

/** Handler function for one exact endpoint operation. */
~~~~

@utils/http/request
-------------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `correlation` | function | Establish one request-owned correlation value. | `correlation(...)` | `utils/server/gateway/runtime.ts:38` uses `correlation`. |
| `correlationFields` | function | Project correlation into redaction-safe structured logging fields. | `correlationFields(...)` | `.agents/tests/public-api-matrix.test.ts:318` uses `correlationFields`. |
| `DefaultRequestParsingLimits` | value | Interoperability-oriented defaults that stay bounded while avoiding common browser and proxy edge cases. | `DefaultRequestParsingLimits` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `disposeMemo` | function | Dispose memoized values exposing native disposal protocols, then clear the request cache. | `disposeMemo(...)` | `utils/server/service/runtime.ts:166` uses `disposeMemo`. |
| `DuplicateCookiePolicy` | type | Cookie duplicate handling policy. | `value: DuplicateCookiePolicy` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `externalUrl` | function | Resolve the externally visible URL only when forwarding fields are explicitly trusted. | `externalUrl(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `formatPath` | function | Format a normalized path without rendering any request value. | `formatPath(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ForwardedHeaderPolicy` | interface | Trusted external-origin resolution policy. | `value: ForwardedHeaderPolicy` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `invalidateMemo` | function | Invalidate one memoized request capability or the complete request cache. | `invalidateMemo(...)` | `.agents/tests/public-api-matrix.test.ts:311` uses `invalidateMemo`. |
| `limits` | function | Resolve and validate request parsing limits without erasing the known key set. | `limits(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `MediaType` | interface | Parsed media type. | `value: MediaType` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `memoize` | function | Compute one request-owned capability once, sharing a pending promise across consumers. | `memoize(...)` | `.agents/tests/public-api-matrix.test.ts:310` uses `memoize`. |
| `negotiateContent` | function | Select the best supported representation using the Deno standard HTTP negotiator. | `negotiateContent(...)` | `utils/server/service/runtime.ts:583` uses `negotiateContent`. |
| `normalizePath` | function | Convert a Standard Schema path into ordinary property keys. | `normalizePath(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `parseAuthorization` | function | Parse Authorization syntax without verifying the credential or establishing identity. | `parseAuthorization(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `parseCookies` | function | Parse a Cookie field with explicit duplicate and decoding policy. | `parseCookies(...)` | `utils/server/service/runtime.ts:492` uses `parseCookies`. |
| `ParsedAuthorization` | interface | Syntax-level Authorization field, not a verified identity. | `value: ParsedAuthorization` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `parseForm` | function | Parse a bounded URL-encoded or multipart form while preserving repeated string values. | `parseForm(...)` | `utils/server/service/runtime.ts:494` uses `parseForm`. |
| `parseHeaders` | function | Parse request fields into a lower-case, bounded record while preserving repetitions where observable. | `parseHeaders(...)` | `utils/server/service/runtime.ts:491` uses `parseHeaders`. |
| `parseJson` | function | Parse bounded JSON after enforcing application/json or a +json media type. | `parseJson(...)` | `utils/server/service/runtime.ts:493` uses `parseJson`. |
| `parseMediaType` | function | Parse a Content-Type or Accept media-range token. | `parseMediaType(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `parseParameters` | function | Parse canonical `:name` route parameters from a matched path. | `parseParameters(...)` | `utils/server/service/runtime.ts:489` uses `parseParameters`. |
| `parseQuery` | function | Preserve repeated query values without applying endpoint-specific semantics. | `parseQuery(...)` | `utils/server/service/runtime.ts:490` uses `parseQuery`. |
| `parseTraceParent` | function | Parse an incoming W3C traceparent without accepting zero IDs or future-version ambiguity. | `parseTraceParent(...)` | `.agents/tests/public-api-matrix.test.ts:320` uses `parseTraceParent`. |
| `parseTraceState` | function | Validate and normalize W3C tracestate. | `parseTraceState(...)` | `.agents/tests/public-api-matrix.test.ts:321` uses `parseTraceState`. |
| `propagationHeaders` | function | Build fields safe to propagate to one downstream HTTP request. | `propagationHeaders(...)` | `utils/server/gateway/runtime.ts:95` uses `propagationHeaders`. |
| `readBody` | function | Read request bytes once with a hard upper bound and Content-Length precheck. | `readBody(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `redactHeaders` | function | Create a log-safe projection that never exposes credentials or cookie values. | `redactHeaders(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `RequestCorrelation` | interface | W3C trace and request-correlation values derived from trusted request input. | `value: RequestCorrelation` | `utils/server/gateway/runtime.ts:60` uses `RequestCorrelation`. |
| `RequestCorrelationFieldOptions` | interface | Optional stable dimensions added to structured correlation fields. | `value: RequestCorrelationFieldOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `RequestCorrelationOptions` | interface | Options used when establishing request correlation. | `value: RequestCorrelationOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `requestId` | function | Return a bounded caller-provided request ID or generate a new UUID. | `requestId(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `RequestInputSource` | type | Request location whose wire or schema validation produced an issue. | `value: RequestInputSource` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `RequestIssue` | interface | Structured wire parsing failure. | `value: RequestIssue` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `RequestIssueCode` | type | Stable issue codes emitted by request wire parsing and sanitation. | `value: RequestIssueCode` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `RequestParsingLimits` | interface | Bounded defaults for generic Web request parsing. | `value: RequestParsingLimits` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `RequestParsingOptions` | type | Partial limit override accepted by parsing functions. | `value: RequestParsingOptions` | `utils/server/service/runtime.ts:438` uses `RequestParsingOptions`. |
| `RequestTransportError` | class | Error containing one or more transport issues safe for validation reporting. | `new RequestTransportError(...)` | `utils/server/service/runtime.ts:454` uses `RequestTransportError`. |
| `RequestValidationDetail` | interface | Stable, value-free validation detail suitable for RFC problem extensions, diagnostics, tests, and structured logging. | `value: RequestValidationDetail` | `utils/server/service/runtime.ts:441` uses `RequestValidationDetail`. |
| `requireContentType` | function | Require one of the supported request content types. | `requireContentType(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `SensitiveCredential` | interface | Parsed authorization credential. | `value: SensitiveCredential` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `validationDetail` | function | Normalize one transport or Standard Schema issue. | `validationDetail(...)` | `utils/server/service/runtime.ts:456` uses `validationDetail`. |
| `validationDetails` | function | Normalize transport and Standard Schema issues without copying rejected request values into diagnostics. | `validationDetails(...)` | `utils/server/service/runtime.ts:455` uses `validationDetails`. |
| `WireRecord` | type | Normalized wire record used for bounded query, header, and parameter values. | `value: WireRecord` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `WireValue` | type | One normalized wire value, preserving repeated occurrences when present. | `value: WireValue` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |

Detected uses
~~~~~~~~~~~~~

`parseForm` appears in `utils/server/service/runtime.ts:494`:

~~~~ typescript
case 'form': return await requestWire.parseForm(request.clone(), options);
		case 'raw': return request;
	}
}
~~~~

`parseJson` appears in `utils/server/service/runtime.ts:493`:

~~~~ typescript
case 'json': return await requestWire.parseJson(request.clone(), options);
		case 'form': return await requestWire.parseForm(request.clone(), options);
		case 'raw': return request;
	}
~~~~

`negotiateContent` appears in `utils/server/service/runtime.ts:583`:

~~~~ typescript
requestWire.negotiateContent(request.headers.get('accept'), [contentType.split(';', 1)[0]!]);
		} catch (error) {
			if (error instanceof requestWire.RequestTransportError && error.issues.some((issue) => issue.code === 'not-acceptable')) {
				return await toResponse(hono, problem.create(ServerProblems.NotAcceptable, {
~~~~

`parseCookies` appears in `utils/server/service/runtime.ts:492`:

~~~~ typescript
case 'cookie': return requestWire.parseCookies(request.headers.get('cookie'), options);
		case 'json': return await requestWire.parseJson(request.clone(), options);
		case 'form': return await requestWire.parseForm(request.clone(), options);
		case 'raw': return request;
~~~~

`parseHeaders` appears in `utils/server/service/runtime.ts:491`:

~~~~ typescript
case 'header': return requestWire.parseHeaders(request.headers, options);
		case 'cookie': return requestWire.parseCookies(request.headers.get('cookie'), options);
		case 'json': return await requestWire.parseJson(request.clone(), options);
		case 'form': return await requestWire.parseForm(request.clone(), options);
~~~~

`validationDetail` appears in `utils/server/service/runtime.ts:456`:

~~~~ typescript
: [requestWire.validationDetail(source, {
					message: error instanceof Error ? error.message : String(error),
				})];
			issues.push(...sourceIssues);
~~~~

`validationDetails` appears in `utils/server/service/runtime.ts:455`:

~~~~ typescript
? requestWire.validationDetails(source, error.issues)
				: [requestWire.validationDetail(source, {
					message: error instanceof Error ? error.message : String(error),
				})];
~~~~

`disposeMemo` appears in `utils/server/service/runtime.ts:166`:

~~~~ typescript
try { await requestWire.disposeMemo(activeRequest); } catch { /* cleanup remains best effort */ }
		if (activeRequest !== request) {
			try { await requestWire.disposeMemo(request); } catch { /* cleanup remains best effort */ }
		}
~~~~

`invalidateMemo` appears in `.agents/tests/public-api-matrix.test.ts:311`:

~~~~ typescript
request.invalidateMemo(requestObject, 'key');
			await request.memoize(requestObject, 'key', () => ++loads);
			assert.equal(loads, 2);
~~~~

`memoize` appears in `.agents/tests/public-api-matrix.test.ts:310`:

~~~~ typescript
await request.memoize(requestObject, 'key', () => ++loads);
			request.invalidateMemo(requestObject, 'key');
			await request.memoize(requestObject, 'key', () => ++loads);
			assert.equal(loads, 2);
~~~~

`parseParameters` appears in `utils/server/service/runtime.ts:489`:

~~~~ typescript
case 'param': return requestWire.parseParameters(routePath, url.pathname, options);
		case 'query': return requestWire.parseQuery(url.searchParams, options);
		case 'header': return requestWire.parseHeaders(request.headers, options);
		case 'cookie': return requestWire.parseCookies(request.headers.get('cookie'), options);
~~~~

`correlation` appears in `utils/server/gateway/runtime.ts:38`:

~~~~ typescript
const correlation = await requestWire.correlation(request, options.requestId === undefined ? {} : { requestId: options.requestId });
			const route = matchers.find((matcher) => matcher.matches(request))?.route;
			if (!route) {
				await emit(compiled.definition.observers, observers, event('denied', compiled.definition.id, correlation, request));
~~~~

`correlationFields` appears in `.agents/tests/public-api-matrix.test.ts:318`:

~~~~ typescript
assert.equal(request.correlationFields(correlation, { service: 'matrix' }).service, 'matrix');
			assert.equal(request.propagationHeaders(correlation).get('x-request-id'), `matrix-request-${index}`);
			assert.equal(request.parseTraceParent('invalid'), undefined);
			assert.equal(request.parseTraceState('a=1,a=2'), undefined);
~~~~

`parseTraceParent` appears in `.agents/tests/public-api-matrix.test.ts:320`:

~~~~ typescript
assert.equal(request.parseTraceParent('invalid'), undefined);
			assert.equal(request.parseTraceState('a=1,a=2'), undefined);
		}
	});
~~~~

`parseTraceState` appears in `.agents/tests/public-api-matrix.test.ts:321`:

~~~~ typescript
assert.equal(request.parseTraceState('a=1,a=2'), undefined);
		}
	});
});
~~~~

`propagationHeaders` appears in `utils/server/gateway/runtime.ts:95`:

~~~~ typescript
for (const [name, value] of requestWire.propagationHeaders(correlation)) headers.set(name, value);
		const authentication = await runConcern(options.concerns?.authenticate, route.authenticate, state);
		if (problem.is(authentication)) return finishProblem(authentication);
		applyHeaders(headers, authentication?.headers);
~~~~

`parseQuery` appears in `utils/server/service/runtime.ts:490`:

~~~~ typescript
case 'query': return requestWire.parseQuery(url.searchParams, options);
		case 'header': return requestWire.parseHeaders(request.headers, options);
		case 'cookie': return requestWire.parseCookies(request.headers.get('cookie'), options);
		case 'json': return await requestWire.parseJson(request.clone(), options);
~~~~

`RequestTransportError` appears in `utils/server/service/runtime.ts:454`:

~~~~ typescript
const sourceIssues = error instanceof requestWire.RequestTransportError
				? requestWire.validationDetails(source, error.issues)
				: [requestWire.validationDetail(source, {
					message: error instanceof Error ? error.message : String(error),
~~~~

`RequestParsingOptions` appears in `utils/server/service/runtime.ts:438`:

~~~~ typescript
parsing: requestWire.RequestParsingOptions | undefined,
): Promise<
	| Readonly<{ readonly success: true; readonly input: Readonly<Record<string, unknown>> }>
	| Readonly<{ readonly success: false; readonly issues: readonly requestWire.RequestValidationDetail[] }>
~~~~

`RequestValidationDetail` appears in `utils/server/service/runtime.ts:441`:

~~~~ typescript
| Readonly<{ readonly success: false; readonly issues: readonly requestWire.RequestValidationDetail[] }>
> {
	const input: Record<string, unknown> = Object.create(null);
	const issues: requestWire.RequestValidationDetail[] = [];
~~~~

`RequestCorrelation` appears in `utils/server/gateway/runtime.ts:60`:

~~~~ typescript
correlation: requestWire.RequestCorrelation,
	fetcher: typeof fetch,
	options: CreateGatewayOptions,
	observers: ReadonlyMap<GatewayObserverDefinition, GatewayObserverHandler>,
~~~~

@utils/http/response
--------------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `accepted` | function | Define a `202 Accepted` response. | `accepted(...)` | `.agents/support/production-fixture.ts:279` uses `accepted`. |
| `appendHeaders` | function | Append additional field occurrences rather than replacing existing values. | `appendHeaders(...)` | `.agents/tests/public-api-matrix.test.ts:211` uses `appendHeaders`. |
| `byteRange` | function | Parse a single RFC 9110 bytes range without allocating or reading a body. | `byteRange(...)` | `.agents/tests/public-api-matrix.test.ts:213` uses `byteRange`. |
| `ByteRange` | type | Result of parsing one HTTP byte-range request. | `value: ByteRange` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `byteRangeHeaders` | function | Return standard fields for one satisfiable or unsatisfiable byte-range decision. | `byteRangeHeaders(...)` | `.agents/tests/public-api-matrix.test.ts:215` uses `byteRangeHeaders`. |
| `catalog` | function | Create a named immutable response catalog. | `catalog(...)` | `.agents/tests/public-api-matrix.test.ts:193` uses `catalog`. |
| `clientErrorStatus` | value | Client-error status schema. | `clientErrorStatus` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ClientErrorStatus` | type | Standard client-error HTTP status codes. | `value: ClientErrorStatus` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `compose` | function | Compose response definitions, catalogs, selections, and nested arrays. | `compose(...)` | `.agents/tests/public-api-matrix.test.ts:201` uses `compose`. |
| `conditionalHeaders` | function | Retain the representation metadata fields permitted on a generated 304 response. | `conditionalHeaders(...)` | `utils/server/service/runtime.ts:533` uses `conditionalHeaders`. |
| `contentfulStatus` | value | Contentful status schema. | `contentfulStatus` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ContentfulStatus` | type | Recognized statuses that may carry a representation. | `value: ContentfulStatus` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `contentlessStatus` | value | Contentless status schema. | `contentlessStatus` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ContentlessStatus` | type | Statuses whose semantics prohibit a message body. | `value: ContentlessStatus` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `create` | function | Instantiate a definition-associated logical result. | `create(...)` | `.agents/support/production-fixture.ts:583` uses `create`. |
| `created` | function | Define a `201 Created` response. | `created(...)` | `.agents/tests/public-api-matrix.test.ts:187` uses `created`. |
| `CreateResponseOptions` | interface | Options applied when instantiating a successful response. | `value: CreateResponseOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CursorPageWindow` | interface | Cursor-based page returned by a storage adapter. | `value: CursorPageWindow` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `define` | function | Define one immutable successful HTTP response contract. | `define(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `definitionOf` | function | Return the exact imported definition retained by a response tuple. | `definitionOf(...)` | `utils/server/service/runtime.ts:520` uses `definitionOf`. |
| `document` | function | Create JSON-safe response documentation. | `document(...)` | `.agents/tests/public-api-matrix.test.ts:202` uses `document`. |
| `download` | function | Define a downloadable response. | `download(...)` | `.agents/tests/public-api-matrix.test.ts:191` uses `download`. |
| `finalize` | function | Finalize one logical result with request-aware transport metadata. | `finalize(...)` | `utils/server/service/runtime.ts:569` uses `finalize`. |
| `FinalizedResponseResult` | interface | Fully request-aware result ready for native HTTP response conversion. | `value: FinalizedResponseResult` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `FinalizeResponseOptions` | interface | Adapter-owned materialization options. | `value: FinalizeResponseOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `headerEntries` | function | Return every HTTP field occurrence in deterministic order. | `headerEntries(...)` | `utils/server/gateway/runtime.ts:338` uses `headerEntries`. |
| `HeaderField` | type | One HTTP field occurrence. | `value: HeaderField` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `HeaderInput` | type | Header input accepted by response and problem occurrence APIs. | `value: HeaderInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `headers` | function | Validate and normalize one header input without flattening repeated fields. | `headers(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `HeaderValue` | type | Ergonomic value accepted in record-shaped header input. | `value: HeaderValue` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `headerValues` | function | Read every value for a field without comma-splitting values such as Set-Cookie. | `headerValues(...)` | `utils/server/service/runtime.ts:620` uses `headerValues`. |
| `html` | function | Define a small one-off HTML page without changing the Solid application renderer. | `html(...)` | `utils/server/endpoint/mod_test.ts:146` uses `html`. |
| `HtmlBody` | type | Complete one-off HTML body accepted as a string, Web Stream, or async iterable. | `value: HtmlBody` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `HtmlChunk` | type | One string or encoded byte chunk accepted by a streaming HTML response. | `value: HtmlChunk` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `HttpStatus` | type | Every standard final/interim status recognized by the utility. | `value: HttpStatus` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `HttpStatusSchema` | interface | Standard Schema plus JSON Schema projection for an HTTP status subset. | `value: HttpStatusSchema` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `informationalStatus` | value | Informational status schema. | `informationalStatus` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `InformationalStatus` | type | Informational HTTP status codes. | `value: InformationalStatus` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `is` | function | Return whether a value is a response tuple created by this package. | `is(...)` | `utils/server/service/runtime.ts:519` uses `is`. |
| `isContentlessStatus` | function | Return whether the status semantics prohibit a message body. | `isContentlessStatus(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `isNotModified` | function | Evaluate GET/HEAD conditional request fields against response validators. | `isNotModified(...)` | `utils/server/service/runtime.ts:531` uses `isNotModified`. |
| `isProblemStatus` | function | Return whether a value is valid for an RFC problem response. | `isProblemStatus(...)` | `.agents/tests/public-api-matrix.test.ts:221` uses `isProblemStatus`. |
| `isStatus` | function | Return whether a value is any recognized HTTP status. | `isStatus(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `mergeHeaders` | function | Merge header sources with later sources replacing earlier fields by name. | `mergeHeaders(...)` | `utils/server/gateway/runtime.ts:492` uses `mergeHeaders`. |
| `noContent` | function | Define a bodyless `204 No Content` response. | `noContent(...)` | `.agents/tests/public-api-matrix.test.ts:232` uses `noContent`. |
| `notModified` | function | Define a bodyless `304 Not Modified` response for explicit conditional contracts. | `notModified(...)` | `utils/server/service/runtime_test.ts:251` uses `notModified`. |
| `OffsetPageWindow` | interface | Offset/page-number page returned by a storage adapter. | `value: OffsetPageWindow` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ok` | function | Define a `200 OK` response. | `ok(...)` | `.agents/support/production-fixture.ts:280` uses `ok`. |
| `onComplete` | function | Observe full response-body completion without buffering or cloning the body. | `onComplete(...)` | `utils/server/gateway/runtime.ts:79` uses `onComplete`. |
| `pageHeaders` | function | Construct RFC 8288 Link and count/page fields from a page window. | `pageHeaders(...)` | `.agents/tests/public-api-matrix.test.ts:220` uses `pageHeaders`. |
| `pageLinks` | function | Construct request-aware pagination links without instantiating a response. | `pageLinks(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `PageWindow` | type | Transport-neutral page window supplied to a paginated response definition. | `value: PageWindow` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `paginated` | function | Define a paginated collection response. | `paginated(...)` | `utils/server/endpoint/mod_test.ts:141` uses `paginated`. |
| `PaginationLinkContext` | interface | Context supplied to a custom pagination link builder. | `value: PaginationLinkContext` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `PaginationLinks` | interface | Generated pagination links. | `value: PaginationLinks` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `PaginationMetadata` | interface | JSON-safe pagination metadata emitted in a response body. | `value: PaginationMetadata` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `PaginationParameters` | interface | Standard pagination URL parameter names used during materialization. | `value: PaginationParameters` | `utils/server/service/runtime.ts:645` uses `PaginationParameters`. |
| `PaginationResponsePolicy` | interface | Pagination presentation policy retained by a paginated response definition. | `value: PaginationResponsePolicy` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `partialContent` | function | Define a `206 Partial Content` response whose body is produced by an artifact adapter. | `partialContent(...)` | `.agents/tests/public-api-matrix.test.ts:188` uses `partialContent`. |
| `problemStatus` | value | RFC problem status schema. | `problemStatus` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ProblemStatus` | type | Statuses valid for RFC problem responses. | `value: ProblemStatus` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `redirect` | function | Define an HTTP redirect response. | `redirect(...)` | `.agents/tests/public-api-matrix.test.ts:189` uses `redirect`. |
| `redirectStatus` | value | Redirect status schema. | `redirectStatus` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `RedirectStatus` | type | Redirect HTTP status codes, including deprecated 305/306 for recognition. | `value: RedirectStatus` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ResponseBody` | type | Logical body accepted when instantiating one response definition. | `value: ResponseBody` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ResponseCompletion` | interface | Final outcome of delivering a response body to the host/client. | `value: ResponseCompletion` | `utils/server/gateway/types.ts:80` uses `ResponseCompletion`. |
| `ResponseDefinition` | interface | Static successful response contract. | `value: ResponseDefinition` | `utils/server/endpoint/openapi.ts:253` uses `ResponseDefinition`. |
| `ResponseDefinitionInput` | interface | Input accepted by {@link define}. | `value: ResponseDefinitionInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ResponseDocument` | interface | JSON-safe documentation projection for a successful response definition. | `value: ResponseDocument` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ResponseEnvelope` | type | Optional success envelope added during HTTP materialization. | `value: ResponseEnvelope` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ResponseExample` | interface | Concrete request or response example retained for generated documentation. | `value: ResponseExample` | `utils/server/endpoint/openapi.ts:643` uses `ResponseExample`. |
| `ResponseHeaders` | type | Immutable header record used in response/problem tuples. | `value: ResponseHeaders` | `utils/server/service/runtime.ts:618` uses `ResponseHeaders`. |
| `ResponseResult` | type | Logical tuple returned by endpoint handlers before request-aware materialization. | `value: ResponseResult` | `utils/server/endpoint/types.ts:389` uses `ResponseResult`. |
| `ResponseResultMetadata` | interface | Hidden metadata attached to each response tuple. | `value: ResponseResultMetadata` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ResponseSchema` | type | Standard Schema-compatible response body contract. | `value: ResponseSchema` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ResponseStatus` | type | HTTP success and redirect status codes supported by response definitions. | `value: ResponseStatus` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `select` | function | Select an immutable key-preserving response subset. | `select(...)` | `.agents/tests/public-api-matrix.test.ts:200` uses `select`. |
| `serverErrorStatus` | value | Server-error status schema. | `serverErrorStatus` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ServerErrorStatus` | type | Standard server-error HTTP status codes. | `value: ServerErrorStatus` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `status` | namespace | Public contract documented by the source declaration. | `status.…` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `statusAny` | value | All recognized HTTP statuses. | `statusAny` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `stream` | function | Define a streaming response. | `stream(...)` | `.agents/tests/public-api-matrix.test.ts:190` uses `stream`. |
| `SuccessEnvelope` | interface | Default success envelope. | `value: SuccessEnvelope` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `successStatus` | value | Successful status schema. | `successStatus` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `SuccessStatus` | type | Successful HTTP status codes. | `value: SuccessStatus` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `toHeaders` | function | Return a standard Headers instance while preserving repeatable values where the runtime permits it. | `toHeaders(...)` | `utils/server/gateway/runtime.ts:492` uses `toHeaders`. |
| `withHeaders` | function | Return a copy of a logical result with occurrence headers merged in. | `withHeaders(...)` | `.agents/tests/public-api-matrix.test.ts:204` uses `withHeaders`. |
| `withMeta` | function | Return a copy whose final body contains merged metadata in a data envelope. | `withMeta(...)` | `services/observations/endpoints/hosts/list/handler.ts:25` uses `withMeta`. |

Detected uses
~~~~~~~~~~~~~

`accepted` appears in `.agents/support/production-fixture.ts:279`:

~~~~ typescript
const Accepted = response.accepted(ImportRecordSchema, { id: 'validation:import-accepted', description: 'Import completed by the synthetic coordinator.' });
const Detail = response.ok(ImportRecordSchema, { id: 'validation:import-detail', description: 'Synthetic import status.' });
const Health = response.ok(schema<Readonly<{ readonly ok: true }>>((value) => {
	if (!isRecord(value) || value.ok !== true) throw new TypeError('Expected health result.');
~~~~

`created` appears in `.agents/tests/public-api-matrix.test.ts:187`:

~~~~ typescript
response.created(StringSchema, { description: 'Created matrix value.' }),
				response.partialContent(StringSchema, { description: 'Partial matrix value.' }),
				response.redirect(307, { description: 'Redirect matrix value.' }),
				response.stream(StringSchema, { description: 'Stream matrix value.' }),
~~~~

`document` appears in `.agents/tests/public-api-matrix.test.ts:202`:

~~~~ typescript
assert.equal(response.document(responses).length, 5);
			assert.equal(response.create(definitions[2]!, undefined, { location: '/next' })[1], 307);
			const decorated = response.withMeta(response.withHeaders(response.create(definitions[0]!, 'value'), { 'X-Matrix': 'yes' }), { scenario: index });
			assert.equal(response.finalize(decorated).headers['X-Matrix'], 'yes');
~~~~

`download` appears in `.agents/tests/public-api-matrix.test.ts:191`:

~~~~ typescript
response.download(StringSchema, { description: 'Download matrix value.', filename: 'matrix.txt' }),
			];
			const responses = response.catalog(`matrix.responses.${index}`, {
				Created: definitions[0]!,
~~~~

`html` appears in `utils/server/endpoint/mod_test.ts:146`:

~~~~ typescript
const Html = response.html({ id: 'widgets:html', description: 'Widget HTML.' });
		const List = endpoint.get({ id: 'widgets.list', path: '/widgets', responses: [Page] });
		const Human = endpoint.get({ id: 'widgets.human', path: '/widgets.html', responses: [Html] });
		const document = await endpoint.openapi([List, Human], { title: 'Widgets', version: '1' });
~~~~

`noContent` appears in `.agents/tests/public-api-matrix.test.ts:232`:

~~~~ typescript
const NoContent = response.noContent({ id: `matrix:no-content-${index}` });
			const endpoints = {
				Put: endpoint.put({ id: `matrix.put-${index}`, path: '/put', responses: [NoContent] }),
				Patch: endpoint.patch({ id: `matrix.patch-${index}`, path: '/patch', responses: [NoContent] }),
~~~~

`notModified` appears in `utils/server/service/runtime_test.ts:251`:

~~~~ typescript
const NotModified = response.notModified({ id: 'runtime.not-modified' });
		const Read = endpoint.get({ id: 'runtime.read-cached', path: '/cached', responses: [Cached, NotModified] });
		const definition = service.define({ id: 'cached', path: '/', endpoints: [Read] });
		await using runtime = service.create(service.compile(service.implement(definition, {
~~~~

`partialContent` appears in `.agents/tests/public-api-matrix.test.ts:188`:

~~~~ typescript
response.partialContent(StringSchema, { description: 'Partial matrix value.' }),
				response.redirect(307, { description: 'Redirect matrix value.' }),
				response.stream(StringSchema, { description: 'Stream matrix value.' }),
				response.download(StringSchema, { description: 'Download matrix value.', filename: 'matrix.txt' }),
~~~~

`ok` appears in `.agents/support/production-fixture.ts:280`:

~~~~ typescript
const Detail = response.ok(ImportRecordSchema, { id: 'validation:import-detail', description: 'Synthetic import status.' });
const Health = response.ok(schema<Readonly<{ readonly ok: true }>>((value) => {
	if (!isRecord(value) || value.ok !== true) throw new TypeError('Expected health result.');
	return Object.freeze({ ok: true as const });
~~~~

`paginated` appears in `utils/server/endpoint/mod_test.ts:141`:

~~~~ typescript
const Page = response.paginated(Widget, {
			id: 'widgets:page',
			description: 'Widget page.',
			pagination: { links: 'both', totals: 'body' },
~~~~

`redirect` appears in `.agents/tests/public-api-matrix.test.ts:189`:

~~~~ typescript
response.redirect(307, { description: 'Redirect matrix value.' }),
				response.stream(StringSchema, { description: 'Stream matrix value.' }),
				response.download(StringSchema, { description: 'Download matrix value.', filename: 'matrix.txt' }),
			];
~~~~

`catalog` appears in `.agents/tests/public-api-matrix.test.ts:193`:

~~~~ typescript
const responses = response.catalog(`matrix.responses.${index}`, {
				Created: definitions[0]!,
				Partial: definitions[1]!,
				Redirect: definitions[2]!,
~~~~

`select` appears in `.agents/tests/public-api-matrix.test.ts:200`:

~~~~ typescript
assert.equal(response.select(responses, ['Created']).Created, definitions[0]);
			assert.equal(response.compose(response.select(responses, ['Created', 'Download'])).length, 2);
			assert.equal(response.document(responses).length, 5);
			assert.equal(response.create(definitions[2]!, undefined, { location: '/next' })[1], 307);
~~~~

`compose` appears in `.agents/tests/public-api-matrix.test.ts:201`:

~~~~ typescript
assert.equal(response.compose(response.select(responses, ['Created', 'Download'])).length, 2);
			assert.equal(response.document(responses).length, 5);
			assert.equal(response.create(definitions[2]!, undefined, { location: '/next' })[1], 307);
			const decorated = response.withMeta(response.withHeaders(response.create(definitions[0]!, 'value'), { 'X-Matrix': 'yes' }), { scenario: index });
~~~~

`stream` appears in `.agents/tests/public-api-matrix.test.ts:190`:

~~~~ typescript
response.stream(StringSchema, { description: 'Stream matrix value.' }),
				response.download(StringSchema, { description: 'Download matrix value.', filename: 'matrix.txt' }),
			];
			const responses = response.catalog(`matrix.responses.${index}`, {
~~~~

`onComplete` appears in `utils/server/gateway/runtime.ts:79`:

~~~~ typescript
return response.onComplete(abortable, async (completion) => {
			if (timer !== undefined) clearTimeout(timer);
			const kind: GatewayObserverEventKind = completion.outcome === 'completed'
				? 'completed'
~~~~

`byteRange` appears in `.agents/tests/public-api-matrix.test.ts:213`:

~~~~ typescript
const satisfiable = response.byteRange('bytes=2-4', 10);
			if (satisfiable.kind !== 'satisfiable') throw new Error('Expected a satisfiable range.');
			assert.equal(response.byteRangeHeaders(satisfiable)['Content-Length'], '3');
			const unsatisfiable = response.byteRange('bytes=50-60', 10);
~~~~

`byteRangeHeaders` appears in `.agents/tests/public-api-matrix.test.ts:215`:

~~~~ typescript
assert.equal(response.byteRangeHeaders(satisfiable)['Content-Length'], '3');
			const unsatisfiable = response.byteRange('bytes=50-60', 10);
			if (unsatisfiable.kind !== 'unsatisfiable') throw new Error('Expected an unsatisfiable range.');
			assert.equal(response.byteRangeHeaders(unsatisfiable)['Content-Range'], 'bytes */10');
~~~~

`conditionalHeaders` appears in `utils/server/service/runtime.ts:533`:

~~~~ typescript
headers: response.conditionalHeaders(result[2]),
			}), request, operation);
		}
		return await toResponse(hono, result, request, operation);
~~~~

`isNotModified` appears in `utils/server/service/runtime.ts:531`:

~~~~ typescript
if (notModified !== undefined && response.isNotModified(request, result[2])) {
			return await toResponse(hono, response.create(notModified, undefined, {
				headers: response.conditionalHeaders(result[2]),
			}), request, operation);
~~~~

`ResponseCompletion` appears in `utils/server/gateway/types.ts:80`:

~~~~ typescript
readonly completion?: ResponseCompletion;
	readonly error?: Readonly<{ readonly name: string; readonly message: string }>;
}
~~~~

`appendHeaders` appears in `.agents/tests/public-api-matrix.test.ts:211`:

~~~~ typescript
const appended = response.appendHeaders({ 'Set-Cookie': 'a=1' }, { 'Set-Cookie': 'b=2' });
			assert.deepEqual(response.headerValues(appended, 'set-cookie'), ['a=1', 'b=2']);
			const satisfiable = response.byteRange('bytes=2-4', 10);
			if (satisfiable.kind !== 'satisfiable') throw new Error('Expected a satisfiable range.');
~~~~

`headerEntries` appears in `utils/server/gateway/runtime.ts:338`:

~~~~ typescript
for (const [key, value] of response.headerEntries(patch)) {
		const lower = key.toLowerCase();
		if (removedRequestHeaders.has(lower) || lower === 'forwarded' || lower.startsWith('x-forwarded-')) throw new TypeError(`Trusted gateway patch cannot set ${JSON.stringify(key)}.`);
		headers.set(key, value);
~~~~

`headerValues` appears in `utils/server/service/runtime.ts:620`:

~~~~ typescript
const explicit = response.headerValues(headers, 'Content-Type')[0];
	if (explicit !== undefined) return explicit;
	if (problem.is(result)) return 'application/problem+json; charset=utf-8';
	const definition = response.definitionOf(result);
~~~~

`mergeHeaders` appears in `utils/server/gateway/runtime.ts:492`:

~~~~ typescript
const normalized = response.toHeaders(response.mergeHeaders(headers, { 'Content-Type': 'application/problem+json; charset=utf-8' }));
	return new Response(JSON.stringify(body), { status, headers: normalized });
}
~~~~

`toHeaders` appears in `utils/server/gateway/runtime.ts:492`:

~~~~ typescript
const normalized = response.toHeaders(response.mergeHeaders(headers, { 'Content-Type': 'application/problem+json; charset=utf-8' }));
	return new Response(JSON.stringify(body), { status, headers: normalized });
}
~~~~

`isProblemStatus` appears in `.agents/tests/public-api-matrix.test.ts:221`:

~~~~ typescript
assert.equal(response.isProblemStatus(503), true);
			assert.equal(response.isProblemStatus(200), false);
			assert.throws(() => response.appendHeaders({}, { 'Bad\nHeader': 'x' }), TypeError);
			assert.throws(() => response.byteRangeHeaders(response.byteRange(null, 10) as never), TypeError);
~~~~

`create` appears in `.agents/support/production-fixture.ts:583`:

~~~~ typescript
return response.create(Accepted, record, { headers: { Location: `/api/v1/imports/${id}` } });
		} catch (error) {
			if (failure.is(error, DomainRejected)) {
				return problem.create(ImportRejected, { detail: error.message, instance: new URL(ctx.id, 'https://validation.invalid').pathname });
~~~~

`definitionOf` appears in `utils/server/service/runtime.ts:520`:

~~~~ typescript
const definition = response.definitionOf(result);
		if (!operation.responses.includes(definition)) return await toResponse(hono, problem.create(ServerProblems.UndeclaredResult, {
			instance: new URL(request.url).pathname,
			cause: new TypeError(`Undeclared response ${definition.id}.`),
~~~~

`is` appears in `utils/server/service/runtime.ts:519`:

~~~~ typescript
if (response.is(result)) {
		const definition = response.definitionOf(result);
		if (!operation.responses.includes(definition)) return await toResponse(hono, problem.create(ServerProblems.UndeclaredResult, {
			instance: new URL(request.url).pathname,
~~~~

`pageHeaders` appears in `.agents/tests/public-api-matrix.test.ts:220`:

~~~~ typescript
assert.ok(response.pageHeaders(page, 'https://validation.test/items').Link);
			assert.equal(response.isProblemStatus(503), true);
			assert.equal(response.isProblemStatus(200), false);
			assert.throws(() => response.appendHeaders({}, { 'Bad\nHeader': 'x' }), TypeError);
~~~~

`finalize` appears in `utils/server/service/runtime.ts:569`:

~~~~ typescript
? response.finalize(result, {
			url: request.url,
			...(operation === undefined ? {} : { pagination: paginationParameters(operation, result[0]) }),
		})
~~~~

`withHeaders` appears in `.agents/tests/public-api-matrix.test.ts:204`:

~~~~ typescript
const decorated = response.withMeta(response.withHeaders(response.create(definitions[0]!, 'value'), { 'X-Matrix': 'yes' }), { scenario: index });
			assert.equal(response.finalize(decorated).headers['X-Matrix'], 'yes');
		}
	});
~~~~

`withMeta` appears in `services/observations/endpoints/hosts/list/handler.ts:25`:

~~~~ typescript
return response.withMeta(response.create(Response, {
			host: hostname,
			...(path !== undefined ? { path } : {}),
			...(targetUrl !== undefined ? { targetUrl } : {}),
~~~~

`PaginationParameters` appears in `utils/server/service/runtime.ts:645`:

~~~~ typescript
): Partial<response.PaginationParameters> {
	const slot = operation.operation.inputs.query ?? operation.endpoint.inputs.query;
	if (!slot) return Object.freeze({});
	const schema = endpoint.schemaOf(slot);
~~~~

`ResponseDefinition` appears in `utils/server/endpoint/openapi.ts:253`:

~~~~ typescript
for (const definition of definitionValues<ResponseDefinition>(operation.responses)) {
		appendStatus(byStatus, String(definition.status), await successResponseObject(definition, internal))
	}
	for (const definition of problems) {
~~~~

`ResponseExample` appears in `utils/server/endpoint/openapi.ts:643`:

~~~~ typescript
function responseExamplesObject(examples: readonly ResponseExample[] | undefined): Readonly<Record<string, unknown>> {
	if (!examples || examples.length === 0) return Object.freeze({})
	return deepFreeze({
		examples: Object.fromEntries(examples.map((example) => [example.key, {
~~~~

`ResponseHeaders` appears in `utils/server/service/runtime.ts:618`:

~~~~ typescript
headers: response.ResponseHeaders,
): string | undefined {
	const explicit = response.headerValues(headers, 'Content-Type')[0];
	if (explicit !== undefined) return explicit;
~~~~

`ResponseResult` appears in `utils/server/endpoint/types.ts:389`:

~~~~ typescript
| ResponseResult<OperationResponse<Operation>>
	| ProblemResult<OperationProblem<Operation>>
	| (Operation['rawResponse'] extends true ? Response : never);
~~~~

@utils/http/response/types
--------------------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `CreateResponseOptions` | interface | Options applied when instantiating a successful response. | `value: CreateResponseOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CursorPageWindow` | interface | Cursor-based page returned by a storage adapter. | `value: CursorPageWindow` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `FinalizedResponseResult` | interface | Fully request-aware result ready for native HTTP response conversion. | `value: FinalizedResponseResult` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `FinalizeResponseOptions` | interface | Adapter-owned materialization options. | `value: FinalizeResponseOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `HeaderField` | type | One HTTP field occurrence. | `value: HeaderField` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `HeaderInput` | type | Header input accepted by response and problem occurrence APIs. | `value: HeaderInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `HeaderValue` | type | Ergonomic value accepted in record-shaped header input. | `value: HeaderValue` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `HtmlBody` | type | Complete one-off HTML body accepted as a string, Web Stream, or async iterable. | `value: HtmlBody` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `HtmlChunk` | type | One string or encoded byte chunk accepted by a streaming HTML response. | `value: HtmlChunk` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `OffsetPageWindow` | interface | Offset/page-number page returned by a storage adapter. | `value: OffsetPageWindow` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `PageWindow` | type | Transport-neutral page window supplied to a paginated response definition. | `value: PageWindow` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `PaginationLinkContext` | interface | Context supplied to a custom pagination link builder. | `value: PaginationLinkContext` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `PaginationLinks` | interface | Generated pagination links. | `value: PaginationLinks` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `PaginationMetadata` | interface | JSON-safe pagination metadata emitted in a response body. | `value: PaginationMetadata` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `PaginationParameters` | interface | Standard pagination URL parameter names used during materialization. | `value: PaginationParameters` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `PaginationResponsePolicy` | interface | Pagination presentation policy retained by a paginated response definition. | `value: PaginationResponsePolicy` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ResponseBody` | type | Logical body accepted when instantiating one response definition. | `value: ResponseBody` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ResponseDefinition` | interface | Static successful response contract. | `value: ResponseDefinition` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ResponseDefinitionInput` | interface | Input accepted by {@link define}. | `value: ResponseDefinitionInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ResponseDocument` | interface | JSON-safe documentation projection for a successful response definition. | `value: ResponseDocument` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ResponseEnvelope` | type | Optional success envelope added during HTTP materialization. | `value: ResponseEnvelope` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ResponseExample` | interface | Concrete request or response example retained for generated documentation. | `value: ResponseExample` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ResponseHeaders` | type | Immutable header record used in response/problem tuples. | `value: ResponseHeaders` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ResponseResult` | type | Logical tuple returned by endpoint handlers before request-aware materialization. | `value: ResponseResult` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ResponseResultMetadata` | interface | Hidden metadata attached to each response tuple. | `value: ResponseResultMetadata` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ResponseSchema` | type | Standard Schema-compatible response body contract. | `value: ResponseSchema` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ResponseStatus` | type | HTTP success and redirect status codes supported by response definitions. | `value: ResponseStatus` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `SuccessEnvelope` | interface | Default success envelope. | `value: SuccessEnvelope` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |

@utils/http/response/headers
----------------------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `appendHeaders` | function | Append additional field occurrences rather than replacing existing values. | `appendHeaders(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `headerEntries` | function | Return every HTTP field occurrence in deterministic order. | `headerEntries(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `HeaderField` | type | One HTTP field occurrence. | `value: HeaderField` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `HeaderInput` | type | Header input accepted by response and problem occurrence APIs. | `value: HeaderInput` | `utils/http/problem/types.ts:97` uses `HeaderInput`. |
| `headers` | function | Validate and normalize one header input without flattening repeated fields. | `headers(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `HeaderValue` | type | Ergonomic value accepted in record-shaped header input. | `value: HeaderValue` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `headerValues` | function | Read every value for a field without comma-splitting values such as Set-Cookie. | `headerValues(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `mergeHeaders` | function | Merge header sources with later sources replacing earlier fields by name. | `mergeHeaders(...)` | `utils/http/problem/mod.ts:89` uses `mergeHeaders`. |
| `ResponseHeaders` | type | Immutable header record used in response/problem tuples. | `value: ResponseHeaders` | `utils/http/problem/types.ts:90` uses `ResponseHeaders`. |
| `toHeaders` | function | Return a standard Headers instance while preserving repeatable values where the runtime permits it. | `toHeaders(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |

Detected uses
~~~~~~~~~~~~~

`ResponseHeaders` appears in `utils/http/problem/types.ts:90`:

~~~~ typescript
export type ProblemHeaders = ResponseHeaders;

/** Options supplied while creating one problem occurrence. */
export interface CreateProblemOptions<Extensions extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>> {
~~~~

`HeaderInput` appears in `utils/http/problem/types.ts:97`:

~~~~ typescript
readonly headers?: HeaderInput;
	readonly cause?: unknown;
}
~~~~

`mergeHeaders` appears in `utils/http/problem/mod.ts:89`:

~~~~ typescript
const headers = mergeHeaders(
		{ 'Content-Type': 'application/problem+json', 'Cache-Control': 'no-store' },
		options.headers,
	);
~~~~

@utils/http/response/completion
-------------------------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `onComplete` | function | Observe full response-body completion without buffering or cloning the body. | `onComplete(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ResponseCompletion` | interface | Final outcome of delivering a response body to the host/client. | `value: ResponseCompletion` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |

@utils/http/response/http
-------------------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `byteRange` | function | Parse a single RFC 9110 bytes range without allocating or reading a body. | `byteRange(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ByteRange` | type | Result of parsing one HTTP byte-range request. | `value: ByteRange` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `byteRangeHeaders` | function | Return standard fields for one satisfiable or unsatisfiable byte-range decision. | `byteRangeHeaders(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `conditionalHeaders` | function | Retain the representation metadata fields permitted on a generated 304 response. | `conditionalHeaders(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `notModified` | function | Evaluate GET/HEAD conditional request fields against response validators. | `notModified(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |

@utils/http/response/status
---------------------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `any` | value | All recognized HTTP statuses. | `any` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `clientError` | value | Client-error status schema. | `clientError` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ClientErrorStatus` | type | Standard client-error HTTP status codes. | `value: ClientErrorStatus` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `contentful` | value | Contentful status schema. | `contentful` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ContentfulStatus` | type | Recognized statuses that may carry a representation. | `value: ContentfulStatus` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `contentless` | value | Contentless status schema. | `contentless` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ContentlessStatus` | type | Statuses whose semantics prohibit a message body. | `value: ContentlessStatus` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `HttpStatus` | type | Every standard final/interim status recognized by the utility. | `value: HttpStatus` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `HttpStatusSchema` | interface | Standard Schema plus JSON Schema projection for an HTTP status subset. | `value: HttpStatusSchema` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `informational` | value | Informational status schema. | `informational` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `InformationalStatus` | type | Informational HTTP status codes. | `value: InformationalStatus` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `is` | function | Return whether a value is any recognized HTTP status. | `is(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `isContentless` | function | Return whether the status semantics prohibit a message body. | `isContentless(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `isProblem` | function | Return whether a value is valid for an RFC problem response. | `isProblem(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `problem` | value | RFC problem status schema. | `problem` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ProblemStatus` | type | Statuses valid for RFC problem responses. | `value: ProblemStatus` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `redirect` | value | Redirect status schema. | `redirect` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `RedirectStatus` | type | Redirect HTTP status codes, including deprecated 305/306 for recognition. | `value: RedirectStatus` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `serverError` | value | Server-error status schema. | `serverError` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ServerErrorStatus` | type | Standard server-error HTTP status codes. | `value: ServerErrorStatus` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `success` | value | Successful status schema. | `success` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `SuccessStatus` | type | Successful HTTP status codes. | `value: SuccessStatus` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |

Coverage note
-------------

This generated map contains 249 public names across 10 package export targets. 85 names have a direct in-repository use detected through TypeScript imports.

A missing in-repository use is not converted into a fake example. It is a signal that the export is currently an extension point, a type-level support surface, or an API that still needs a concrete adopter.

