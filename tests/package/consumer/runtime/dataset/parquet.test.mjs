/** Installed dataset parquet contracts. Each case owns its state and exact source oracle. */
import { describe, it } from "node:test";
import { createByteSource } from "@okikio/opfs/source";
import { openParquet } from "@okikio/opfs/dataset/parquet";
import { assertBytes, fromBase64 } from "../../bytes.mjs";
import parquetInput from "../../data/dataset/parquet.json" with { type: "json" };

describe("packed dataset parquet", () => {
  it("native Parquet physical columns and page evidence", async () => {
    const parquetNative = parquetInput;
    if (parquetNative.fixtures.length !== 22) throw new Error("Packed Parquet native coverage changed");
    // Decode the retained original physical bytes independently of the reader.
    /** Decode retained primitive originals independently of the candidate page reader. */
    const parquetExpected = (name, bytes) => {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        width = name === "b" ? 1 : name === "i" || name === "f" ? 4 : 8;
      return Array.from({ length: bytes.length / width }, (_, index) => {
        const at = index * width;
        return name === "b"
          ? view.getUint8(at)
          : name === "i"
          ? view.getInt32(at, true)
          : name === "q"
          ? view.getBigInt64(at, true)
          : name === "f"
          ? view.getFloat32(at, true)
          : view.getFloat64(at, true);
      });
    };
    /** Keep original scalar values and validity separate from the reader's selected-page evidence. */
    const parquetCompare = (result, expected, mask) => {
      if (result.values.length !== expected.length || result.integrity !== "selected-pages") {
        throw new Error("Packed Parquet output scope changed");
      }
      assertBytes(result.validity, mask);
      for (let index = 0; index < expected.length; index++) {
        if (!Object.is(result.values[index], expected[index])) {
          throw new Error("Packed Parquet original value changed at " + index);
        }
      }
    };
    for (const fixture of parquetNative.fixtures) {
      const dataset = await openParquet(createByteSource(fromBase64(fixture.file.base64)));
      if (
        dataset.rows !== fixture.rows || dataset.rowGroups.length !== fixture.rowGroups.length ||
        dataset.integrity !== "metadata-unverified"
      ) throw new Error("Packed Parquet metadata changed");
      if (!fixture.supported) {
        if (dataset.columns[0].readable) throw new Error("Packed Parquet unsupported column became readable");
        let refused = false;
        try {
          await dataset.read(0);
        } catch (error) {
          if (error?.code !== "unsupported-profile") throw error;
          refused = true;
        }
        if (!refused) throw new Error("Packed Parquet unsupported decoding admitted");
        continue;
      }
      if (dataset.columns.length !== 5) throw new Error("Packed Parquet column count changed");
      for (const column of fixture.columns) {
        const descriptor = dataset.columns.find((value) => value.name === column.name);
        if (!descriptor?.readable) throw new Error("Packed Parquet physical column missing");
        const expected = parquetExpected(column.name, fromBase64(column.physicalLittleEndian.base64)),
          mask = fromBase64(column.validity.base64);
        const whole = await dataset.read(descriptor.id);
        const constructor = column.name === "b"
          ? Uint8Array
          : column.name === "i"
          ? Int32Array
          : column.name === "q"
          ? BigInt64Array
          : column.name === "f"
          ? Float32Array
          : Float64Array;
        if (!(whole.values instanceof constructor)) throw new Error("Packed Parquet physical array type changed");
        parquetCompare(whole, expected, mask);
        const checksum = fixture.producer === "PyArrow" && fixture.case.endsWith("True")
          ? "crc32-verified"
          : "not-provided";
        if (!whole.pages.every((page) => page.selected && page.checksum === checksum)) {
          throw new Error("Packed Parquet whole page scope changed");
        }
        const offset = fixture.rows > 100 ? 2000 : fixture.rows > 8 ? 6 : 0,
          length = Math.min(fixture.rows - offset, fixture.rows > 100 ? 100 : 20);
        const selected = await dataset.read(descriptor.id, { offset, length });
        parquetCompare(selected, expected.slice(offset, offset + length), mask.slice(offset, offset + length));
        if (!selected.pages.every((page) => page.checksum === (page.selected ? checksum : "not-read"))) {
          throw new Error("Packed Parquet selected page scope changed");
        }
        if (
          fixture.case.includes("many-pages") &&
          new Set(selected.pages.filter((page) => page.selected).map((page) => page.rowGroup)).size !== 2
        ) throw new Error("Packed Parquet selection no longer crosses row groups");
      }
    }
  });
});
