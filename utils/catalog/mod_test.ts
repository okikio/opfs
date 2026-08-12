import { describe, it } from 'node:test';
import { expect } from '@std/expect';

import * as catalog from './mod.ts';

const First = Object.freeze({ id: 'test:first', kind: 'test', description: 'First entry.' });
const Second = Object.freeze({ id: 'test:second', kind: 'test' });

describe('catalog', () => {
	it('preserves prototype-shaped keys as ordinary entries', () => {
		const entries = Object.create(null) as Record<string, typeof First>;
		Object.defineProperty(entries, '__proto__', { value: First, enumerable: true });
		Object.defineProperty(entries, 'constructor', { value: Second, enumerable: true });
		const definitions = catalog.create('test', entries);

		expect(definitions.__proto__).toBe(First);
		expect(definitions.constructor).toBe(Second);
		expect(catalog.values(definitions)).toEqual([First, Second]);
	});

	it('deduplicates the same object and rejects conflicting stable ids', () => {
		expect(catalog.compose(First, [First, Second])).toEqual([First, Second]);
		expect(() => catalog.compose(First, { ...First })).toThrow(catalog.CatalogConflictError);
	});

	it('keeps selection keys and direct definition identities', () => {
		const definitions = catalog.create('test', { First, Second });
		const selected = catalog.select(definitions, ['Second', 'First'] as const);

		expect(selected.Second).toBe(Second);
		expect(selected.First).toBe(First);
		expect(catalog.values(selected)).toEqual([Second, First]);
		expect(catalog.document(selected)).toEqual({
			type: 'selection',
			namespace: 'test',
			entries: [
				{ key: 'Second', id: 'test:second', kind: 'test' },
				{ key: 'First', id: 'test:first', kind: 'test', description: 'First entry.' },
			],
		});
	});


	it('rejects assigning one definition object to multiple source keys', () => {
		expect(() => catalog.create('test', { First, Alias: First })).toThrow(TypeError);
	});

	it('does not expose mutable catalog metadata indexes', () => {
		const definitions = catalog.create('test', { First, Second });
		const keyByEntry = catalog.metadata(definitions).keyByEntry as ReadonlyMap<typeof First | typeof Second, string> & {
			set?: unknown;
		};

		expect(keyByEntry.get(First)).toBe('First');
		expect(keyByEntry.set).toBe(undefined);
	});

	it('freezes the catalog and selection without adding enumerable methods', () => {
		const definitions = catalog.create('test', { First, Second });
		const selected = catalog.select(definitions, ['First'] as const);

		expect(Object.keys(definitions)).toEqual(['First', 'Second']);
		expect(Object.keys(selected)).toEqual(['First']);
		expect(Object.isFrozen(definitions)).toBe(true);
		expect(Object.isFrozen(selected)).toBe(true);
	});
});
