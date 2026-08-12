import { parse } from '@std/csv/parse'

import { rankCsvDelimiters } from './dialect.ts'
import { decodeCsvBytes, decodeCsvText, type DecodedCsvSource } from './encoding.ts'
import { createCsvHeaderClassifier, normalizeCsvHeader } from './headers.ts'
import {
	CsvParseError,
	type CsvColumn,
	type CsvDelimiter,
	type CsvDiagnostic,
	type CsvDocument,
	type CsvRow,
	type ParseCsvOptions,
} from './types.ts'

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024
const DEFAULT_MAX_CHARACTERS = 64 * 1024 * 1024
const DEFAULT_MAX_ROWS = 1_000_000
const DEFAULT_MAX_COLUMNS = 512
const DEFAULT_MAX_CELL_LENGTH = 1_000_000
const DEFAULT_HEADER_SCAN_LIMIT = 25
const HEADER_CONSISTENCY_ROWS = 50

/**
 * Resolves limit from already validated module inputs.
 *
 * @internal
 */
function resolveLimit(value: number | undefined, fallback: number, name: string): number {
	if (value === undefined) return fallback
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new RangeError(`${name} must be a positive safe integer.`)
	}
	return value
}

/**
 * Checks whether blank row satisfies the condition required by bounded CSV parsing.
 *
 * @internal
 */
function isBlankRow(row: readonly string[]): boolean {
	return row.length === 0 || row.every((value) => value.trim().length === 0)
}

/**
 * Parses records into the validated internal model used by later phases.
 *
 * @internal
 */
function parseRecords(text: string, delimiter: CsvDelimiter): string[][] {
	try {
		return parse(text, { separator: delimiter, fieldsPerRecord: -1 }) as string[][]
	} catch (cause) {
		throw new CsvParseError(
			'invalid-csv',
			cause instanceof Error ? `Invalid CSV: ${cause.message}` : 'Invalid CSV input.',
		)
	}
}

/**
 * Parses using dialect into the validated internal model used by later phases.
 *
 * It keeps CSV discovery and parsing bounded while preserving diagnostics that higher-level import code can act on.
 *
 * @internal
 */
function parseUsingDialect(text: string, requested: ParseCsvOptions['delimiter']): {
	delimiter: CsvDelimiter
	records: string[][]
} {
	const candidates = requested && requested !== 'auto' ? [requested] : rankCsvDelimiters(text)
	let lastError: CsvParseError | undefined

	for (const delimiter of candidates) {
		try {
			const records = parseRecords(text, delimiter)
			if (records.some((record) => record.length > 1)) return { delimiter, records }
		} catch (cause) {
			if (cause instanceof CsvParseError) lastError = cause
		}
	}

	throw lastError ?? new CsvParseError(
		'invalid-csv',
		'The source is not a valid comma-, semicolon-, or tab-delimited document.',
	)
}

/**
 * Returns the looks like header value in the representation expected by bounded CSV parsing.
 *
 * @internal
 */
function looksLikeHeaderValue(value: string): boolean {
	const normalized = value.trim()
	if (!normalized || normalized.length > 160) return false
	if (/https?:\/\//i.test(normalized) || /\S+@\S+/.test(normalized)) return false
	return /[\p{L}_]/u.test(normalized)
}

/**
 * Selects or builds the score header used by bounded CSV parsing.
 *
 * CSV internals preserve streaming and diagnostics so import code can reject malformed or oversized input without materializing unbounded data.
 *
 * @internal
 */
function scoreHeader(
	records: readonly (readonly string[])[],
	index: number,
	classifyHeader: (header: string) => import('./types.ts').CsvColumnRole,
): number {
	const row = records[index]
	if (!row) return Number.NEGATIVE_INFINITY
	const nonEmpty = row.filter((value) => value.trim().length > 0)
	if (nonEmpty.length < 2) return Number.NEGATIVE_INFINITY

	const recognized = row.filter((value) => classifyHeader(value) !== 'unknown').length
	const textLike = row.filter(looksLikeHeaderValue).length
	const normalized = nonEmpty.map(normalizeCsvHeader)
	const duplicates = normalized.length - new Set(normalized).size
	const following = records
		.slice(index + 1, index + 1 + HEADER_CONSISTENCY_ROWS)
		.filter((candidate) => !isBlankRow(candidate))
	const consistent = following.length === 0
		? 0
		: following.filter((candidate) => candidate.length === row.length).length / following.length

	return recognized * 100 + textLike * 4 + consistent * 30 + Math.min(row.length, 40) - duplicates * 3 - index
}

/**
 * Selects header needed by bounded CSV parsing without changing the source definition.
 *
 * CSV internals preserve streaming and diagnostics so import code can reject malformed or oversized input without materializing unbounded data.
 *
 * @internal
 */
function selectHeader(
	records: readonly (readonly string[])[],
	options: ParseCsvOptions,
	classifyHeader: (header: string) => import('./types.ts').CsvColumnRole,
): number {
	if (typeof options.headerRow === 'number') {
		if (!Number.isInteger(options.headerRow) || options.headerRow < 1 || options.headerRow > records.length) {
			throw new CsvParseError('invalid-header-row', 'The configured header row is outside the parsed document.')
		}
		return options.headerRow - 1
	}

	const scanLimit = resolveLimit(options.headerScanLimit, DEFAULT_HEADER_SCAN_LIMIT, 'headerScanLimit')
	const limit = Math.min(records.length, scanLimit)
	let selected = -1
	let selectedScore = Number.NEGATIVE_INFINITY
	for (let index = 0; index < limit; index += 1) {
		const score = scoreHeader(records, index, classifyHeader)
		if (score > selectedScore) {
			selected = index
			selectedScore = score
		}
	}
	if (selected < 0 || !Number.isFinite(selectedScore)) {
		throw new CsvParseError('missing-header', 'The CSV document does not contain a usable header row.')
	}
	return selected
}

/**
 * Builds columns from validated inputs without changing source identity.
 *
 * It keeps CSV discovery and parsing bounded while preserving diagnostics that higher-level import code can act on.
 *
 * @internal
 */
function buildColumns(
	headers: readonly string[],
	classifyHeader: (header: string) => import('./types.ts').CsvColumnRole,
	diagnostics: CsvDiagnostic[],
): readonly CsvColumn[] {
	const occurrences = new Map<string, number>()

	return Object.freeze(headers.map((source, index) => {
		const name = source.replace(/^\ufeff/, '').trim()
		const normalizedName = normalizeCsvHeader(name)
		const baseKey = normalizedName || `column_${index + 1}`
		const occurrence = (occurrences.get(baseKey) ?? 0) + 1
		occurrences.set(baseKey, occurrence)

		if (!name) {
			diagnostics.push({
				code: 'blank-header',
				message: `Column ${index + 1} has no header and was assigned “${baseKey}”.`,
				column: index + 1,
			})
		} else if (occurrence > 1) {
			diagnostics.push({
				code: 'duplicate-header',
				message: `Header “${name}” appears more than once.`,
				column: index + 1,
				header: name,
			})
		}

		return Object.freeze({
			index,
			name: name || `Column ${index + 1}`,
			key: occurrence === 1 ? baseKey : `${baseKey}__${occurrence}`,
			normalizedName,
			role: classifyHeader(name),
		})
	}))
}

/**
 * Checks cell and preserves the deterministic issues needed by callers.
 *
 * It keeps CSV discovery and parsing bounded while preserving diagnostics that higher-level import code can act on.
 *
 * @internal
 */
function validateCell(
	value: string,
	row: number,
	column: number,
	maxCellLength: number,
	diagnostics: CsvDiagnostic[],
): void {
	if (value.length > maxCellLength) {
		throw new CsvParseError(
			'cell-too-large',
			`Cell ${row}:${column} exceeds the configured ${maxCellLength.toLocaleString()} character limit.`,
			row,
			column,
		)
	}
	if (/^[=+@]/.test(value) || /^-(?!\d+(?:\.\d+)?$)/.test(value)) {
		diagnostics.push({
			code: 'spreadsheet-formula',
			message: `Cell ${row}:${column} begins with a spreadsheet formula marker and was preserved as text.`,
			row,
			column,
		})
	}
}

/**
 * Parses decoded into the validated internal model used by later phases.
 *
 * It keeps CSV discovery and parsing bounded while preserving diagnostics that higher-level import code can act on.
 *
 * @internal
 */
function parseDecoded(source: DecodedCsvSource, options: ParseCsvOptions): CsvDocument {
	if (source.text.length === 0) throw new CsvParseError('empty-file', 'The CSV file is empty.')

	const maxCharacters = resolveLimit(options.maxCharacters, DEFAULT_MAX_CHARACTERS, 'maxCharacters')
	if (source.text.length > maxCharacters) {
		throw new CsvParseError(
			'source-too-large',
			`The decoded CSV source exceeds the configured ${maxCharacters.toLocaleString()} character limit.`,
		)
	}

	const { delimiter, records } = parseUsingDialect(source.text, options.delimiter ?? 'auto')
	const classifyHeader = createCsvHeaderClassifier(options.headerAliases)
	const headerIndex = selectHeader(records, options, classifyHeader)
	const header = records[headerIndex]
	if (!header || header.every((value) => value.trim().length === 0)) {
		throw new CsvParseError('missing-header', 'The CSV document does not contain a usable header row.')
	}

	const maxColumns = resolveLimit(options.maxColumns, DEFAULT_MAX_COLUMNS, 'maxColumns')
	if (header.length > maxColumns) {
		throw new CsvParseError(
			'too-many-columns',
			`The CSV contains ${header.length} columns; the configured limit is ${maxColumns}.`,
		)
	}

	const diagnostics = [...source.diagnostics]
	if (headerIndex > 0) {
		diagnostics.push({
			code: 'preamble-skipped',
			message: `${headerIndex} logical record(s) were skipped before the selected header.`,
		})
	}

	const columns = buildColumns(header, classifyHeader, diagnostics)
	const maxRows = resolveLimit(options.maxRows, DEFAULT_MAX_ROWS, 'maxRows')
	const maxCellLength = resolveLimit(options.maxCellLength, DEFAULT_MAX_CELL_LENGTH, 'maxCellLength')
	const rows: CsvRow[] = []

	for (let index = headerIndex + 1; index < records.length; index += 1) {
		const values = records[index] ?? []
		if (isBlankRow(values)) continue
		if (rows.length >= maxRows) {
			throw new CsvParseError('too-many-rows', `The CSV exceeds the configured ${maxRows.toLocaleString()} row limit.`)
		}

		const row = index + 1
		const rowDiagnostics: CsvDiagnostic[] = []
		if (values.length > maxColumns) {
			throw new CsvParseError(
				'too-many-columns',
				`Row ${row} contains ${values.length} columns; the configured limit is ${maxColumns}.`,
				row,
			)
		}
		if (values.length !== columns.length) {
			rowDiagnostics.push({
				code: 'row-width-mismatch',
				message: `Row ${row} has ${values.length} fields; the header has ${columns.length}.`,
				row,
			})
		}
		for (let column = 0; column < values.length; column += 1) {
			validateCell(values[column] ?? '', row, column + 1, maxCellLength, rowDiagnostics)
		}
		const frozenRowDiagnostics = Object.freeze(rowDiagnostics.map((diagnostic) => Object.freeze(diagnostic)))
		diagnostics.push(...frozenRowDiagnostics)
		rows.push(Object.freeze({
			row,
			values: Object.freeze([...values]),
			diagnostics: frozenRowDiagnostics,
		}))
	}

	if (rows.length === 0) {
		diagnostics.push({ code: 'header-only', message: 'The CSV contains a header but no data rows.' })
	}

	return Object.freeze({
		...(options.fileName ? { fileName: options.fileName } : {}),
		encoding: source.encoding,
		delimiter,
		lineEnding: source.lineEnding,
		headerRow: headerIndex + 1,
		columns,
		rows: Object.freeze(rows),
		preamble: Object.freeze(records.slice(0, headerIndex).map((record) => Object.freeze([...record]))),
		diagnostics: Object.freeze(diagnostics.map((diagnostic) => Object.freeze(diagnostic))),
	})
}

/**
 * Parses decoded CSV text without coercing identifiers, dates, numbers, or formulas.
 *
 * @example
 * ```ts
 * const document = parseCsv('Company,Website\nNorthstar,https://northstar.example')
 * console.log(document.columns[1]?.role) // "website"
 * ```
 */
export function parseCsv(text: string, options: ParseCsvOptions = {}): CsvDocument {
	return parseDecoded(decodeCsvText(text), options)
}

/** Parses original CSV bytes with strict UTF-8 detection and bounded structural limits. */
export function parseCsvBytes(bytes: Uint8Array, options: ParseCsvOptions = {}): CsvDocument {
	const maxBytes = resolveLimit(options.maxBytes, DEFAULT_MAX_BYTES, 'maxBytes')
	if (bytes.byteLength > maxBytes) {
		throw new CsvParseError(
			'source-too-large',
			`The CSV source exceeds the configured ${maxBytes.toLocaleString()} byte limit.`,
		)
	}
	return parseDecoded(decodeCsvBytes(bytes, options.encoding ?? 'auto'), options)
}
