import type { CsvDelimiter } from './types.ts'

const CANDIDATES: readonly CsvDelimiter[] = [',', ';', '	']
const DEFAULT_SAMPLE_BYTES = 128 * 1024
const DEFAULT_SAMPLE_ROWS = 100

interface DelimiterProfile {
	delimiter: CsvDelimiter
	counts: number[]
	score: number
}

/** Profiles a candidate delimiter by counting the number of separators per row in a bounded sample. */
function profileDelimiter(
	text: string,
	delimiter: CsvDelimiter,
	maxBytes = DEFAULT_SAMPLE_BYTES,
	maxRows = DEFAULT_SAMPLE_ROWS,
): DelimiterProfile {
	const counts: number[] = []
	let separators = 0
	let quoted = false
	let index = 0

	while (index < text.length && index < maxBytes && counts.length < maxRows) {
		const character = text[index]
		if (character === '"') {
			if (quoted && text[index + 1] === '"') index += 1
			else quoted = !quoted
		} else if (!quoted && character === delimiter) {
			separators += 1
		} else if (!quoted && (character === '\n' || character === '\r')) {
			counts.push(separators)
			separators = 0
			if (character === '\r' && text[index + 1] === '\n') index += 1
		}
		index += 1
	}
	if (separators > 0 || counts.length === 0) counts.push(separators)

	const nonZero = counts.filter((count) => count > 0)
	if (nonZero.length === 0) return { delimiter, counts, score: Number.NEGATIVE_INFINITY }

	const frequencies = new Map<number, number>()
	for (const count of nonZero) frequencies.set(count, (frequencies.get(count) ?? 0) + 1)
	const [mode, modeFrequency] = [...frequencies.entries()].sort((left, right) =>
		right[1] - left[1] || right[0] - left[0]
	)[0] ?? [0, 0]
	const consistency = modeFrequency / nonZero.length
	const coverage = nonZero.length / Math.max(counts.length, 1)

	return {
		delimiter,
		counts,
		score: consistency * 100 + coverage * 40 + Math.min(mode, 40) * 2 + Math.min(nonZero.length, 50),
	}
}

/** Ranks supported delimiters using a quote-aware bounded source sample. */
export function rankCsvDelimiters(text: string): readonly CsvDelimiter[] {
	return CANDIDATES
		.map((delimiter) => profileDelimiter(text, delimiter))
		.sort((left, right) => right.score - left.score)
		.map(({ delimiter }) => delimiter)
}
