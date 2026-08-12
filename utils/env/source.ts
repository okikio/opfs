import type { EnvironmentRecord, EnvironmentSource, EnvironmentSourceInput } from './types.ts';

interface DenoEnvironmentRuntime {
	readonly env?: {
		get(key: string): string | undefined;
	};
}

interface NodeProcessBuiltin {
	readonly env?: Readonly<Record<string, string | undefined>>;
}

interface NodeProcessGlobal {
	getBuiltinModule?(identifier: string): unknown;
}

/** Return whether a value already implements the pull-based source contract. */
export function isSource(value: EnvironmentSourceInput): value is EnvironmentSource {
	return typeof value === 'object' && value !== null && typeof (value as EnvironmentSource).get === 'function';
}

/** Convert a source-or-record input to the pull-based source contract. */
function toSource(input: EnvironmentSourceInput): EnvironmentSource {
	return isSource(input) ? input : record(input);
}

/**
 * Capture raw values as a deterministic environment source.
 *
 * The snapshot uses `Map` because environment keys are external strings. Keys
 * such as `__proto__`, `constructor`, and `toString` therefore remain ordinary
 * data instead of interacting with an object's prototype.
 *
 * @example Test override
 * ```ts
 * const test = env.record({ PORT: '4321' });
 * test.get('PORT'); // '4321'
 * ```
 */
export function record(values: EnvironmentRecord): EnvironmentSource {
	const snapshot = new Map(Object.entries(values));
	return {
		/**
		 * Gets state from environment definition and resolution after its ownership and validation rules have been established.
		 *
		 * @internal
		 */
		get(key: string): string | undefined {
			return snapshot.get(key);
		},
	};
}

/**
 * Merge sparse sources from lowest to highest precedence.
 *
 * Later sources override earlier sources only when they provide a concrete
 * string. Returning `undefined` allows lookup to continue into lower layers.
 * This mirrors how a host can apply explicit overrides without copying the
 * entire ambient environment.
 *
 * @example Runtime values with explicit overrides
 * ```ts
 * const source = env.merge(env.env, { PORT: '4321' });
 * ```
 *
 * @example Sparse override
 * ```ts
 * const source = env.merge({ HOST: 'localhost', PORT: '8787' }, { PORT: '4321' });
 * source.get('HOST'); // 'localhost'
 * source.get('PORT'); // '4321'
 * ```
 */
export function merge(...sources: readonly EnvironmentSourceInput[]): EnvironmentSource {
	const normalized = sources.map(toSource);
	return {
		/**
		 * Gets state from environment definition and resolution after its ownership and validation rules have been established.
		 *
		 * @internal
		 */
		get(key: string): string | undefined {
			for (let index = normalized.length - 1; index >= 0; index -= 1) {
				const value = normalized[index]?.get(key);
				if (value !== undefined) return value;
			}
			return undefined;
		},
	};
}

/**
 * Reads runtime value under the module's cancellation and ownership rules.
 *
 * @internal
 */
function readRuntimeValue(key: string): string | undefined {
	const deno = (globalThis as typeof globalThis & { Deno?: DenoEnvironmentRuntime }).Deno;
	if (deno?.env?.get) return deno.env.get(key);

	const processGlobal = (globalThis as typeof globalThis & { process?: NodeProcessGlobal }).process;
	const processBuiltin = processGlobal?.getBuiltinModule?.('node:process') as NodeProcessBuiltin | undefined;
	const values = processBuiltin?.env;
	return values && Object.hasOwn(values, key) ? values[key] : undefined;
}

/**
 * Lazy ambient environment source for Deno and supported Node.js runtimes.
 *
 * Importing this value performs no environment read. Each call to `get()` reads
 * only the requested key, which preserves narrow Deno permissions. Node.js is
 * reached through `process.getBuiltinModule('node:process')`, so browser module
 * resolution never encounters a static `node:` import.
 *
 * Browsers and older runtimes that expose neither API behave as an empty source.
 */
export const env: EnvironmentSource = {
	/**
	 * Gets state from environment definition and resolution after its ownership and validation rules have been established.
	 *
	 * @internal
	 */
	get(key: string): string | undefined {
		return readRuntimeValue(key);
	},
};

/**
 * Read a bounded set of raw values without defining a validation schema.
 *
 * This is useful for deployment adapters and opaque pass-through settings that
 * need source selection but do not own the value's domain contract.
 */
export function select(source: EnvironmentSourceInput, keys: readonly string[]): EnvironmentRecord {
	const normalized = toSource(source);
	return Object.fromEntries(keys.map((key) => [key, normalized.get(key)]));
}
