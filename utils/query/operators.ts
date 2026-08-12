import type { QueryOperator, QueryOperatorName } from './types.ts';

/**
 * Maps the operator into the representation understood by provider-neutral query definitions.
 *
 * @internal
 */
function operator<const Name extends QueryOperatorName>(
	name: Name,
	value: QueryOperator<Name>['value'],
	description: string,
): QueryOperator<Name> {
	return Object.freeze({ kind: 'query-operator', id: `query:${name}`, name, value, description });
}

/** Equality filter. */
export const eq = operator('eq', 'one', 'Equals the supplied value.');
/** Inequality filter. */
export const ne = operator('ne', 'one', 'Does not equal the supplied value.');
/** Greater-than filter. */
export const gt = operator('gt', 'one', 'Is greater than the supplied value.');
/** Greater-than-or-equal filter. */
export const gte = operator('gte', 'one', 'Is greater than or equal to the supplied value.');
/** Less-than filter. */
export const lt = operator('lt', 'one', 'Is less than the supplied value.');
/** Less-than-or-equal filter. */
export const lte = operator('lte', 'one', 'Is less than or equal to the supplied value.');
/** Inclusive pair/range filter. */
export const between = operator('between', 'pair', 'Falls between the supplied pair of values.');
/** Set-membership filter. */
export const inArray = operator('in', 'many', 'Matches one of the supplied values.');
/** Set-exclusion filter. */
export const notInArray = operator('nin', 'many', 'Does not match any supplied value.');
/** Case-sensitive substring filter. */
export const contains = operator('contains', 'one', 'Contains the supplied value.');
/** Case-insensitive substring filter. */
export const icontains = operator('icontains', 'one', 'Contains the supplied value ignoring case.');
/** Prefix filter. */
export const startsWith = operator('startsWith', 'one', 'Starts with the supplied value.');
/** Suffix filter. */
export const endsWith = operator('endsWith', 'one', 'Ends with the supplied value.');
/** Null check. */
export const isNull = operator('isNull', 'none', 'Has a null value.');
/** Non-null check. */
export const isNotNull = operator('isNotNull', 'none', 'Has a non-null value.');

/** Alias using the handbook spelling. */
export { inArray as in };
/** Explicit readable alias for `nin`. */
export { notInArray as nin };
