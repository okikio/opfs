import { bench, do_not_optimize, group, run } from 'mitata';
import { z } from 'zod';

import * as env from './zod.ts';

const BenchmarkEnvironment = env.define({
	PORT: z.coerce.number().int().positive().meta({
		description: 'Benchmark HTTP port.',
	}),
	MODE: z.enum(['development', 'production']).meta({
		description: 'Benchmark runtime mode.',
	}),
});

const source = env.record({
	PORT: '8787',
	MODE: 'production',
});

group('@utils/env', () => {
	bench('parse two Zod-backed fields', () => {
		do_not_optimize(BenchmarkEnvironment.parseSync(source));
	}).gc('once');
});

await run();
