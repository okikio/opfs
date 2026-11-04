import { expect } from "@playwright/test";
import { test } from "./ready.ts";
import type { LaneType } from "./fixtures/indexeddb.ts";

const before = {
  version: 1,
  path: "/a",
  parent: "/",
  name: "a",
  kind: "file",
  data: "YQ==",
  size: 1,
  lastModified: 7,
  mediaType: "text/plain",
};

for (const kind of ["undefined", "null", "error"] as const) {
  for (
    const lane of [
      "setup-before",
      "setup-after",
      "store-before",
      "store-after",
      "request-before",
      "request-after",
      "signal-before",
      "signal-after",
      "signal-abort-throw",
      "effect-abort",
      "effect-abort-throw",
      "abort-before",
      "detach",
      "two-detaches",
      "primary-detaches",
      "primary-abort",
      "result-getter",
      "state-getter",
    ] as const satisfies readonly LaneType[]
  ) {
    test(`IndexedDB ${lane} retains ${kind} and retires the actual transaction`, async ({ ready: page }) => {
      const observed = await page.evaluate(async ({ lane, kind }) => {
        const source = new URL("/tests/browser/fixtures/indexeddb.ts", location.href).href;
        const fixture = await import(source) as typeof import("./fixtures/indexeddb.ts");
        return await fixture.run(lane, kind);
      }, { lane, kind });
      const committed = lane === "detach" || lane === "two-detaches";
      expect(observed.events).toEqual([committed || lane === "abort-before" ? "complete" : "abort"]);
      const expected = lane === "signal-abort-throw" || lane === "effect-abort-throw"
        ? ["caller", "primary"]
        : lane === "effect-abort"
        ? ["caller"]
        : lane === "primary-detaches"
        ? ["primary", "primary", "primary"]
        : lane === "request-before" || lane === "request-after" || lane === "state-getter"
        ? ["primary", "native"]
        : lane === "two-detaches" || lane === "primary-abort" || lane === "abort-before"
        ? ["primary", "primary"]
        : ["primary"];
      expect(observed.faults).toEqual(expected);
      expect(observed.callerCause).toBe(lane === "signal-abort-throw" || lane.startsWith("effect-"));
      for (const request of observed.requests) expect(request.removed).toEqual(["success", "error"]);
      // Each possibly installed terminal observer is retired even after an earlier refusal.
      expect(observed.removed.slice(0, 2)).toEqual(["complete", "abort"]);
      if (lane.startsWith("signal-")) expect(observed.removed).toEqual(["complete", "abort", "signal:abort"]);
      if (lane.startsWith("effect-")) {
        expect(observed.removed).toEqual(["complete", "abort", "signal:abort", "success", "error"]);
      }
      if (committed) {
        expect(observed.persisted).toMatchObject({ ...before, data: "Yg==", lastModified: expect.any(Number) });
      } else {
        expect(observed.persisted).toEqual(before);
      }
    });
  }
}

test("IndexedDB ordinary write joins commit before reporting success", async ({ ready: page }) => {
  const observed = await page.evaluate(async () => {
    const source = new URL("/tests/browser/fixtures/indexeddb.ts", location.href).href;
    const fixture = await import(source) as typeof import("./fixtures/indexeddb.ts");
    return await fixture.run("success", "error");
  });
  expect(observed.events).toEqual(["complete"]);
  expect(observed.faults).toEqual([]);
  expect(observed.persisted).toMatchObject({ ...before, data: "Yg==", lastModified: expect.any(Number) });
  expect(observed.removed).toEqual(["complete", "abort", "success", "error", "success", "error"]);
  expect(observed.requests).toEqual([
    { operation: "get", installed: ["success", "error"], removed: ["success", "error"] },
    { operation: "put", installed: ["success", "error"], removed: ["success", "error"] },
  ]);
});

test("IndexedDB recoverable request error still commits and preserves caller handlers", async ({ ready: page }) => {
  const observed = await page.evaluate(async () => {
    const source = new URL("/tests/browser/fixtures/indexeddb.ts", location.href).href;
    const fixture = await import(source) as typeof import("./fixtures/indexeddb.ts");
    return await fixture.recovered();
  });
  expect(observed).toEqual({
    callerComplete: 1,
    callerError: 1,
    callerSuccess: 1,
    persisted: { ...before, data: "Yg==" },
  });
});

for (const operation of ["get", "set", "delete", "list"] as const) {
  for (const lane of ["success", "setup-after", "store-before", "detach"] as const) {
    test(`IndexedDB ${operation} owns ${lane} through physical terminal`, async ({ ready: page }) => {
      const observed = await page.evaluate(async ({ operation, lane }) => {
        const source = new URL("/tests/browser/fixtures/indexeddb.ts", location.href).href;
        const fixture = await import(source) as typeof import("./fixtures/indexeddb.ts");
        return await fixture.run(lane, "null", operation);
      }, { operation, lane });
      const completes = lane === "success" || lane === "detach";
      expect(observed.events).toEqual([completes ? "complete" : "abort"]);
      expect(observed.faults).toEqual(lane === "success" ? [] : ["primary"]);
      expect(observed.removed.slice(0, 2)).toEqual(["complete", "abort"]);
      for (const request of observed.requests) expect(request.removed).toEqual(["success", "error"]);
      if (completes && operation === "delete") expect(observed.persisted).toBeUndefined();
      else expect(observed.persisted).toEqual(completes && operation === "set" ? { ...before, data: "Yg==" } : before);
    });
  }
}

for (const kind of ["undefined", "null", "error"] as const) {
  for (const lane of ["upgrade", "upgrade-abort-before", "upgrade-abort-after", "detach", "create", "close"] as const) {
    test(`IndexedDB unpublished ${lane} rollback retains ${kind}`, async ({ ready: page }) => {
      const observed = await page.evaluate(async ({ lane, kind }) => {
        const source = new URL("/tests/browser/fixtures/indexeddb.ts", location.href).href;
        const fixture = await import(source) as typeof import("./fixtures/indexeddb.ts");
        return await fixture.opening(lane, kind);
      }, { lane, kind });
      expect(observed).toEqual({
        faults: lane === "upgrade-abort-after"
          ? ["primary", "primary", "native"]
          : lane === "upgrade"
          ? ["primary", "native"]
          : lane === "close" || lane === "upgrade-abort-before"
          ? ["primary", "primary"]
          : ["primary"],
        closes: 1,
        abortCalls: lane.startsWith("upgrade") ? 1 : 0,
        schemaRolledBack: lane === "upgrade" || lane === "upgrade-abort-after",
        priorCalls: 0,
        handlerRestored: true,
      });
    });
  }
}

for (const kind of ["undefined", "null", "error"] as const) {
  for (
    const lane of [
      "setup-before",
      "setup-after",
      "setup-prior",
      "setup-both-after",
      "setup-async",
      "setup-release-work",
      "setup-then-getter",
      "setup-then-after",
      "setup-then-reject-throw",
      "setup-state-getter",
      "setup-state-detach",
    ] as const
  ) {
    test(`IndexedDB open ${lane} observes late native success and closes ${kind}`, async ({ ready: page }) => {
      const observed = await page.evaluate(async ({ lane, kind }) => {
        const source = new URL("/tests/browser/fixtures/indexeddb.ts", location.href).href;
        const fixture = await import(source) as typeof import("./fixtures/indexeddb.ts");
        return await fixture.opening(lane, kind);
      }, { lane, kind });
      expect(observed).toEqual({
        faults: lane === "setup-then-reject-throw" ? ["primary", "primary", "primary"] : [
            "setup-prior",
            "setup-both-after",
            "setup-async",
            "setup-then-getter",
            "setup-then-after",
            "setup-state-detach",
          ].includes(lane)
          ? ["primary", "primary"]
          : ["primary"],
        closes: 1,
        abortCalls: 0,
        schemaRolledBack: false,
        priorCalls: 1,
        handlerRestored: true,
      });
    });
  }
}

for (const kind of ["undefined", "null", "error"] as const) {
  test(`IndexedDB fallback preserves false error cancellation beside ${kind}`, async ({ ready: page }) => {
    const observed = await page.evaluate(async (kind) => {
      const source = new URL("/tests/browser/fixtures/indexeddb.ts", location.href).href;
      const fixture = await import(source) as typeof import("./fixtures/indexeddb.ts");
      return await fixture.canceled(kind);
    }, kind);
    expect(observed).toEqual({
      faults: ["primary", "native"],
      callerCalls: 1,
      restored: true,
      persisted: { ...before, data: "Yg==" },
    });
  });
}

for (const kind of ["undefined", "null", "error"] as const) {
  for (
    const lane of [
      "success",
      "error",
      "state-getter",
      "error-getter",
      "result-getter",
      "shadow-error",
      "detach",
      "error-detach",
    ] as const
  ) {
    test(`IndexedDB completed ${lane} admits final fields and retains ${kind}`, async ({ ready: page }) => {
      const observed = await page.evaluate(async ({ lane, kind }) => {
        const source = new URL("/tests/browser/fixtures/indexeddb.ts", location.href).href;
        const fixture = await import(source) as typeof import("./fixtures/indexeddb.ts");
        return await fixture.completed(lane, kind);
      }, { lane, kind });
      const success = lane === "success" || (lane === "shadow-error" && kind === "null");
      expect(observed.state).toBe("done");
      expect(observed.reads).toEqual(
        lane === "state-getter" ? [1, 0, 0] : lane === "error-getter" || lane === "error" || lane === "error-detach" ||
            (lane === "shadow-error" && !success)
          ? [1, 1, 0]
          : [1, 1, 1],
      );
      expect(observed.removed).toEqual(["success", "error"]);
      expect(observed.faults).toEqual(
        success ? [] : lane === "error" ? ["native"] : lane === "error-detach" ? ["native", "primary"] : ["primary"],
      );
      expect(observed.value).toEqual(success ? before : undefined);
      expect(observed.persisted).toEqual(before);
    });
  }
}

for (const kind of ["undefined", "null", "error"] as const) {
  for (const lane of ["fulfill", "reject", "throw", "reject-throw"] as const) {
    test(`IndexedDB fallback adopts ${lane} nested settlement before retiring ${kind}`, async ({ ready: page }) => {
      const observed = await page.evaluate(async ({ lane, kind }) => {
        const source = new URL("/tests/browser/fixtures/indexeddb.ts", location.href).href;
        const fixture = await import(source) as typeof import("./fixtures/indexeddb.ts");
        return await fixture.nested(lane, kind);
      }, { lane, kind });
      expect(observed).toEqual({
        before: {
          settled: false,
          adopted: 1,
          closes: 1,
          removed: ["success", "error", "upgradeneeded"],
          restored: true,
        },
        settled: true,
        faults: Array(lane === "reject-throw" ? 3 : lane === "fulfill" ? 1 : 2).fill("primary"),
      });
    });
  }
}
