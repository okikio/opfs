/** Installed image qcow2 contracts. Each case owns its state and exact source oracle. */
import { describe, it } from "node:test";
import { createByteSource } from "@okikio/opfs/source";
import { openQcow2 } from "@okikio/opfs/image/qcow2";
import { assertBytes, fromBase64 } from "../../bytes.mjs";
import qcow2Input from "../../data/image/qcow2.json" with { type: "json" };

describe("packed image qcow2", () => {
  it("QCOW2 native profiles, guest ranges and controls", async () => {
    const qcow2Fixtures = JSON.parse(qcow2Input);
    let qcow2L1Eof = false;
    for (const fixture of qcow2Fixtures.fixtures) {
      const physical = fromBase64(fixture.image.base64),
        original = fromBase64(fixture.original.base64),
        input = createByteSource(physical);
      let calls = 0;
      const image = await openQcow2({
        ...input,
        async read(offset, length, options) {
          calls++;
          return await input.read(offset, length, options);
        },
      });
      if (
        image.version !== fixture.observed.version || image.headerLength !== fixture.observed.headerLength ||
        image.clusterSize !== fixture.observed.clusterSize || image.size !== original.length ||
        image.validation !== "active-mapping-bounds" || image.refcountValidation !== "not-checked" ||
        image.integrity !== "none"
      ) throw new Error("Packed QCOW2 selected profile changed");
      const whole = await image.read();
      assertBytes(whole.bytes, original);
      if (whole.integrity !== "none" || whole.work.outputBytes !== original.length) {
        throw new Error("Packed QCOW2 whole guest evidence changed");
      }
      const cluster = image.clusterSize, guest = image.source();
      if (guest.size !== original.length || guest.stability !== "immutable") {
        throw new Error("Packed QCOW2 nested guest source changed");
      }
      for (
        const offset of [
          0,
          1,
          cluster - 1,
          cluster,
          cluster * 2 - 7,
          cluster * 64 - 1,
          65535,
          original.length - 513,
          original.length - 1,
          original.length,
        ].filter((value) => value >= 0 && value <= original.length)
      ) {
        const length = Math.min(37, original.length - offset), before = calls, segments = image.map(offset, length);
        if (calls !== before || segments.reduce((sum, segment) => sum + segment.length, 0) !== length) {
          throw new Error("Packed QCOW2 map is not a pure complete selection");
        }
        let next = offset;
        for (const segment of segments) {
          if (segment.offset !== next) throw new Error("Packed QCOW2 map lost guest ordinal");
          next += segment.length;
        }
        assertBytes((await image.read({ offset, length })).bytes, original.slice(offset, offset + length));
        assertBytes(await guest.read(offset, length), original.slice(offset, offset + length));
      }
      const wire = new DataView(physical.buffer, physical.byteOffset, physical.byteLength);
      const l1End = Number(wire.getBigUint64(40)) + wire.getUint32(36) * 8;
      if (l1End === physical.length) {
        qcow2L1Eof = true;
        assertBytes((await image.read()).bytes, original);
      }
      if (fixture.case.startsWith("holes-") || fixture.case === "zero-v3") {
        const offset = fixture.case === "zero-v3" ? 4096 : 0, expected = fixture.case === "zero-v3" ? "zero" : "hole";
        if (image.map(offset, 37)[0]?.kind !== expected) {
          throw new Error("Packed QCOW2 native zero/hole distinction changed");
        }
        const zero = await image.read({ offset, length: 37, maxSourceBytes: 0, maxRequests: 0 });
        assertBytes(zero.bytes, new Uint8Array(37));
        if (zero.work.sourceBytes !== 0 || zero.work.requests !== 0) {
          throw new Error("Packed QCOW2 zero region performed payload I/O");
        }
      }
    }
    if (qcow2Fixtures.fixtures.length !== 9 || !qcow2L1Eof) {
      throw new Error("Packed QCOW2 native original or exact serialized L1 EOF coverage changed");
    }
    if (qcow2Fixtures.controls.map((item) => item.case).join(",") !== "compressed,backing,snapshot") {
      throw new Error("Packed QCOW2 native control coverage changed");
    }
    for (const control of qcow2Fixtures.controls) {
      let refused = false;
      try {
        await openQcow2(createByteSource(fromBase64(control.image.base64)));
      } catch (error) {
        if (error?.code !== "unsupported-profile") throw error;
        refused = true;
      }
      if (!refused) throw new Error("Packed QCOW2 accepted a native unsupported control");
    }
  });
});
