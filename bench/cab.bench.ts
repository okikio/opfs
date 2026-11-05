import { bench, do_not_optimize } from "mitata";
import { decodeBase64 } from "@std/encoding/base64";
import { createBlobSource } from "../src/source.ts";
import { openCab } from "../src/archive/cab.ts";
import { expectBytes, report } from "./result.ts";
import fixtures from "../tests/fixtures/cab/independent.json" with { type: "json" };

// Question: how much covering-block or MSZIP history replay does a prefix or
// late range require? The native Blob baseline receives preindexed offsets and
// has no archive parsing, integrity checks or admission budgets. These fixed
// independent gcab files do not establish remote-provider or scaling performance.
// Warm samples share an index and therefore its lifetime accounting. This finite
// sampling allowance is separate from each read's unchanged default work limits.
const samplingLimits = {
  maxSourceBytes: 64 * 1024 ** 3,
  maxDecodedBytes: 64 * 1024 ** 3,
  maxOutputBytes: 1024 ** 3,
  maxRequests: 10_000_000,
};
for (const profile of ["stored", "mszip"] as const) {
  const fixture = fixtures[profile];
  const bytes = decodeBase64(fixture.archive);
  const blob = new Blob([new Uint8Array(bytes).buffer]);
  const source = createBlobSource(blob);
  const archive = await openCab(source, samplingLimits);
  bench(
    `cab/${profile} cold index: archive=${bytes.length}B source=${archive.work.sourceBytes}B decoded=${archive.work.decodedBytes}B requests=${archive.work.requests}`,
    async () => {
      do_not_optimize(await openCab(source));
    },
  );
  if (profile === "mszip") {
    for (const name of ["first.bin", "large.bin"]) {
      const entry = archive.entries.find((value) => value.name === name)!;
      const expected = decodeBase64(fixture.entries[entry.id]!.body);
      expectBytes((await archive.read(entry.id)).bytes, expected, `cab/MSZIP/${name}/full-oracle`);
      for (const offset of name === "large.bin" ? [0, 100000] : [0]) {
        const length = 3;
        const checked = await archive.read(entry.id, { offset, length });
        const unchecked = await archive.read(entry.id, { offset, length, verify: false });
        const oracle = expected.subarray(offset, offset + length);
        expectBytes(checked.bytes, oracle, `cab/MSZIP/${name}/${offset}/checked`);
        expectBytes(unchecked.bytes, oracle, `cab/MSZIP/${name}/${offset}/unchecked`);
        if (
          checked.work.sourceBytes !== unchecked.work.sourceBytes || checked.work.outputBytes !== length ||
          checked.integrity !== "block-checksum-verified"
        ) {
          throw new Error("CAB MSZIP replay work or checksum evidence differs from the native fixture.");
        }
        const label =
          `cab/MSZIP/${name} member=${entry.size}B offset=${offset}B output=${length}B blocks=${checked.blocks.length}`;
        bench(
          `${label} warm unchecked source=${unchecked.work.sourceBytes}B decoded=${unchecked.work.decodedBytes}B`,
          async () => {
            do_not_optimize(await archive.read(entry.id, { offset, length, verify: false }));
          },
        );
        bench(
          `${label} warm block-checksum source=${checked.work.sourceBytes}B decoded=${checked.work.decodedBytes}B`,
          async () => {
            do_not_optimize(await archive.read(entry.id, { offset, length }));
          },
        );
        bench(
          `${label} cold index+block-checksum source=${archive.work.sourceBytes + checked.work.sourceBytes}B decoded=${
            archive.work.decodedBytes + checked.work.decodedBytes
          }B`,
          async () => {
            const cold = await openCab(source);
            do_not_optimize(await cold.read(entry.id, { offset, length }));
          },
        );
      }
    }
    continue;
  }
  for (const name of ["first.bin", "large.bin"]) {
    const entry = archive.entries.find((value) => value.name === name)!;
    const expected = decodeBase64(fixture.entries[entry.id]!.body);
    expectBytes((await archive.read(entry.id)).bytes, expected, `cab/${name}/full-payload-oracle`);
    for (const offset of name === "large.bin" ? [0, 100000] : [0]) {
      const length = 3;
      const logical = entry.folderOffset + offset;
      const block = archive.folders[entry.folderId]!.blocks.find((value) =>
        value.folderOffset <= logical && logical + length <= value.folderOffset + value.size
      )!;
      const physical = block.offset + logical - block.folderOffset;
      const native = () => blob.slice(physical, physical + length).arrayBuffer();
      const checked = await archive.read(entry.id, { offset, length });
      const unchecked = await archive.read(entry.id, { offset, length, verify: false });
      const oracle = expected.subarray(offset, offset + length);
      expectBytes(checked.bytes, oracle, `cab/${name}/${offset}/checked-oracle`);
      expectBytes(unchecked.bytes, oracle, `cab/${name}/${offset}/unchecked-oracle`);
      expectBytes(new Uint8Array(await native()), oracle, `cab/${name}/${offset}/native-oracle`);
      if (
        checked.work.sourceBytes !== block.size || unchecked.work.sourceBytes !== length ||
        checked.work.outputBytes !== length || checked.integrity !== "block-checksum-verified"
      ) {
        throw new Error("CAB benchmark work or evidence differs from its independent payload oracle.");
      }
      const label = `cab/STORED/${name} member=${entry.size}B offset=${offset}B output=${length}B`;
      bench(`${label} native preindexed Blob: source=${length}B integrity=none`, async () => {
        do_not_optimize(await native());
      });
      bench(
        `${label} warm unchecked: source=${unchecked.work.sourceBytes}B decoded=${unchecked.work.decodedBytes}B`,
        async () => {
          do_not_optimize(await archive.read(entry.id, { offset, length, verify: false }));
        },
      );
      bench(
        `${label} warm block-checksum: source=${checked.work.sourceBytes}B decoded=${checked.work.decodedBytes}B`,
        async () => {
          do_not_optimize(await archive.read(entry.id, { offset, length }));
        },
      );
      bench(
        `${label} cold index + block-checksum: source=${archive.work.sourceBytes + checked.work.sourceBytes}B decoded=${
          archive.work.decodedBytes + checked.work.decodedBytes
        }B`,
        async () => {
          const cold = await openCab(source);
          do_not_optimize(await cold.read(entry.id, { offset, length }));
        },
      );
    }
  }
}

await report();
