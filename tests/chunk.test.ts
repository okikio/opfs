import { describe, it } from "node:test";
import { expect } from "@std/expect";

import { split } from "../src/chunk.ts";

describe("byte stream chunking", () => {
  it("forms fixed chunks from pathological one-byte producer chunks", async () => {
    let value = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (value === 10) {
          controller.close();
          return;
        }
        controller.enqueue(Uint8Array.of(value));
        value += 1;
      },
    });

    const output: number[][] = [];
    for await (const chunk of split(source, 4)) output.push([...chunk]);
    expect(output).toEqual([[0, 1, 2, 3], [4, 5, 6, 7], [8, 9]]);
  });

  it("cancels the source when the consumer stops before the stream ends", async () => {
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(8)); },
      cancel() { cancelled = true; },
    });

    for await (const _chunk of split(source, 4)) break;
    expect(cancelled).toBe(true);
  });
});
