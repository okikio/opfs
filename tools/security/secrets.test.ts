import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { inspect } from "./secrets.ts";

/** Native Trace2 records from one Git process, with unrelated version and cleanup events retained. */
function records(command: string, code: number, sid = "scan"): Record<string, unknown>[] {
  return [
    { event: "version", sid, exe: "2.51.0" },
    { event: "start", sid, argv: ["git", "-C", ".", command, "-p"] },
    { event: "cmd_name", sid, name: command, hierarchy: command },
    { event: "exit", sid, code },
    { event: "atexit", sid, code },
  ];
}

/** Encode line-delimited events as Git writes them, including the final newline. */
function trace(events: readonly Record<string, unknown>[]): string {
  return events.map((event) => JSON.stringify(event)).join("\n") + "\n";
}

describe("Git traversal evidence", () => {
  for (const command of ["log", "diff"]) {
    it(`accepts a completed ${command} traversal`, () => {
      expect(inspect(trace(records(command, 0)))).toBe(1);
    });
  }
  it("keeps an optional remote-metadata failure separate from successful patch input", () => {
    expect(inspect(trace([...records("log", 0), ...records("ls-remote", 128, "metadata")]))).toBe(1);
  });
  it("rejects the native Git failure that a scanner can hide behind exit zero", () => {
    expect(() => inspect(trace(records("log", 128)))).toThrow("Git log failed with exit code 128");
  });
  it("requires a process exit even when a cleanup event is present", () => {
    expect(() => inspect(trace(records("log", 0).filter((event) => event.event !== "exit"))))
      .toThrow("complete Trace2 status evidence");
  });
  it("rejects a traversal interrupted before Git reports its command name", () => {
    expect(() => inspect(trace(records("log", 0).filter((event) => event.event !== "cmd_name"))))
      .toThrow("complete Trace2 status evidence");
  });
  it("rejects a command record without its process start", () => {
    expect(() => inspect(trace(records("log", 0).filter((event) => event.event !== "start"))))
      .toThrow("complete Trace2 status evidence");
  });
  it("checks archive blob readers as well as the patch traversal", () => {
    expect(() => inspect(trace([...records("log", 0), ...records("cat-file", 128, "archive")])))
      .toThrow("Git cat-file failed with exit code 128");
  });
  it("does not accept an unrelated Git command as proof of a scan", () => {
    expect(() => inspect(trace(records("ls-remote", 0)))).toThrow("No completed Git traversal");
  });
  for (const input of ["", "{unfinished", "null\n", "[]\n", '{"event":"exit","code":0}\n']) {
    it(`rejects missing or malformed evidence ${JSON.stringify(input)}`, () => {
      expect(() => inspect(input)).toThrow();
    });
  }
  it("rejects a nonnumeric exit without copying raw arguments into its error", () => {
    const events = records("log", 0);
    events[1]!.argv = ["git", "-C", "private-argument", "log"];
    events[3]!.code = "0";
    expect(() => inspect(trace(events))).toThrow("malformed Trace2 exit evidence");
    expect(() => inspect(trace(events))).not.toThrow("private-argument");
  });
  it("rejects conflicting exit records for the same process", () => {
    expect(() => inspect(trace([...records("log", 0), { event: "exit", sid: "scan", code: 128 }])))
      .toThrow("conflicting Trace2 exit evidence");
  });
});
