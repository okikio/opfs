import type { CsvDiagnostic, CsvEncoding, CsvLineEnding, ParseCsvOptions } from './types.ts'

const UTF8_BOM = new Uint8Array([0xef, 0xbb, 0xbf])

/** Decoded source plus metadata required by the structural parser. */
export interface DecodedCsvSource {
	text: string
	encoding: CsvEncoding
	lineEnding: CsvLineEnding
	diagnostics: readonly CsvDiagnostic[]
}

/**
 * Checks whether the input starts with utf8 bom before bounded CSV parsing decodes it.
 *
 * @internal
 */
function startsWithUtf8Bom(bytes: Uint8Array): boolean {
	return bytes.length >= UTF8_BOM.length && UTF8_BOM.every((byte, index) => bytes[index] === byte)
}

/**
 * Detects the line ending used by bounded CSV parsing.
 *
 * CSV internals preserve streaming and diagnostics so import code can reject malformed or oversized input without materializing unbounded data.
 *
 * @internal
 */
function detectLineEnding(text: string): CsvLineEnding {
	const crlf = text.match(/\r\n/g)?.length ?? 0
	const withoutCrlf = text.replace(/\r\n/g, '')
	const lf = withoutCrlf.match(/\n/g)?.length ?? 0
	const cr = withoutCrlf.match(/\r/g)?.length ?? 0
	const kinds = Number(crlf > 0) + Number(lf > 0) + Number(cr > 0)

	if (kinds === 0) return 'none'
	if (kinds > 1) return 'mixed'
	if (crlf > 0) return 'crlf'
	if (lf > 0) return 'lf'
	return 'cr'
}

/** Decodes original bytes while preserving whether a legacy fallback was required. */
export function decodeCsvBytes(
	bytes: Uint8Array,
	encoding: NonNullable<ParseCsvOptions['encoding']> = 'auto',
): DecodedCsvSource {
	const hasBom = startsWithUtf8Bom(bytes)
	const body = hasBom ? bytes.subarray(UTF8_BOM.length) : bytes
	const diagnostics: CsvDiagnostic[] = []
	let text: string
	let selected: CsvEncoding

	if (encoding === 'windows-1252') {
		text = new TextDecoder('windows-1252').decode(body)
		selected = 'windows-1252'
	} else if (encoding === 'utf-8') {
		text = new TextDecoder('utf-8', { fatal: true }).decode(body)
		selected = hasBom ? 'utf-8-bom' : 'utf-8'
	} else {
		try {
			text = new TextDecoder('utf-8', { fatal: true }).decode(body)
			selected = hasBom ? 'utf-8-bom' : 'utf-8'
		} catch {
			text = new TextDecoder('windows-1252').decode(body)
			selected = 'windows-1252'
			diagnostics.push({
				code: 'legacy-encoding',
				message: 'The source was not valid UTF-8 and was decoded as Windows-1252.',
			})
		}
	}

	return { text, encoding: selected, lineEnding: detectLineEnding(text), diagnostics }
}

/** Wraps caller-decoded text in the same source contract as byte input. */
export function decodeCsvText(text: string): DecodedCsvSource {
	const hasBom = text.startsWith('\ufeff')
	const value = hasBom ? text.slice(1) : text
	return {
		text: value,
		encoding: hasBom ? 'utf-8-bom' : 'utf-8',
		lineEnding: detectLineEnding(value),
		diagnostics: [],
	}
}
