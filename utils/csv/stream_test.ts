import { describe, it } from 'node:test'
import { expect } from '@std/expect'

import { CsvParseError, parseCsvStream } from './mod.ts'

const encoder = new TextEncoder()

function stream(...chunks: string[]): ReadableStream<Uint8Array> {
	const encoded = chunks.map((chunk) => encoder.encode(chunk))
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of encoded) controller.enqueue(chunk)
			controller.close()
		},
	})
}

describe('CSV streaming', () => {
	it('streams quoted records across byte chunks', async () => {
		await using document = await parseCsvStream(stream(
			'Company,Notes,Email\nNorthstar,"line one\n',
			'line two",hello@northstar.example\n',
		))

		expect(document.columns.map((column) => column.role)).toEqual([
			'company',
			'unknown',
			'email',
		])
		expect(await Array.fromAsync(document.rows)).toEqual([{
			row: 2,
			values: ['Northstar', 'line one\nline two', 'hello@northstar.example'],
			diagnostics: [],
		}])
	})

	it('enforces row, column, and cell limits while rows are consumed', async () => {
		await using rowLimited = await parseCsvStream(
			stream('Company,Domain\nOne,one.example\nTwo,two.example\n'),
			{ maxRows: 1 },
		)
		let rowError: unknown
		try {
			await Array.fromAsync(rowLimited.rows)
		} catch (cause) {
			rowError = cause
		}
		expect(rowError).toBeInstanceOf(CsvParseError)
		expect((rowError as CsvParseError).code).toEqual('too-many-rows')

		await using columnLimited = await parseCsvStream(
			stream('Company,Domain\nOne,one.example,unexpected\n'),
			{ maxColumns: 2 },
		)
		let columnError: unknown
		try {
			await Array.fromAsync(columnLimited.rows)
		} catch (cause) {
			columnError = cause
		}
		expect(columnError).toBeInstanceOf(CsvParseError)
		expect((columnError as CsvParseError).code).toEqual('too-many-columns')

		await using cellLimited = await parseCsvStream(
			stream('Company,Domain\nNorthstar,northstar.example\n'),
			{ maxCellLength: 5 },
		)
		let cellError: unknown
		try {
			await Array.fromAsync(cellLimited.rows)
		} catch (cause) {
			cellError = cause
		}
		expect(cellError).toBeInstanceOf(CsvParseError)
		expect((cellError as CsvParseError).code).toEqual('cell-too-large')
	})

	it('attaches recoverable observations to the exact streamed row', async () => {
		await using document = await parseCsvStream(
			stream('Company,Domain\n=WEBSERVICE("x"),example.com,extra\n'),
		)
		const rows = await Array.fromAsync(document.rows)
		expect(rows[0]?.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			'row-width-mismatch',
			'spreadsheet-formula',
		])
	})

	it('is one-shot and supports explicit disposal before exhaustion', async () => {
		const document = await parseCsvStream(
			stream('Company,Domain\nOne,one.example\nTwo,two.example\n'),
		)
		const iterator = document.rows[Symbol.asyncIterator]()
		expect((await iterator.next()).value?.row).toEqual(2)
		await document[Symbol.asyncDispose]()
		await expect(Array.fromAsync(document.rows)).rejects.toThrow(TypeError)
	})
})
