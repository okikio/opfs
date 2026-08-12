import type { StandardSchemaV1 } from '@standard-schema/spec';

/** Explicit bidirectional contract composed from two independent Standard Schemas. */
export interface Codec<
	EncodedInput = unknown,
	Application = unknown,
	ApplicationInput = Application,
	Encoded = EncodedInput,
> {
	readonly kind: 'codec';
	readonly decode: StandardSchemaV1<EncodedInput, Application>;
	readonly encode: StandardSchemaV1<ApplicationInput, Encoded>;
}

/** Encoded input accepted by a codec. */
export type DecodeInput<Definition extends Codec> = StandardSchemaV1.InferInput<Definition['decode']>;

/** Application value produced by a codec. */
export type Decoded<Definition extends Codec> = StandardSchemaV1.InferOutput<Definition['decode']>;

/** Application input accepted for encoding. */
export type EncodeInput<Definition extends Codec> = StandardSchemaV1.InferInput<Definition['encode']>;

/** Encoded value produced by a codec. */
export type Encoded<Definition extends Codec> = StandardSchemaV1.InferOutput<Definition['encode']>;

/** Record of named codecs accepted by {@link object}. */
export type CodecShape = Readonly<Record<string, Codec>>;

/** Decoded object input represented by a codec shape. */
export type ObjectDecodeInput<Shape extends CodecShape> = {
	readonly [Key in keyof Shape]: DecodeInput<Shape[Key]>;
};

/** Decoded application object represented by a codec shape. */
export type ObjectDecoded<Shape extends CodecShape> = {
	readonly [Key in keyof Shape]: Decoded<Shape[Key]>;
};

/** Application object accepted by a codec shape's encoder. */
export type ObjectEncodeInput<Shape extends CodecShape> = {
	readonly [Key in keyof Shape]: EncodeInput<Shape[Key]>;
};

/** Encoded object represented by a codec shape. */
export type ObjectEncoded<Shape extends CodecShape> = {
	readonly [Key in keyof Shape]: Encoded<Shape[Key]>;
};
