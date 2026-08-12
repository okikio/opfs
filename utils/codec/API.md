@utils/codec public API usage
=============================

Purpose
-------

This reference maps every public export target declared by `@utils/codec` to its role and to a concrete repository use when one exists.

The package README teaches the programming model progressively.  This file is the exhaustive lookup surface for developers who already know the model.

@utils/codec
------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `array` | function | Compose a codec for arrays of another codec. | `array(...)` | `.agents/tests/public-api-repetition.test.ts:49` uses `array`. |
| `assert` | function | Assert that a value is a codec definition. | `assert(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Codec` | interface | Explicit bidirectional contract composed from two independent Standard Schemas. | `value: Codec` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CodecShape` | type | Record of named codecs accepted by {@link object}. | `value: CodecShape` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `decode` | function | Decode and validate an external value. | `decode(...)` | `.agents/tests/production-e2e.test.ts:149` uses `decode`. |
| `Decoded` | type | Application value produced by a codec. | `value: Decoded` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `DecodeInput` | type | Encoded input accepted by a codec. | `value: DecodeInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `define` | function | Define a codec from explicit decode and encode Standard Schemas. | `define(...)` | `.agents/tests/production-e2e.test.ts:148` uses `define`. |
| `encode` | function | Encode and validate an application value. | `encode(...)` | `.agents/tests/production-e2e.test.ts:150` uses `encode`. |
| `Encoded` | type | Encoded value produced by a codec. | `value: Encoded` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EncodeInput` | type | Application input accepted for encoding. | `value: EncodeInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `is` | function | Return whether a value is a codec definition. | `is(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `nullable` | function | Allow a codec value to be `null` in both directions. | `nullable(...)` | `.agents/tests/public-api-repetition.test.ts:51` uses `nullable`. |
| `object` | function | Compose named codecs into one structurally validated object codec. | `object(...)` | `.agents/tests/production-e2e.test.ts:148` uses `object`. |
| `ObjectDecoded` | type | Decoded application object represented by a codec shape. | `value: ObjectDecoded` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ObjectDecodeInput` | type | Decoded object input represented by a codec shape. | `value: ObjectDecodeInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ObjectEncoded` | type | Encoded object represented by a codec shape. | `value: ObjectEncoded` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ObjectEncodeInput` | type | Application object accepted by a codec shape's encoder. | `value: ObjectEncodeInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `optional` | function | Allow a codec value to be omitted as `undefined` in both directions. | `optional(...)` | `.agents/tests/public-api-repetition.test.ts:50` uses `optional`. |

Detected uses
~~~~~~~~~~~~~

`define` appears in `.agents/tests/production-e2e.test.ts:148`:

~~~~ typescript
const Pair = codec.object({ value: codec.define({ decode: Text, encode: Text }) });
		assert.equal((await codec.decode(Pair, { value: 'ok' })).value, 'ok');
		assert.equal((await codec.encode(Pair, { value: 'ok' })).value, 'ok');
		assert.equal(result.isOk(result.ok('ok')), true);
~~~~

`decode` appears in `.agents/tests/production-e2e.test.ts:149`:

~~~~ typescript
assert.equal((await codec.decode(Pair, { value: 'ok' })).value, 'ok');
		assert.equal((await codec.encode(Pair, { value: 'ok' })).value, 'ok');
		assert.equal(result.isOk(result.ok('ok')), true);
		assert.equal(result.isFailure(result.fail('no')), true);
~~~~

`encode` appears in `.agents/tests/production-e2e.test.ts:150`:

~~~~ typescript
assert.equal((await codec.encode(Pair, { value: 'ok' })).value, 'ok');
		assert.equal(result.isOk(result.ok('ok')), true);
		assert.equal(result.isFailure(result.fail('no')), true);
		assert.equal(schema.is(Text), true);
~~~~

`object` appears in `.agents/tests/production-e2e.test.ts:148`:

~~~~ typescript
const Pair = codec.object({ value: codec.define({ decode: Text, encode: Text }) });
		assert.equal((await codec.decode(Pair, { value: 'ok' })).value, 'ok');
		assert.equal((await codec.encode(Pair, { value: 'ok' })).value, 'ok');
		assert.equal(result.isOk(result.ok('ok')), true);
~~~~

`optional` appears in `.agents/tests/public-api-repetition.test.ts:50`:

~~~~ typescript
const maybe = codec.optional(TextCodec);
		const nullableAccepted = codec.nullable(TextCodec);
		const nullableRejected = codec.nullable(TextCodec);
		assert.deepEqual(await codec.decode(collection, ['one', 'two']), ['one', 'two']);
~~~~

`nullable` appears in `.agents/tests/public-api-repetition.test.ts:51`:

~~~~ typescript
const nullableAccepted = codec.nullable(TextCodec);
		const nullableRejected = codec.nullable(TextCodec);
		assert.deepEqual(await codec.decode(collection, ['one', 'two']), ['one', 'two']);
		await assert.rejects(codec.decode(codec.array(TextCodec), ['one', 2]), TypeError);
~~~~

`array` appears in `.agents/tests/public-api-repetition.test.ts:49`:

~~~~ typescript
const collection = codec.array(TextCodec);
		const maybe = codec.optional(TextCodec);
		const nullableAccepted = codec.nullable(TextCodec);
		const nullableRejected = codec.nullable(TextCodec);
~~~~

@utils/codec/types
------------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `Codec` | interface | Explicit bidirectional contract composed from two independent Standard Schemas. | `value: Codec` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CodecShape` | type | Record of named codecs accepted by {@link object}. | `value: CodecShape` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Decoded` | type | Application value produced by a codec. | `value: Decoded` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `DecodeInput` | type | Encoded input accepted by a codec. | `value: DecodeInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Encoded` | type | Encoded value produced by a codec. | `value: Encoded` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EncodeInput` | type | Application input accepted for encoding. | `value: EncodeInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ObjectDecoded` | type | Decoded application object represented by a codec shape. | `value: ObjectDecoded` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ObjectDecodeInput` | type | Decoded object input represented by a codec shape. | `value: ObjectDecodeInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ObjectEncoded` | type | Encoded object represented by a codec shape. | `value: ObjectEncoded` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ObjectEncodeInput` | type | Application object accepted by a codec shape's encoder. | `value: ObjectEncodeInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |

Coverage note
-------------

This generated map contains 29 public names across 2 package export targets. 7 names have a direct in-repository use detected through TypeScript imports.

A missing in-repository use is not converted into a fake example. It is a signal that the export is currently an extension point, a type-level support surface, or an API that still needs a concrete adopter.

