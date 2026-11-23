import { bench, do_not_optimize } from "mitata";
import { decodeBase64 } from "@std/encoding/base64";
import { createBlobSource } from "../src/source.ts";
import { openCpio } from "../src/archive/cpio.ts";
import { expectBytes, report } from "./result.ts";
import fixtures from "../tests/fixtures/cpio/gnu.json" with { type: "json" };

// Question: what extra work does a bounded CRC-verified prefix require compared
// with an unchecked exact range and a native Blob range? The native baseline
// has no archive parsing, snapshot policy, work budgets or checksum validation.
// This fixed independent GNU corpus is not a scaling or provider-performance claim.
for (const profile of ["newc", "crc"] as const) {
  const fixture = fixtures[profile];
  const bytes = decodeBase64(fixture.archive);
  const blob = new Blob([new Uint8Array(bytes).buffer]);
  const source = createBlobSource(blob);
  const archive = await openCpio(source);
  bench(
    `cpio/${profile} cold index: archive=${bytes.length}B source=${archive.work.sourceBytes}B decoded=${archive.work.decodedBytes}B requests=${archive.work.requests}`,
    async () => {
      do_not_optimize(await openCpio(source));
    },
  );
  for (const name of ["folder/data.bin", "large.bin"]) {
    const entry = archive.entries.find((value) => value.name === name)!;
    const expected = decodeBase64(fixture.entries[entry.id]!.body);
    const length = Math.min(4096, expected.length);
    const full = await archive.read(entry.id);
    expectBytes(full.bytes, expected, `cpio/${profile}/${name}/full-oracle`);
    // Locate this independent producer's physical member extent without asking
    // the candidate for private offsets. Complete payload equality above is the oracle.
    let at = 0;
    let body = 0;
    const decoder = new TextDecoder();
    for (let id = 0; id <= entry.id; id++) {
      const size = parseInt(decoder.decode(bytes.subarray(at + 54, at + 62)), 16);
      const names = parseInt(decoder.decode(bytes.subarray(at + 94, at + 102)), 16);
      body = Math.ceil((at + 110 + names) / 4) * 4;
      at = Math.ceil((body + size) / 4) * 4;
    }
    const native = () => blob.slice(body, body + length).arrayBuffer();
    expectBytes(new Uint8Array(await native()), expected.subarray(0, length), `cpio/${profile}/${name}/native-oracle`);
    const checked = await archive.read(entry.id, { length });
    const unchecked = await archive.read(entry.id, { length, verify: false });
    expectBytes(checked.bytes, expected.subarray(0, length), `cpio/${profile}/${name}/verified-oracle`);
    expectBytes(unchecked.bytes, expected.subarray(0, length), `cpio/${profile}/${name}/unchecked-oracle`);
    if (
      checked.work.sourceBytes !== (profile === "crc" ? expected.length : length) ||
      checked.work.outputBytes !== length || unchecked.work.sourceBytes !== length ||
      checked.integrity !== (profile === "crc" ? "byte-sum-verified" : "none")
    ) throw new Error("CPIO benchmark costs or integrity differ from the independent payload oracle.");
    const label = `cpio/${profile}/${name} member=${expected.length}B prefix=${length}B`;
    bench(`${label} native Blob prefix: source=${length}B integrity=none`, async () => {
      do_not_optimize(await native());
    });
    bench(
      `${label} warm unchecked: source=${unchecked.work.sourceBytes}B decoded=${unchecked.work.decodedBytes}B output=${length}B`,
      async () => {
        do_not_optimize(await archive.read(entry.id, { length, verify: false }));
      },
    );
    bench(
      `${label} warm ${checked.integrity}: source=${checked.work.sourceBytes}B decoded=${checked.work.decodedBytes}B output=${length}B`,
      async () => {
        do_not_optimize(await archive.read(entry.id, { length }));
      },
    );
    bench(
      `${label} cold index + ${checked.integrity}: source=${
        archive.work.sourceBytes + checked.work.sourceBytes
      }B decoded=${archive.work.decodedBytes + checked.work.decodedBytes}B output=${length}B`,
      async () => {
        const cold = await openCpio(source);
        do_not_optimize(await cold.read(entry.id, { length }));
      },
    );
  }
}

await report();
