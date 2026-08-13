import { FileSystemError } from "../src/error.ts";
import { basename, dirname, joinPath, normalizePath, splitPath } from "../src/path.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`Expected ${expectedJson}, got ${actualJson}.`);
  }
}

Deno.test("normalizes virtual filesystem paths", () => {
  assertEquals(normalizePath("a/./b/../c"), "/a/c");
  assertEquals(splitPath("/a/c"), ["a", "c"]);
  assertEquals(joinPath("/a", "b", "../c"), "/a/c");
  assertEquals(dirname("/a/c"), "/a");
  assertEquals(basename("/a/c"), "c");
});

Deno.test("rejects paths that escape above the virtual root", () => {
  try {
    normalizePath("../../outside");
  } catch (error) {
    if (error instanceof FileSystemError && error.code === "invalid-path") return;
    throw error;
  }
  throw new Error("Expected normalizePath() to reject root escape.");
});
