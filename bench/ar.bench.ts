import { bench, do_not_optimize } from "mitata";
import { decodeBase64 } from "@std/encoding/base64";
import { createBlobSource } from "../src/source.ts";
import { openAr } from "../src/archive/ar.ts";
import { expectBytes, report } from "./result.ts";
import fixtures from "../tests/fixtures/ar/independent.json" with { type: "json" };

// Question: what do bounded header/name indexing and member-source admission cost
// relative to native preindexed Blob reads? Native gets physical offsets, without
// parsing/budgets. Fixed independent fixtures do not establish remote performance.
for (const profile of ["gnu", "bsd"] as const) {
  const fixture = fixtures[profile];
  const bytes = decodeBase64(fixture.archive);
  const blob = new Blob([new Uint8Array(bytes).buffer]);
  const source = createBlobSource(blob);
  const archive = await openAr(source);
  bench(
    `ar/${profile} cold index archive=${bytes.length}B source=${archive.work.sourceBytes}B requests=${archive.work.requests}`,
    async () => {
      do_not_optimize(await openAr(source));
    },
  );
  if (profile !== "gnu") continue;
  for (const name of ["first.bin", "large.bin"]) {
    const entry = archive.entries.find((entry) => entry.name === name)!;
    const expected = decodeBase64(fixture.entries.find((entry) => entry.name === name)!.body);
    expectBytes((await archive.read(entry.id)).bytes, expected, `ar/${name}/full-payload`);
    for (const offset of name === "large.bin" ? [0, 100000] : [0]) {
      const length = 3;
      const native = () => blob.slice(entry.offset + offset, entry.offset + offset + length).arrayBuffer();
      const result = await archive.read(entry.id, { offset, length });
      const oracle = expected.subarray(offset, offset + length);
      expectBytes(result.bytes, oracle, `ar/${name}/${offset}/read`);
      expectBytes(await archive.member(entry.id).read(offset, length), oracle, `ar/${name}/${offset}/member-source`);
      expectBytes(new Uint8Array(await native()), oracle, `ar/${name}/${offset}/native`);
      if (result.work.sourceBytes !== length || result.work.outputBytes !== length || result.integrity !== "none") {
        throw new Error("ar benchmark work differs from independent byte oracle.");
      }
      const label = `ar/GNU/${name} member=${entry.size}B offset=${offset}B output=${length}B integrity=none`;
      bench(`${label} native preindexed Blob source=${length}B`, async () => {
        do_not_optimize(await native());
      });
      bench(`${label} warm read source=${result.work.sourceBytes}B decoded=${result.work.decodedBytes}B`, async () => {
        do_not_optimize(await archive.read(entry.id, { offset, length }));
      });
      bench(`${label} member-source creation+read source=${length}B`, async () => {
        do_not_optimize(await archive.member(entry.id).read(offset, length));
      });
      bench(
        `${label} cold index+read source=${archive.work.sourceBytes + length}B decoded=${
          archive.work.decodedBytes + length
        }B`,
        async () => {
          const cold = await openAr(source);
          do_not_optimize(await cold.read(entry.id, { offset, length }));
        },
      );
    }
  }
}
await report();
