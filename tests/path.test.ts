import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { SEPARATOR } from "@std/path";

import { FileSystemError } from "../src/error.ts";
import { basename, dirname, isAncestorPath, joinPath, normalizePath, splitPath } from "../src/path.ts";
import { PathSchema } from "../src/schema.ts";

describe("virtual paths", () => {
  it("validates canonical paths through the Standard Schema contract", async () => {
    for (const path of ["/", "/a/c", "/日本語 space"]) {
      expect(await PathSchema["~standard"].validate(path)).toEqual({ value: path });
    }
    for (const path of ["relative", "/a/../b", "/trailing/", "/a//b", "/a\\b", "/null\0byte"]) {
      const result = await PathSchema["~standard"].validate(path);
      expect(result.issues?.length).toBeGreaterThan(0);
    }
  });

  it("normalizes relative and dot segments", () => {
    expect(normalizePath("a/./b/../c")).toBe("/a/c");
    expect(splitPath("/a/c")).toEqual(["a", "c"]);
    expect(joinPath("/a", "b", "../c")).toBe("/a/c");
    expect(dirname("/a/c")).toBe("/a");
    expect(basename("/a/c")).toBe("c");
  });

  it("preserves Unicode spelling and distinguishes ancestry from a name prefix", () => {
    expect(normalizePath("/caf\u00e9")).not.toBe(normalizePath("/cafe\u0301"));
    expect(isAncestorPath("/a", "/a/c")).toBe(true);
    expect(isAncestorPath("/a", "/ab/c")).toBe(false);
    expect(isAncestorPath("/a", "/a")).toBe(false);
    expect(() => normalizePath("a\\b")).toThrow(FileSystemError);
  });

  it("rejects escape above the virtual root", () => {
    try {
      normalizePath("../../outside");
      throw new Error("Root escape unexpectedly normalized.");
    } catch (error) {
      expect(error).toBeInstanceOf(FileSystemError);
      if (error instanceof FileSystemError) expect(error.code).toBe("invalid-path");
    }
  });
});

it("rejects forged record identities and noncanonical or mismatched base64 before decoding", async () => {
  const { RecordSchema, FileRecordSchema, DirectoryRecordSchema } = await import("../src/schema.ts");
  const file = {
    version: 1,
    path: "/tree/file",
    parent: "/tree",
    name: "file",
    kind: "file",
    lastModified: 0,
    data: "AQ==",
    size: 1,
    mediaType: "",
  };
  expect(RecordSchema.safeParse(file).success).toBe(true);
  for (
    const changes of [
      { name: "../victim" },
      { name: ".." },
      { parent: "/" },
      { path: "/other" },
      { data: "AQ==", size: 0 },
      { data: "AR==" },
      { data: "AQ" },
      { data: "!!!!" },
    ]
  ) {
    expect(RecordSchema.safeParse({ ...file, ...changes }).success).toBe(false);
    expect(FileRecordSchema.safeParse({ ...file, ...changes }).success).toBe(false);
  }
  expect(DirectoryRecordSchema.safeParse({ ...file, kind: "directory", name: "../victim" }).success).toBe(false);
});

it("rejects Windows stream, trimming and device aliases in the host mapper", { skip: SEPARATOR !== "\\" }, async () => {
  const { LocalPath } = await import("../src/driver/local.ts");
  const mapper = new LocalPath(".");
  for (const path of ["/victim::$DATA", "/victim:stream", "/victim.", "/victim ", "/CON", "/nul.txt"]) {
    expect(() => mapper.get(path)).toThrow(TypeError);
  }
});
