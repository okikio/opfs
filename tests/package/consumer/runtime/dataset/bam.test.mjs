/** Installed dataset bam contracts. Each case owns its state and exact source oracle. */
import { describe, it } from "node:test";
import { createHash } from "node:crypto";
import { createByteSource } from "@okikio/opfs/source";
import { openBam } from "@okikio/opfs/dataset/bam";
import { fromBase64 } from "../../bytes.mjs";
import bamInput from "../../data/dataset/bam.json" with { type: "json" };

describe("packed dataset bam", () => {
  it("native BAM records, geometry and preview budgets", async () => {
    const bamNative = bamInput;
    if (bamNative.cases.length !== 4) throw new Error("Packed BAM native coverage changed");
    /** Reconstruct canonical SAM text from decoded records for comparison with the independently authored original. */
    const bamSam = (record, dataset) => {
      /** Keep the SAM absent-reference marker distinct from a header reference name. */
      const reference = (id) => id < 0 ? "*" : dataset.header.references[id].name;
      const mate = record.mateReferenceId >= 0 && record.mateReferenceId === record.referenceId
        ? "="
        : reference(record.mateReferenceId);
      const quality = record.qualities === null
        ? "*"
        : Array.from(record.qualities, (value) => String.fromCharCode(value + 33)).join("");
      const aux = record.auxiliary.map((field) =>
        field.tag + ":" + ("cCsSiI".includes(field.type) ? "i" : field.type) + ":" + field.value
      );
      return [
        record.name,
        record.flags,
        reference(record.referenceId),
        record.position + 1,
        record.mappingQuality,
        record.cigar.map((part) => part.length + part.operation).join("") || "*",
        mate,
        record.matePosition + 1,
        record.templateLength,
        record.sequence ?? "*",
        quality,
        ...aux,
      ].join(String.fromCharCode(9)) + String.fromCharCode(10);
    };
    for (const fixture of bamNative.cases) {
      const wire = fromBase64(fixture.bam.base64);
      if (
        wire.length !== fixture.bam.bytes || createHash("sha256").update(wire).digest("hex") !== fixture.bam.sha256 ||
        createHash("sha256").update(fixture.originalSam).digest("hex") !== fixture.originalSha256
      ) throw new Error("Packed BAM native/original hash changed");
      const dataset = await openBam(createByteSource(wire));
      let actual = dataset.header.text, ended = false;
      for await (const page of dataset.records({ maxRecords: 100, pageRecords: 1 })) {
        if (page.verification !== "checked-blocks") throw new Error("Packed BAM verification scope changed");
        actual += page.records.map((record) => bamSam(record, dataset)).join("");
        if (page.end === "eof") ended = true;
      }
      if (
        actual !== fixture.originalSam || !ended || dataset.inspect().records !== fixture.geometry.records ||
        dataset.inspect().blocks !== fixture.geometry.blocks
      ) throw new Error("Packed BAM differs from full authored SAM/native geometry");
      if (
        !Object.isFrozen(dataset.header) || !Object.isFrozen(dataset.header.references) ||
        dataset.finalMarker !== "canonical-physical"
      ) throw new Error("Packed BAM header contract changed");
      const before = dataset.inspect().requests;
      for await (const page of dataset.records({ maxRecords: 0 })) {
        if (page.records.length || page.end !== "preview") throw new Error("Packed BAM zero preview changed");
      }
      if (dataset.inspect().requests !== before) throw new Error("Packed BAM zero preview read records");
      let refused = false;
      try {
        await openBam(createByteSource(wire), { maxDecodedBytes: 0 });
      } catch (error) {
        if (error?.code !== "budget-exceeded") throw error;
        refused = true;
      }
      if (!refused) throw new Error("Packed BAM decoded budget was bypassed");
    }
  });
});
