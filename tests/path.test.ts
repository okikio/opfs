import { describe, it } from "node:test";
import { expect } from "@std/expect";

import { FileSystemError } from "../src/error.ts";
import { basename, dirname, joinPath, normalizePath, splitPath } from "../src/path.ts";
import { PathSchema } from "../src/schema.ts";

describe("virtual paths", () => {
  it("exposes project schemas through the Standard Schema contract implemented by Zod", () => {
    expect("~standard" in PathSchema).toBe(true);
  });

  it("normalizes relative and dot segments", () => {
    expect(normalizePath("a/./b/../c")).toBe("/a/c");
    expect(splitPath("/a/c")).toEqual(["a", "c"]);
    expect(joinPath("/a", "b", "../c")).toBe("/a/c");
    expect(dirname("/a/c")).toBe("/a");
    expect(basename("/a/c")).toBe("c");
  });

  it("rejects escape above the virtual root", () => {
    expect(() => normalizePath("../../outside")).toThrow(FileSystemError);
    try {
      normalizePath("../../outside");
    } catch (error) {
      expect(error).toBeInstanceOf(FileSystemError);
      if (error instanceof FileSystemError) expect(error.code).toBe("invalid-path");
    }
  });
});
