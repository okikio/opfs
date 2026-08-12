/**
 * Environment definitions, raw-value sources, and deterministic projections.
 *
 * Import the package as a namespace so its compact verbs remain explicit at the
 * call site:
 *
 * ```ts
 * import * as env from '@utils/env';
 *
 * const values = Definition.parseSync(env.merge(env.env, overrides));
 * ```
 *
 * Use `@utils/env/zod` or `@utils/env/valibot` when schemas should contribute
 * their native metadata automatically.
 */
export * from './standard.ts';
