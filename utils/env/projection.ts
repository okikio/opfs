import type {
	EnvironmentDefinition,
	EnvironmentManifest,
	EnvironmentManifestField,
	EnvironmentRequirement,
	EnvironmentRequirementReportField,
} from './types.ts';

/**
 * Project a definition into deterministic variable and secret collections.
 *
 * Projection is explicit so the runtime definition can retain concrete schemas
 * without pretending that schemas themselves are deployment manifests.
 */
export function manifest(definition: EnvironmentDefinition): EnvironmentManifest {
	const fields = definition.keys.map<EnvironmentManifestField>((key) => ({
		key,
		kind: definition.fields[key]!.kind,
		...definition.fields[key]!.metadata,
	})).toSorted((left, right) => left.key.localeCompare(right.key));

	return {
		version: 1,
		variables: fields.filter((field) => field.kind === 'variable'),
		secrets: fields.filter((field) => field.kind === 'secret'),
	};
}

/**
 * Render a safe `.env.example` template from a definition.
 *
 * Ordinary variables may include a safe example. Secrets always use the
 * literal `<secret>` placeholder and never project schema metadata as a value.
 */
export function example(definition: EnvironmentDefinition): string {
	const projection = manifest(definition);
	const fields = [...projection.variables, ...projection.secrets]
		.toSorted((left, right) => left.key.localeCompare(right.key));

	return `${fields.map((field) => {
		const comments = [
			field.title,
			field.description,
			field.documentationUrl ? `Documentation: ${field.documentationUrl}` : undefined,
		].filter((value): value is string => Boolean(value))
			.flatMap((value) => value.split('\n'))
			.map((line) => `# ${line}`).join('\n');
		const value = field.kind === 'secret' ? '<secret>' : field.example ?? '';
		return `${comments}\n${field.key}=${value}`;
	}).join('\n\n')}\n`;
}

/**
 * Combine field metadata with requirements that reference the same field.
 *
 * Both the key and canonical object identity must match. This prevents a
 * requirement from another service from being attached merely because it uses
 * a common key such as `DATABASE_URL`.
 */
export function requirementReport(
	definition: EnvironmentDefinition,
	requirements: readonly EnvironmentRequirement[],
): readonly EnvironmentRequirementReportField[] {
	const projection = manifest(definition);
	return [...projection.variables, ...projection.secrets].map((field) => ({
		...field,
		requiredBy: requirements.flatMap((current) =>
			current.fields.flatMap((selected) =>
				selected.key === field.key && definition.fields[field.key] === selected.field
					? [{ requirementId: current.id, reason: selected.reason }]
					: []
			)
		),
	})).toSorted((left, right) => left.key.localeCompare(right.key));
}
