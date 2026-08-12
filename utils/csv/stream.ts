import { CsvParseStream } from '@std/csv/parse-stream'

import { rankCsvDelimiters } from './dialect.ts'
import { decodeCsvBytes } from './encoding.ts'
import { createCsvHeaderClassifier, normalizeCsvHeader } from './headers.ts'
import {
	CsvParseError,
	type CsvColumn,
	type CsvDelimiter,
	type CsvDiagnostic,
	type CsvRow,
	type CsvStreamDocument,
	type ParseCsvStreamOptions,
} from './types.ts'

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024
const DEFAULT_PEEK_BYTES = 256 * 1024
const DEFAULT_HEADER_SCAN_LIMIT = 25
const DEFAULT_MAX_COLUMNS = 512
const DEFAULT_MAX_ROWS = 1_000_000
const DEFAULT_MAX_CELL_LENGTH = 1_000_000

interface PeekedStream {
	readonly prefix: Uint8Array
	readonly reader: ReadableStreamDefaultReader<Uint8Array>
	readonly tail?: Uint8Array
	readonly done: boolean
}

/**
 * Resolves limit from already validated module inputs.
 *
 * @internal
 */
function resolveLimit(value: number | undefined, fallback: number, name: string): number {
	if (value === undefined) return fallback
	if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer.`)
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
 * Reads a bounded prefix without losing bytes needed by later consumers of bounded CSV parsing.
 *
 * CSV internals preserve streaming and diagnostics so import code can reject malformed or oversized input without materializing unbounded data.
 *
 * @internal
 */
async function peekStream(source: ReadableStream<Uint8Array>, limit: number): Promise<PeekedStream> {
	const reader = source.getReader()
	const chunks: Uint8Array[] = []
	let length = 0
	let done = false
	try {
		while (length < limit) {
			const result = await reader.read()
			if (result.done) {
				done = true
				break
			}
			const remaining = limit - length
			if (result.value.byteLength <= remaining) {
				chunks.push(result.value)
				length += result.value.byteLength
				continue
			}
			chunks.push(result.value.subarray(0, remaining))
			length += remaining
			return Object.freeze({
				prefix: concatenateBytes(chunks, length),
				reader,
				tail: result.value.subarray(remaining),
				done: false,
			})
		}
		return Object.freeze({ prefix: concatenateBytes(chunks, length), reader, done })
	} catch (error) {
		await reader.cancel(error).catch(() => undefined)
		throw error
	}
}

/**
 * Concatenates the bytes into one bounded value for bounded CSV parsing.
 *
 * @internal
 */
function concatenateBytes(chunks: readonly Uint8Array[], length: number): Uint8Array {
	const output = new Uint8Array(length)
	let offset = 0
	for (const chunk of chunks) {
		output.set(chunk, offset)
		offset += chunk.byteLength
	}
	return output
}

/**
 * Replays the buffered prefix before continuing the original stream in bounded CSV parsing.
 *
 * CSV internals preserve streaming and diagnostics so import code can reject malformed or oversized input without materializing unbounded data.
 *
 * @internal
 */
function replayStream(peeked: PeekedStream): ReadableStream<Uint8Array> {
	let prefixPending = peeked.prefix.byteLength > 0
	let tail = peeked.tail
	return new ReadableStream<Uint8Array>({
		/**
		 * Pulls the next value only when bounded CSV parsing is ready to accept it.
		 *
		 * CSV internals preserve streaming and diagnostics so import code can reject malformed or oversized input without materializing unbounded data.
		 *
		 * @internal
		 */
		async pull(controller) {
			if (prefixPending) {
				prefixPending = false
				controller.enqueue(peeked.prefix)
				if (peeked.done) controller.close()
				return
			}
			if (tail !== undefined) {
				const value = tail
				tail = undefined
				controller.enqueue(value)
				return
			}
			const result = await peeked.reader.read()
			if (result.done) controller.close()
			else controller.enqueue(result.value)
		},
		cancel: async (reason) => await peeked.reader.cancel(reason),
	})
}

/**
 * Enforces the byte limit before bounded CSV parsing admits more data.
 *
 * CSV internals preserve streaming and diagnostics so import code can reject malformed or oversized input without materializing unbounded data.
 *
 * @internal
 */
function byteLimit(maxBytes: number): TransformStream<Uint8Array, Uint8Array> {
	let total = 0
	return new TransformStream({
		/**
		 * Transforms data through the transform step used by bounded CSV parsing.
		 *
		 * @internal
		 */
		transform(chunk, controller) {
			total += chunk.byteLength
			if (total > maxBytes) {
				throw new CsvParseError(
					'source-too-large',
					`The CSV source exceeds the configured ${maxBytes.toLocaleString()} byte limit.`,
				)
			}
			controller.enqueue(chunk)
		},
	})
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
	classifyHeader: ReturnType<typeof createCsvHeaderClassifier>,
	diagnostics: CsvDiagnostic[],
): readonly CsvColumn[] {
	const occurrences = new Map<string, number>()
	return Object.freeze(headers.map((source, index) => {
		const name = source.replace(/^\ufeff/, '').trim()
		const normalizedName = normalizeCsvHeader(name)
		const baseKey = normalizedName || `column_${index + 1}`
		const occurrence = (occurrences.get(baseKey) ?? 0) + 1
		occurrences.set(baseKey, occurrence)
		if (!name) diagnostics.push(Object.freeze({ code: 'blank-header', message: `Column ${index + 1} has no header.`, column: index + 1 }))
		if (occurrence > 1) diagnostics.push(Object.freeze({ code: 'duplicate-header', message: `Header “${name}” appears more than once.`, column: index + 1, header: name }))
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
 * Selects or builds the score header used by bounded CSV parsing.
 *
 * CSV internals preserve streaming and diagnostics so import code can reject malformed or oversized input without materializing unbounded data.
 *
 * @internal
 */
function scoreHeader(
	records: readonly (readonly string[])[],
	index: number,
	classifyHeader: ReturnType<typeof createCsvHeaderClassifier>,
): number {
	const row = records[index]
	if (!row) return Number.NEGATIVE_INFINITY
	const nonEmpty = row.filter((value) => value.trim())
	if (nonEmpty.length < 2) return Number.NEGATIVE_INFINITY
	const recognized = row.filter((value) => classifyHeader(value) !== 'unknown').length
	const textLike = row.filter((value) => /[\p{L}_]/u.test(value) && !/https?:\/\/|\S+@\S+/i.test(value)).length
	const following = records.slice(index + 1).filter((record) => !isBlankRow(record))
	const consistent = following.length === 0 ? 0 : following.filter((record) => record.length === row.length).length / following.length
	return recognized * 100 + textLike * 4 + consistent * 30 - index
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
	options: ParseCsvStreamOptions,
	classifyHeader: ReturnType<typeof createCsvHeaderClassifier>,
): number {
	if (typeof options.headerRow === 'number') {
		if (!Number.isSafeInteger(options.headerRow) || options.headerRow < 1) {
			throw new CsvParseError('invalid-header-row', 'The configured header row must be a positive integer.')
		}
		const index = options.headerRow - 1
		if (index >= records.length) throw new CsvParseError('invalid-header-row', 'The configured header row is outside the bounded discovery window.')
		return index
	}
	let selected = -1
	let score = Number.NEGATIVE_INFINITY
	for (let index = 0; index < records.length; index += 1) {
		const candidate = scoreHeader(records, index, classifyHeader)
		if (candidate > score) {
			selected = index
			score = candidate
		}
	}
	if (selected < 0 || !Number.isFinite(score)) throw new CsvParseError('missing-header', 'The CSV document does not contain a usable header row.')
	return selected
}

/**
 * Creates row while preserving the module's ownership rules.
 *
 * It keeps CSV discovery and parsing bounded while preserving diagnostics that higher-level import code can act on.
 *
 * @internal
 */
function createRow(
	values: readonly string[],
	logicalRow: number,
	columns: readonly CsvColumn[],
	maxColumns: number,
	maxCellLength: number,
): CsvRow {
	if (values.length > maxColumns) {
		throw new CsvParseError('too-many-columns', `Row ${logicalRow} contains ${values.length} columns; the limit is ${maxColumns}.`, logicalRow)
	}
	const diagnostics: CsvDiagnostic[] = []
	if (values.length !== columns.length) {
		diagnostics.push(Object.freeze({
			code: 'row-width-mismatch',
			message: `Row ${logicalRow} has ${values.length} fields; the header has ${columns.length}.`,
			row: logicalRow,
		}))
	}
	for (let index = 0; index < values.length; index += 1) {
		const value = values[index] ?? ''
		if (value.length > maxCellLength) {
			throw new CsvParseError('cell-too-large', `Cell ${logicalRow}:${index + 1} exceeds the configured character limit.`, logicalRow, index + 1)
		}
		if (/^[=+@]/.test(value) || /^-(?!\d+(?:\.\d+)?$)/.test(value)) {
			diagnostics.push(Object.freeze({
				code: 'spreadsheet-formula',
				message: `Cell ${logicalRow}:${index + 1} begins with a spreadsheet formula marker and was preserved as text.`,
				row: logicalRow,
				column: index + 1,
			}))
		}
	}
	return Object.freeze({
		row: logicalRow,
		values: Object.freeze([...values]),
		diagnostics: Object.freeze(diagnostics),
	})
}

/**
 * Parse a byte stream into one owned, one-shot, backpressure-aware CSV stream.
 *
 * The returned document must be consumed or disposed. Source bytes, rows,
 * columns, and cells are bounded by explicit limits.
 */
export async function parseCsvStream(
	source: ReadableStream<Uint8Array>,
	options: ParseCsvStreamOptions = {},
): Promise<CsvStreamDocument> {
	const maxBytes = resolveLimit(options.maxBytes, DEFAULT_MAX_BYTES, 'maxBytes')
	const peekBytes = Math.min(resolveLimit(options.peekBytes, DEFAULT_PEEK_BYTES, 'peekBytes'), maxBytes)
	const peeked = await peekStream(source, peekBytes)
	if (peeked.prefix.byteLength === 0) {
		await peeked.reader.cancel('Empty CSV source.').catch(() => undefined)
		throw new CsvParseError('empty-file', 'The CSV file is empty.')
	}

	const decoded = decodeCsvBytes(peeked.prefix, options.encoding ?? 'auto')
	const delimiter = options.delimiter && options.delimiter !== 'auto'
		? options.delimiter
		: rankCsvDelimiters(decoded.text)[0]
	if (!delimiter) {
		await peeked.reader.cancel('CSV delimiter detection failed.').catch(() => undefined)
		throw new CsvParseError('invalid-csv', 'Unable to detect a supported CSV delimiter.')
	}

	const encoding = decoded.encoding === 'windows-1252' ? 'windows-1252' : 'utf-8'
	const records = replayStream(peeked)
		.pipeThrough(byteLimit(maxBytes))
		.pipeThrough(createTextDecoderStream(encoding))
		.pipeThrough(new CsvParseStream({ separator: delimiter, fieldsPerRecord: -1 }))
	const recordReader = records.getReader()
	let disposed = false
	let rowsStarted = false

	try {
		const scanLimit = resolveLimit(options.headerScanLimit, DEFAULT_HEADER_SCAN_LIMIT, 'headerScanLimit')
		const discovery: string[][] = []
		while (discovery.length < scanLimit) {
			const next = await recordReader.read()
			if (next.done) break
			discovery.push(next.value)
		}
		const classifyHeader = createCsvHeaderClassifier(options.headerAliases)
		const headerIndex = selectHeader(discovery, options, classifyHeader)
		const header = discovery[headerIndex]
		if (!header) throw new CsvParseError('missing-header', 'The CSV document does not contain a usable header row.')
		const maxColumns = resolveLimit(options.maxColumns, DEFAULT_MAX_COLUMNS, 'maxColumns')
		if (header.length > maxColumns) throw new CsvParseError('too-many-columns', `The CSV contains ${header.length} columns; the limit is ${maxColumns}.`)
		const maxRows = resolveLimit(options.maxRows, DEFAULT_MAX_ROWS, 'maxRows')
		const maxCellLength = resolveLimit(options.maxCellLength, DEFAULT_MAX_CELL_LENGTH, 'maxCellLength')
		const diagnostics: CsvDiagnostic[] = [...decoded.diagnostics]
		if (headerIndex > 0) diagnostics.push(Object.freeze({ code: 'preamble-skipped', message: `${headerIndex} logical record(s) were skipped before the header.` }))
		const columns = buildColumns(header, classifyHeader, diagnostics)
		const buffered = discovery.slice(headerIndex + 1)

		/**
		 * Disposes owned state exactly once and releases all module-owned resources.
		 *
		 * @internal
		 */
		async function dispose(reason: unknown = 'CSV stream disposed.'): Promise<void> {
			if (disposed) return
			disposed = true
			await recordReader.cancel(reason).catch(() => undefined)
			recordReader.releaseLock()
		}

		/**
		 * Produces the row iterator that yields parsed CSV rows on demand in bounded CSV parsing.
		 *
		 * CSV internals preserve streaming and diagnostics so import code can reject malformed or oversized input without materializing unbounded data.
		 *
		 * @internal
		 */
		async function* rowIterator(): AsyncGenerator<CsvRow> {
			let logicalRow = headerIndex + 2
			let emitted = 0
			try {
				for (const values of buffered) {
					if (!isBlankRow(values)) {
						if (emitted >= maxRows) throw new CsvParseError('too-many-rows', `The CSV exceeds the configured ${maxRows.toLocaleString()} row limit.`)
						emitted += 1
						yield createRow(values, logicalRow, columns, maxColumns, maxCellLength)
					}
					logicalRow += 1
				}
				while (true) {
					const next = await recordReader.read()
					if (next.done) break
					if (!isBlankRow(next.value)) {
						if (emitted >= maxRows) throw new CsvParseError('too-many-rows', `The CSV exceeds the configured ${maxRows.toLocaleString()} row limit.`)
						emitted += 1
						yield createRow(next.value, logicalRow, columns, maxColumns, maxCellLength)
					}
					logicalRow += 1
				}
			} catch (error) {
				if (error instanceof CsvParseError) throw error
				throw new CsvParseError('invalid-csv', error instanceof Error ? `Invalid CSV: ${error.message}` : 'Invalid CSV input.')
			} finally {
				await dispose()
			}
		}

		let activeIterator: AsyncGenerator<CsvRow> | undefined
		const rows: AsyncIterable<CsvRow> = Object.freeze({
			/**
			 * Returns the native async iterator view used by streaming iteration protocols.
			 *
			 * @internal
			 */
			[Symbol.asyncIterator](): AsyncIterator<CsvRow> {
				if (disposed) throw new TypeError('CSV row stream is disposed.')
				if (rowsStarted) throw new TypeError('CSV row streams are one-shot.')
				rowsStarted = true
				activeIterator = rowIterator()
				return activeIterator
			},
		})
		return Object.freeze({
			...(options.fileName ? { fileName: options.fileName } : {}),
			encoding: decoded.encoding,
			delimiter,
			headerRow: headerIndex + 1,
			columns,
			preamble: Object.freeze(discovery.slice(0, headerIndex).map((row) => Object.freeze([...row]))),
			diagnostics: Object.freeze(diagnostics),
			rows,
			/**
			 * Releases owned state and waits for cleanup completion when used with `await using`.
			 *
			 * @internal
			 */
			async [Symbol.asyncDispose]() {
				await activeIterator?.return?.(undefined).catch(() => undefined)
				await dispose()
			},
		})
	} catch (error) {
		await recordReader.cancel(error).catch(() => undefined)
		recordReader.releaseLock()
		if (error instanceof CsvParseError) throw error
		throw new CsvParseError('invalid-csv', error instanceof Error ? `Invalid CSV: ${error.message}` : 'Invalid CSV input.')
	}
}

/**
 * Creates text decoder stream while preserving the module's ownership rules.
 *
 * It keeps CSV discovery and parsing bounded while preserving diagnostics that higher-level import code can act on.
 *
 * @internal
 */
function createTextDecoderStream(
	encoding: 'utf-8' | 'windows-1252',
): TransformStream<Uint8Array<ArrayBufferLike>, string> {
	const decoder = new TextDecoder(encoding)
	return new TransformStream<Uint8Array<ArrayBufferLike>, string>({
		/**
		 * Transforms data through the transform step used by bounded CSV parsing.
		 *
		 * @internal
		 */
		transform(chunk, controller) {
			const text = decoder.decode(chunk, { stream: true })
			if (text.length > 0) controller.enqueue(text)
		},
		/**
		 * Flushes buffered parser state when bounded CSV parsing reaches end of input.
		 *
		 * @internal
		 */
		flush(controller) {
			const text = decoder.decode()
			if (text.length > 0) controller.enqueue(text)
		},
	})
}
