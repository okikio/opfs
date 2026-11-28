/** Installed dataset arrow contracts. Each case owns its state and exact source oracle. */
import { describe, it } from "node:test";
import { createHash } from "node:crypto";
import { createByteSource } from "@okikio/opfs/source";
import { openArrow, readArrow } from "@okikio/opfs/dataset/arrow";
import { assertBytes, fromBase64 } from "../../bytes.mjs";
import arrowInput from "../../data/dataset/arrow.json" with { type: "json" };

describe("packed dataset arrow", () => {
  it("native Arrow columns, streaming ownership and evidence", async () => {
    const arrowNative = arrowInput;
    if (arrowNative.fixtures.length !== 10) throw new Error("Packed Arrow IPC native coverage changed");
    /** Admit each native original by its byte extent and digest before comparing candidate output. */
    const arrowBlob = (item) => {
      const bytes = fromBase64(item.base64);
      if (bytes.length !== item.bytes || createHash("sha256").update(bytes).digest("hex") !== item.sha256) {
        throw new Error("Packed Arrow native blob changed");
      }
      return bytes;
    };
    /** Compare physical native columns, validity masks and exact scalar values independently of Arrow decoding. */
    const arrowCompare = (result, expected) => {
      if (
        result.rows !== expected.rows || result.columns.length !== 6 || result.integrity !== "none" ||
        result.scope !== "selected-columns"
      ) throw new Error("Packed Arrow batch contract changed");
      const keys = ["i", "q", "d", "b", "s", "x"],
        physical = ["int32", "int64", "float64", "boolean", "utf8", "binary"];
      for (let ordinal = 0; ordinal < keys.length; ordinal++) {
        const key = keys[ordinal], column = result.columns[ordinal], original = expected.originals;
        if (column.ordinal !== ordinal || column.name !== key || column.physical !== physical[ordinal]) {
          throw new Error("Packed Arrow column identity changed");
        }
        assertBytes(column.validity, arrowBlob(original[key + ".validity"]));
        if (key === "s" || key === "x") {
          const offsets = arrowBlob(original[key + ".offsets"]),
            offsetView = new DataView(offsets.buffer, offsets.byteOffset, offsets.byteLength),
            data = arrowBlob(original[key + ".data"]);
          if (key === "x") {
            if (!(column.offsets instanceof Int32Array) || !(column.values instanceof Uint8Array)) {
              throw new Error("Packed Arrow binary representation changed");
            }
            assertBytes(column.values, data);
            for (let row = 0; row <= expected.rows; row++) {
              if (column.offsets[row] !== offsetView.getInt32(row * 4, true)) {
                throw new Error("Packed Arrow binary offsets changed");
              }
            }
          } else {
            if (!Array.isArray(column.values) || column.values.length !== expected.rows) {
              throw new Error("Packed Arrow text representation changed");
            }
            const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
            for (let row = 0; row < expected.rows; row++) {
              if (
                column.values[row] !==
                  decoder.decode(
                    data.subarray(offsetView.getInt32(row * 4, true), offsetView.getInt32((row + 1) * 4, true)),
                  )
              ) throw new Error("Packed Arrow UTF8 original changed");
            }
          }
        } else {
          const data = arrowBlob(original[key + ".bin"]),
            view = new DataView(data.buffer, data.byteOffset, data.byteLength),
            constructor = key === "i"
              ? Int32Array
              : key === "q"
              ? BigInt64Array
              : key === "d"
              ? Float64Array
              : Uint8Array;
          if (!(column.values instanceof constructor) || column.values.length !== expected.rows) {
            throw new Error("Packed Arrow numeric representation changed");
          }
          for (let row = 0; row < expected.rows; row++) {
            const value = key === "i"
              ? view.getInt32(row * 4, true)
              : key === "q"
              ? view.getBigInt64(row * 8, true)
              : key === "d"
              ? view.getFloat64(row * 8, true)
              : view.getUint8(row);
            if (!Object.is(column.values[row], value)) throw new Error("Packed Arrow numeric original changed");
          }
        }
      }
    };
    /** Deliver bounded copied chunks and expose cancellation so early iterator return has an ownership oracle. */
    const arrowStream = (wire, onCancel = () => {}) => {
      let at = 0;
      return new ReadableStream({
        pull(controller) {
          if (at === wire.length) {
            controller.close();
            return;
          }
          const end = Math.min(wire.length, at + 65536);
          controller.enqueue(wire.slice(at, end));
          at = end;
        },
        cancel: onCancel,
      }, { highWaterMark: 0 });
    };
    for (const fixture of arrowNative.fixtures) {
      const wire = arrowBlob(fixture.image);
      if (fixture.format === "file") {
        const dataset = await openArrow(createByteSource(wire));
        if (
          dataset.batches.length !== fixture.batches.length || dataset.columns.length !== 6 ||
          dataset.integrity !== "none" || dataset.scope !== "footer-and-schema"
        ) throw new Error("Packed Arrow file metadata changed");
        for (let batch = 0; batch < fixture.batches.length; batch++) {
          arrowCompare(await dataset.read(batch, [0, 1, 2, 3, 4, 5]), fixture.batches[batch]);
        }
        const nonemptyBatch = fixture.batches.findIndex((batch) => batch.rows > 0);
        if (nonemptyBatch >= 0) {
          let refused = false;
          try {
            const limited = await openArrow(createByteSource(wire), { maxOutputBytes: 0 });
            await limited.read(nonemptyBatch, [0, 1, 2, 3, 4, 5]);
          } catch (error) {
            if (error?.code !== "budget-exceeded") throw error;
            refused = true;
          }
          if (!refused) throw new Error("Packed Arrow output budget did not refuse");
        }
      } else {
        const stream = arrowStream(wire);
        let count = 0;
        for await (const batch of readArrow(stream)) {
          if (batch.batch !== count) throw new Error("Packed Arrow stream batch ordinal changed");
          arrowCompare(batch, fixture.batches[count++]);
        }
        if (count !== fixture.batches.length || stream.locked) {
          throw new Error("Packed Arrow stream completion retained its lock");
        }
        if (fixture.batches.length) {
          let canceled = 0;
          const early = arrowStream(wire, () => {
            canceled++;
          });
          for await (const batch of readArrow(early)) {
            arrowCompare(batch, fixture.batches[0]);
            break;
          }
          if (canceled !== 1 || early.locked) {
            throw new Error("Packed Arrow early return did not cancel/release owned reader");
          }
        }
      }
    }
    // Arrow IPC is unauthenticated. Caller labels cannot upgrade the literal result guarantee.
    const arrowAuthFixture = arrowNative.fixtures.find((item) =>
      item.format === "file" && item.batches.some((batch) => batch.rows > 0)
    );
    if (!arrowAuthFixture) throw new Error("Packed Arrow nonempty authentication control absent");
    const arrowAuthBatch = arrowAuthFixture.batches.findIndex((batch) => batch.rows > 0);
    const arrowAuthDataset = await openArrow(createByteSource(arrowBlob(arrowAuthFixture.image)));
    if ((await arrowAuthDataset.read(arrowAuthBatch, [0])).integrity !== "none") {
      throw new Error("Packed Arrow acquired a false authentication claim");
    }
  });
});
