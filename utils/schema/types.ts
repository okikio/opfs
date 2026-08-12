import type { StandardSchemaV1 } from '@standard-schema/spec';

/** Standard Schema contract accepted by reusable utility packages. */
export type Schema<Input = unknown, Output = Input> = StandardSchemaV1<Input, Output>;

/** Input type accepted by a Standard Schema contract. */
export type Input<Definition extends Schema> = StandardSchemaV1.InferInput<Definition>;

/** Validated output type produced by a Standard Schema contract. */
export type Output<Definition extends Schema> = StandardSchemaV1.InferOutput<Definition>;

/** Successful Standard Schema validation result. */
export type Success<Value> = Readonly<{ readonly value: Value; readonly issues?: undefined }>;

/** Failed Standard Schema validation result. */
export type Failure = Readonly<{ readonly issues: readonly StandardSchemaV1.Issue[] }>;

/** Validation result normalized by this package. */
export type ValidationResult<Value> = Success<Value> | Failure;
