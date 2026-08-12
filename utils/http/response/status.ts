import type { StandardSchemaV1 } from '@standard-schema/spec';

/** Informational HTTP status codes. */
export type InformationalStatus = 100 | 101 | 102 | 103;
/** Successful HTTP status codes. */
export type SuccessStatus = 200 | 201 | 202 | 203 | 204 | 205 | 206 | 207 | 208 | 226;
/** Redirect HTTP status codes, including deprecated 305/306 for recognition. */
export type RedirectStatus = 300 | 301 | 302 | 303 | 304 | 305 | 306 | 307 | 308;
/** Standard client-error HTTP status codes. */
export type ClientErrorStatus =
	| 400 | 401 | 402 | 403 | 404 | 405 | 406 | 407 | 408 | 409 | 410 | 411 | 412 | 413
	| 414 | 415 | 416 | 417 | 418 | 421 | 422 | 423 | 424 | 425 | 426 | 428 | 429 | 431 | 451;
/** Standard server-error HTTP status codes. */
export type ServerErrorStatus = 500 | 501 | 502 | 503 | 504 | 505 | 506 | 507 | 508 | 510 | 511;
/** Every standard final/interim status recognized by the utility. */
export type HttpStatus = InformationalStatus | SuccessStatus | RedirectStatus | ClientErrorStatus | ServerErrorStatus;
/** Statuses valid for RFC problem responses. */
export type ProblemStatus = ClientErrorStatus | ServerErrorStatus;
/** Statuses whose semantics prohibit a message body. */
export type ContentlessStatus = 101 | 204 | 205 | 304;
/** Recognized statuses that may carry a representation. */
export type ContentfulStatus = Exclude<HttpStatus, ContentlessStatus>;

/** Standard Schema plus JSON Schema projection for an HTTP status subset. */
export interface HttpStatusSchema<Status extends number = HttpStatus> extends StandardSchemaV1<unknown, Status> {
	readonly values: readonly Status[];
	readonly '~standard-json-schema': Readonly<{
		readonly version: 1;
		readonly vendor: 'kaiju';
		readonly jsonSchema: Readonly<{ readonly type: 'integer'; readonly enum: readonly Status[] }>;
	}>;
	is(value: unknown): value is Status;
}

const informationalValues = [100, 101, 102, 103] as const;
const successValues = [200, 201, 202, 203, 204, 205, 206, 207, 208, 226] as const;
const redirectValues = [300, 301, 302, 303, 304, 305, 306, 307, 308] as const;
const clientErrorValues = [
	400, 401, 402, 403, 404, 405, 406, 407, 408, 409, 410, 411, 412, 413, 414, 415,
	416, 417, 418, 421, 422, 423, 424, 425, 426, 428, 429, 431, 451,
] as const;
const serverErrorValues = [500, 501, 502, 503, 504, 505, 506, 507, 508, 510, 511] as const;
const contentlessValues = [101, 204, 205, 304] as const;

/** Informational status schema. */
export const informational = createStatusSchema(informationalValues);
/** Successful status schema. */
export const success = createStatusSchema(successValues);
/** Redirect status schema. */
export const redirect = createStatusSchema(redirectValues);
/** Client-error status schema. */
export const clientError = createStatusSchema(clientErrorValues);
/** Server-error status schema. */
export const serverError = createStatusSchema(serverErrorValues);
/** RFC problem status schema. */
export const problem = createStatusSchema([...clientErrorValues, ...serverErrorValues] as const);
/** Contentless status schema. */
export const contentless = createStatusSchema(contentlessValues);
/** Contentful status schema. */
export const contentful = createStatusSchema(
	[...informationalValues, ...successValues, ...redirectValues, ...clientErrorValues, ...serverErrorValues]
		.filter((value) => !contentlessValues.includes(value as ContentlessStatus)) as ContentfulStatus[],
);
/** All recognized HTTP statuses. */
export const any = createStatusSchema([
	...informationalValues,
	...successValues,
	...redirectValues,
	...clientErrorValues,
	...serverErrorValues,
] as const);

/** Return whether a value is any recognized HTTP status. */
export function is(value: unknown): value is HttpStatus {
	return any.is(value);
}

/** Return whether a value is valid for an RFC problem response. */
export function isProblem(value: unknown): value is ProblemStatus {
	return problem.is(value);
}

/** Return whether the status semantics prohibit a message body. */
export function isContentless(value: unknown): value is ContentlessStatus {
	return contentless.is(value);
}

/**
 * Creates status schema while preserving the module's ownership rules.
 *
 * It builds deterministic logical HTTP representations before a framework creates the native Response.
 *
 * @internal
 */
function createStatusSchema<const Values extends readonly number[]>(values: Values): HttpStatusSchema<Values[number]> {
	const frozen = Object.freeze([...new Set(values)]) as readonly Values[number][];
	const allowed = new Set<number>(frozen);
	return Object.freeze({
		values: frozen,
		'~standard': Object.freeze({
			version: 1 as const,
			vendor: 'kaiju',
			/**
			 * Checks state and preserves the deterministic issues needed by callers.
			 *
			 * @internal
			 */
			validate(value: unknown) {
				return typeof value === 'number' && Number.isInteger(value) && allowed.has(value)
					? { value: value as Values[number] }
					: { issues: [{ message: `Expected one of the supported HTTP statuses: ${frozen.join(', ')}.` }] };
			},
		}),
		'~standard-json-schema': Object.freeze({
			version: 1 as const,
			vendor: 'kaiju' as const,
			jsonSchema: Object.freeze({ type: 'integer' as const, enum: frozen }),
		}),
		/**
		 * Checks whether the value satisfies the condition required by logical HTTP response construction.
		 *
		 * @internal
		 */
		is(value: unknown): value is Values[number] {
			return typeof value === 'number' && Number.isInteger(value) && allowed.has(value);
		},
	});
}
