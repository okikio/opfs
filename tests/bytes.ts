import { expect } from "@std/expect";

/** Compare every payload byte while retaining only the first differing offset.
 * Recursive rich matchers can allocate per-byte state for MiB-sized native fixtures.
 */
export function expectBytes(actual: Uint8Array, expected: Uint8Array, context = "payload"): void {
  expect(actual.length, `${context}: byte length`).toBe(expected.length);
  expect(actual.findIndex((byte, index) => byte !== expected[index]), `${context}: first differing byte`).toBe(-1);
}
