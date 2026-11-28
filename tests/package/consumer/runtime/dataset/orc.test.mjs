/** Installed dataset orc contracts. Each case owns its state and exact source oracle. */
import { describe, it } from "node:test";
import { createByteSource } from "@okikio/opfs/source";
import { openOrc } from "@okikio/opfs/dataset/orc";
import { assertBytes, fromBase64 } from "../../bytes.mjs";
import orcInput from "../../data/dataset/orc.json" with { type: "json" };

describe("packed dataset orc", () => {
  it("native ORC physical columns and selected stripes", async () => {
    const orcNative = orcInput;
    if (orcNative.fixtures.length !== 18) throw new Error("Packed ORC native coverage changed");
    /** Decode retained little-endian primitive originals without using the candidate ORC decoder. */
    const orcExpected = (name, bytes) => {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const width = name === "b" || name === "y" ? 1 : name === "s" ? 2 : name === "i" || name === "f" ? 4 : 8;
      return Array.from({ length: bytes.length / width }, (_, row) => {
        const at = row * width;
        switch (name) {
          case "b":
            return view.getUint8(at);
          case "y":
            return view.getInt8(at);
          case "s":
            return view.getInt16(at, true);
          case "i":
            return view.getInt32(at, true);
          case "q":
            return view.getBigInt64(at, true);
          case "f":
            return view.getFloat32(at, true);
          case "d":
            return view.getFloat64(at, true);
          default:
            throw new Error("Packed ORC native original column unknown");
        }
      });
    };
    /** Check physical representation, validity and evidence scope for the selected native stripe values. */
    const orcCompare = (result, name, expected, mask) => {
      const constructor = name === "b"
        ? Uint8Array
        : name === "y"
        ? Int8Array
        : name === "s"
        ? Int16Array
        : name === "i"
        ? Int32Array
        : name === "q"
        ? BigInt64Array
        : name === "f"
        ? Float32Array
        : Float64Array;
      if (
        !(result.values instanceof constructor) || result.values.length !== expected.length ||
        result.integrity !== "none" || result.scope !== "selected-column-stripes"
      ) throw new Error("Packed ORC output type/scope changed");
      assertBytes(result.validity, mask);
      for (let row = 0; row < expected.length; row++) {
        if (!Object.is(result.values[row], expected[row])) {
          throw new Error("Packed ORC native original changed at " + row);
        }
      }
      if (!result.stripes.every((stripe) => stripe.encoding === "DIRECT")) {
        throw new Error("Packed ORC selected encoding changed");
      }
    };
    for (const fixture of orcNative.fixtures) {
      const wire = fromBase64(fixture.file.base64);
      if (wire.length !== fixture.file.bytes) throw new Error("Packed ORC wire extent changed");
      const dataset = await openOrc(createByteSource(wire));
      if (
        dataset.rows !== fixture.rows || dataset.formatVersion !== fixture.fileVersion ||
        dataset.contentLengthBasis !== fixture.contentLengthBasis ||
        dataset.stripes.length !== fixture.stripes.length || dataset.columns.length !== 7 ||
        dataset.integrity !== "none"
      ) throw new Error("Packed ORC native metadata changed");
      for (const column of fixture.columns) {
        const descriptor = dataset.columns.find((value) => value.name === column.name);
        if (!descriptor?.supported) throw new Error("Packed ORC physical schema column missing");
        if (fixture.rows !== 0 && fixture.fileVersion === "0.12" && ["s", "i", "q"].includes(column.name)) {
          let refused = false;
          try {
            await dataset.read(descriptor.id);
          } catch (error) {
            if (error?.code !== "unsupported-profile") throw error;
            refused = true;
          }
          if (!refused) throw new Error("Packed ORC DIRECT_V2 decoding admitted");
          continue;
        }
        const expected = orcExpected(column.name, fromBase64(column.physicalLittleEndian.base64)),
          mask = fromBase64(column.validity.base64);
        const full = await dataset.read(descriptor.id);
        orcCompare(full, column.name, expected, mask);
        if (
          fixture.rows === 0 && (full.work.requests !== 0 || full.work.sourceBytes !== 0 || full.stripes.length !== 0)
        ) throw new Error("Packed empty ORC selection acquired a body");
        const offset = fixture.rows > 256 ? 253 : Math.min(fixture.rows, 1),
          length = Math.min(fixture.rows - offset, 7);
        const selected = await dataset.read(descriptor.id, { offset, length });
        orcCompare(selected, column.name, expected.slice(offset, offset + length), mask.slice(offset, offset + length));
        if (fixture.rows > 256 && fixture.nulls !== "all" && selected.stripes.length !== 2) {
          throw new Error("Packed ORC selected rows no longer cross stripes");
        }
      }
    }
  });
});
