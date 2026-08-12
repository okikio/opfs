import * as catalog from '@utils/catalog';
import type { Catalog, CatalogSelection } from '@utils/catalog';
import type { ProblemDefinition } from '../types.ts';

/** Coverage summary for one problem catalog or selection. */
export interface ProblemCoverageReport {
	readonly declared: number;
	readonly covered: number;
	readonly missing: readonly string[];
	readonly extra: readonly string[];
}

/** Error raised before registration when behavioral coverage is not exhaustive. */
export class ProblemCoverageError extends Error {
	readonly report: ProblemCoverageReport;

	constructor(report: ProblemCoverageReport) {
		const details = [
			report.missing.length > 0 ? `missing: ${report.missing.join(', ')}` : undefined,
			report.extra.length > 0 ? `extra: ${report.extra.join(', ')}` : undefined,
		].filter((value): value is string => value !== undefined).join('; ');
		super(`Problem coverage is not exhaustive${details.length > 0 ? ` (${details})` : ''}.`);
		this.name = 'ProblemCoverageError';
		this.report = report;
	}
}

/**
 * Verify and register exhaustive behavioral coverage for one problem universe.
 *
 * Registration functions are invoked in source-catalog order only after the
 * runtime key set is exact. This prevents a malformed JavaScript caller from
 * registering a partial suite before the defect is reported.
 */
export function coverage<
	Entry extends ProblemDefinition,
	const Entries extends Readonly<Record<PropertyKey, Entry>>,
>(
	universe: Catalog<Entry, Entries> | CatalogSelection<Entry, Entries>,
	registrations: { readonly [Key in keyof Entries]: () => void },
): ProblemCoverageReport {
	const metadata = catalog.metadata(universe);
	const declared = [...metadata.keys];
	const registered = Object.keys(registrations);
	const missing = declared.filter((key) => typeof registrations[key] !== 'function');
	const extra = registered.filter((key) => !declared.includes(key));
	const report = Object.freeze({
		declared: declared.length,
		covered: declared.length - missing.length,
		missing: Object.freeze(missing),
		extra: Object.freeze(extra),
	});

	if (missing.length > 0 || extra.length > 0) throw new ProblemCoverageError(report);
	for (const key of declared) registrations[key]!();
	return report;
}
