import type { StandardSchemaV1 } from '@standard-schema/spec';

import type { RequestIssue, RequestIssueCode } from './types.ts';

/** Request location whose wire or schema validation produced an issue. */
export type RequestInputSource =
	| 'param'
	| 'query'
	| 'header'
	| 'cookie'
	| 'json'
	| 'form'
	| 'raw';

/**
 * Stable, value-free validation detail suitable for RFC problem extensions,
 * diagnostics, tests, and structured logging.
 */
export interface RequestValidationDetail {
	readonly source: RequestInputSource;
	readonly code: RequestIssueCode | 'invalid-value' | string;
	readonly message: string;
	readonly path: readonly PropertyKey[];
	readonly location: string;
	readonly field?: string;
}

/**
 * Normalize transport and Standard Schema issues without copying rejected
 * request values into diagnostics.
 */
export function validationDetails(
	source: RequestInputSource,
	issues: readonly (RequestIssue | StandardSchemaV1.Issue)[],
): readonly RequestValidationDetail[] {
	return Object.freeze(issues.map((issue) => validationDetail(source, issue)));
}

/** Normalize one transport or Standard Schema issue. */
export function validationDetail(
	source: RequestInputSource,
	issue: RequestIssue | StandardSchemaV1.Issue,
): RequestValidationDetail {
	const path = normalizePath(issue.path);
	const last = path.at(-1);
	return Object.freeze({
		source,
		code: 'code' in issue && typeof issue.code === 'string' ? issue.code : 'invalid-value',
		message: issue.message,
		path,
		location: `${source}${formatPath(path)}`,
		...(last === undefined ? {} : { field: String(last) }),
	});
}

/** Convert a Standard Schema path into ordinary property keys. */
export function normalizePath(
	path: StandardSchemaV1.Issue['path'] | RequestIssue['path'],
): readonly PropertyKey[] {
	if (path === undefined) return Object.freeze([]);
	return Object.freeze(path.map((segment) => {
		if (typeof segment === 'object' && segment !== null && 'key' in segment) return segment.key;
		return segment;
	}));
}

/** Format a normalized path without rendering any request value. */
export function formatPath(path: readonly PropertyKey[]): string {
	return path.map((segment) => {
		if (typeof segment === 'number') return `[${segment}]`;
		const value = String(segment);
		return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value)
			? `.${value}`
			: `[${JSON.stringify(value)}]`;
	}).join('');
}
