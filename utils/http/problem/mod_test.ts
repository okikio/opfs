import { expect } from '@std/expect';
import { describe, it } from 'node:test';

import * as problem from './mod.ts';
import * as problemTesting from './testing/mod.ts';

describe('HTTP problem', () => {
	it('creates RFC 9457 tuples and prevents canonical extension overrides', () => {
		const NotFound = problem.define({
			id: 'widgets:not-found',
			type: 'https://api.kaiju.land/problems/widget-not-found',
			status: 404,
			title: 'Widget not found',
			description: 'The requested widget does not exist.',
		});
		const result = problem.create(NotFound, { detail: 'Missing widget.', extensions: { widget_id: 'widget_1' } });
		expect(result[0]).toEqual({
			type: NotFound.type,
			title: NotFound.title,
			status: 404,
			detail: 'Missing widget.',
			widget_id: 'widget_1',
		});
		expect(problem.is(result, NotFound)).toBe(true);
		expect(() => problem.create(NotFound, { extensions: { status: 500 } })).toThrow(TypeError);
	});

	it('requires exhaustive problem behavior registrations before invoking them', () => {
		const Problems = problem.catalog('coverage', {
			First: problem.define({
				id: 'coverage:first', type: 'https://api.kaiju.land/problems/coverage-first', status: 400,
				title: 'First coverage problem', description: 'First problem used by the coverage test.',
			}),
			Second: problem.define({
				id: 'coverage:second', type: 'https://api.kaiju.land/problems/coverage-second', status: 409,
				title: 'Second coverage problem', description: 'Second problem used by the coverage test.',
			}),
		});
		const registered: string[] = [];
		const report = problemTesting.coverage(Problems, {
			First: () => registered.push('First'),
			Second: () => registered.push('Second'),
		});
		expect(report).toEqual({ declared: 2, covered: 2, missing: [], extra: [] });
		expect(registered).toEqual(['First', 'Second']);
		expect(() => problemTesting.coverage(Problems, { First: () => registered.push('unexpected') } as never))
			.toThrow(problemTesting.ProblemCoverageError);
		expect(registered).toEqual(['First', 'Second']);
	});

	it('rejects invalid definitions and canonical extension collisions', () => {
		expect(() => problem.define({
			id: 'invalid', type: '/relative', status: 400, title: 'Invalid', description: 'Invalid URI.',
		})).toThrow(TypeError);
		expect(() => problem.define({
			id: 'invalid', type: 'https://api.example.test/problems/invalid', status: 200,
			title: 'Invalid', description: 'Invalid status.',
		})).toThrow(TypeError);
	});
});
