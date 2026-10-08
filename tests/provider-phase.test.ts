import { describe, it } from "node:test";
import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { phase } from "../bench/provider-phase.ts";
import type { ProviderPhaseType } from "../bench/provider-phase.ts";
import { within } from "./gate.ts";
import { withReleases } from "./close.ts";

/** Fixtures never dial this endpoint; only its diagnostic origin is admitted. */
const endpoint = "http://name:secret@172.17.0.1:32123/devstoreaccount1?signature=private#fragment";
/** Test-owned labels are observations, not a source-code wording oracle. */
const label = "authored direct byte check";

/** Capture thrown undefined independently from successful resolution. */
async function rejection(action: Promise<unknown>): Promise<unknown> {
  let failed = false;
  let observed: unknown;
  try {
    await action;
  } catch (reason) {
    failed = true;
    observed = reason;
  }
  strictEqual(failed, true);
  return observed;
}

describe("Untimed provider phase evidence", () => {
  it("records start before admission and pass after settlement, preserving result identity", async () => {
    await withReleases(async (releases) => {
      let release = () => {};
      const gate = new Promise<void>((resolve) => release = resolve);
      releases.push(release);
      const result = { bytes: new Uint8Array([17, 48, 79]) };
      const events: ProviderPhaseType[] = [];
      let called = 0;
      const pending = phase(label, endpoint, async () => {
        called += 1;
        deepStrictEqual(events, [{ providerPhase: label, state: "start", origin: "http://172.17.0.1:32123" }]);
        await gate;
        return result;
      }, (event) => events.push(event));
      releases.push(() => pending);
      releases.push(release);
      strictEqual(called, 1);
      strictEqual(events.length, 1);
      release();
      strictEqual(await within(pending, "provider phase settlement"), result);
      deepStrictEqual(events, [
        { providerPhase: label, state: "start", origin: "http://172.17.0.1:32123" },
        { providerPhase: label, state: "pass", origin: "http://172.17.0.1:32123" },
      ]);
    });
  });

  for (const reason of [undefined, null, new Error("authored operation rejection")]) {
    it(`preserves original ${reason === undefined ? "undefined" : reason === null ? "null" : "Error"} failure`, async () => {
      const events: ProviderPhaseType[] = [];
      let called = 0;
      const observed = await rejection(phase(label, endpoint, () => {
        called += 1;
        throw reason;
      }, (event) => events.push(event)));
      strictEqual(observed, reason);
      strictEqual(called, 1);
      deepStrictEqual(events.map(({ providerPhase, state, origin }) => ({ providerPhase, state, origin })), [
        { providerPhase: label, state: "start", origin: "http://172.17.0.1:32123" },
        { providerPhase: label, state: "fail", origin: "http://172.17.0.1:32123" },
      ]);
      strictEqual(Object.hasOwn(events[1]!, "failure"), true);
    });
  }

  it("serializes nested failure accessors inertly without reading signed endpoint data", async () => {
    let getters = 0;
    const reason = new Error("authored transport failure", { cause: { code: "TEST_CONNECT" } });
    Object.defineProperty(reason, "name", {
      get() {
        getters += 1;
        return "borrowed getter";
      },
    });
    const events: ProviderPhaseType[] = [];
    strictEqual(
      await rejection(phase(label, endpoint, () => {
        throw reason;
      }, (event) => events.push(event))),
      reason,
    );
    strictEqual(getters, 0);
    const failure = events[1]?.failure;
    strictEqual(typeof failure, "object");
    if (failure === null || typeof failure !== "object") throw new Error("Expected a structured diagnostic.");
    deepStrictEqual(Reflect.get(failure, "name"), { accessor: true });
    deepStrictEqual(Reflect.get(failure, "cause"), { code: "TEST_CONNECT" });
    for (const event of events) strictEqual(event.origin, "http://172.17.0.1:32123");
    strictEqual(JSON.stringify(events).includes("signature=private"), false);
    strictEqual(JSON.stringify(events).includes("name:secret"), false);
    strictEqual(JSON.stringify(events).includes("devstoreaccount1"), false);
  });

  it("a failed start record refuses operation effects", async () => {
    const failure = new Error("authored evidence failure");
    let effects = 0;
    const observed = await rejection(phase(label, endpoint, () => {
      effects += 1;
    }, () => {
      throw failure;
    }));
    strictEqual(observed, failure);
    strictEqual(effects, 0);
  });

  it("retains operation and failure-record faults as independent exact reasons", async () => {
    const evidence = new Error("authored evidence failure");
    for (const primary of [undefined, null, new Error("authored operation failure")]) {
      const states: string[] = [];
      const observed = await rejection(phase(label, endpoint, () => {
        throw primary;
      }, (event) => {
        states.push(event.state);
        if (event.state === "fail") throw evidence;
      }));
      strictEqual(observed instanceof AggregateError, true);
      if (!(observed instanceof AggregateError)) throw new Error("Expected independent failures.");
      strictEqual(observed.cause, primary);
      strictEqual(observed.errors.length, 2);
      strictEqual(observed.errors[0], primary);
      strictEqual(observed.errors[1], evidence);
      deepStrictEqual(states, ["start", "fail"]);
    }
  });

  it("a failed pass record refuses certification without inventing an operation failure", async () => {
    const evidence = new Error("authored terminal evidence failure");
    let effects = 0;
    const states: string[] = [];
    const observed = await rejection(phase(label, endpoint, () => {
      effects += 1;
      return 79;
    }, (event) => {
      states.push(event.state);
      if (event.state === "pass") throw evidence;
    }));
    strictEqual(observed, evidence);
    strictEqual(effects, 1);
    deepStrictEqual(states, ["start", "pass"]);
  });

  it("rejects oversized authored context before operation or diagnostic effects", async () => {
    let effects = 0;
    let events = 0;
    for (const invalid of ["", "x".repeat(161)]) {
      strictEqual(
        await rejection(phase(invalid, endpoint, () => {
          effects += 1;
        }, () => {
          events += 1;
        })) instanceof RangeError,
        true,
      );
    }
    strictEqual(effects, 0);
    strictEqual(events, 0);
  });
});
