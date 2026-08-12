import type { EnvironmentFieldMetadata, EnvironmentFieldMetadataInput } from './types.ts';

/**
 * Normalizes the optional string while preserving absence as `undefined` for environment definition and resolution.
 *
 * @internal
 */
function optionalString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * Normalizes the optional boolean while preserving absence as `undefined` for environment definition and resolution.
 *
 * @internal
 */
function optionalBoolean(value: unknown): boolean | undefined {
	return typeof value === 'boolean' ? value : undefined;
}

/**
 * Normalizes the optional strings while preserving absence as `undefined` for environment definition and resolution.
 *
 * @internal
 */
function optionalStrings(value: unknown): readonly string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const strings = value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
	return strings.length > 0 ? strings : undefined;
}

/**
 * Normalize native schema metadata and explicit environment overrides.
 *
 * Explicit environment metadata wins because a reusable schema can describe a
 * general value while one deployment binding has a narrower operational role.
 */
export function resolveMetadata(
	schemaMetadata: Readonly<Record<string, unknown>> | undefined,
	explicit: EnvironmentFieldMetadataInput | undefined,
	key?: string,
): EnvironmentFieldMetadata {
	const native = schemaMetadata ?? {};
	const nativeExamples = Array.isArray(native.examples) ? native.examples : undefined;
	const explicitRecord = explicit as Readonly<Record<string, unknown>> | undefined;
	const description = optionalString(explicit?.description) ?? optionalString(native.description);
	if (!description) {
		const suffix = key ? ` for ${key}` : '';
		throw new TypeError(
			`Environment field${suffix} requires a description. Add schema metadata or pass it to env.variable()/env.secret().`,
		);
	}

	const title = optionalString(explicit?.title) ?? optionalString(native.title);
	const example = optionalString(explicit?.example) ??
		optionalString(native.example) ??
		optionalString(nativeExamples?.[0]);
	const documentationUrl = optionalString(explicit?.documentationUrl) ?? optionalString(native.documentationUrl);
	const availability = optionalStrings(explicit?.availability) ?? optionalStrings(native.availability);
	const deprecated = optionalBoolean(explicitRecord?.deprecated) ?? optionalBoolean(native.deprecated);
	const replacement = optionalString(explicit?.replacement) ?? optionalString(native.replacement);

	return {
		...(title ? { title } : {}),
		description,
		...(example ? { example } : {}),
		...(documentationUrl ? { documentationUrl } : {}),
		...(availability ? { availability: [...availability] } : {}),
		...(deprecated !== undefined ? { deprecated } : {}),
		...(replacement ? { replacement } : {}),
	};
}
