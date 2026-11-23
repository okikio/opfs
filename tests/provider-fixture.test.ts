import { describe, it } from "node:test";
import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { openProviders, ProviderFixture } from "./provider/fixture.ts";
import type { AzureProviderType, S3ProviderType } from "./provider/fixture.ts";
import { within } from "./gate.ts";
import { withReleases } from "./close.ts";

/** Controlled resource observations use only the SDK methods consumed by the fixture, never fake Docker success. */
function s3(stop: () => Promise<unknown>, port = () => 32123): S3ProviderType {
  return { stop, getHost: () => "172.17.0.1", getMappedPort: port };
}

/** Endpoint acquisition remains a fallible observation after this resource has an owner. */
function azure(
  stop: () => Promise<unknown>,
  endpoint = () => "http://172.17.0.1:32124/devstoreaccount1",
): AzureProviderType {
  return { stop, getBlobEndpoint: endpoint };
}

/** A semantic release barrier has a bounded external watchdog, not a scheduling-delay oracle. */
function gate(): { readonly promise: Promise<void>; readonly release: () => void } {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => release = resolve);
  return { promise, release };
}

describe("Provider fixture resource ownership", () => {
  it("concurrent and reentrant close share pending retirement before the next resource stops", async () => {
    await withReleases(async (releases) => {
      const admitted = gate();
      const finish = gate();
      const calls: string[] = [];
      let reentrant: Promise<void> | undefined;
      const fixture = new ProviderFixture(
        s3(async () => calls.push("s3")),
        azure(async () => {
          calls.push("azure");
          reentrant = fixture.close();
          admitted.release();
          await finish.promise;
        }),
        "http://172.17.0.1:32124/devstoreaccount1",
      );
      releases.push(() => fixture.close());
      releases.push(finish.release);
      const first = fixture.close();
      await within(admitted.promise, "Azure retirement admission");
      strictEqual(fixture.close(), first);
      strictEqual(reentrant, first);
      deepStrictEqual(calls, ["azure"]);
      finish.release();
      await within(first, "complete fixture retirement");
      deepStrictEqual(calls, ["azure", "s3"]);
      strictEqual(fixture.close(), first);
      await fixture.close();
      deepStrictEqual(calls, ["azure", "s3"]);
    });
  });

  it("repeated failed close retains the same original reasons and does not stop twice", async () => {
    const a = new Error("authored Azure retirement failure");
    const b = new Error("authored S3 retirement failure");
    const calls: string[] = [];
    const fixture = new ProviderFixture(
      s3(async () => {
        calls.push("s3");
        throw b;
      }),
      azure(async () => {
        calls.push("azure");
        throw a;
      }),
      "http://172.17.0.1:32124/devstoreaccount1",
    );
    const first = fixture.close();
    let observed: unknown;
    await rejects(first, (reason: unknown) => {
      observed = reason;
      if (!(reason instanceof AggregateError)) return false;
      strictEqual(reason.cause, a);
      deepStrictEqual(reason.errors, [a, b]);
      return true;
    });
    strictEqual(fixture.close(), first);
    await rejects(fixture.close(), (reason: unknown) => reason === observed);
    deepStrictEqual(calls, ["azure", "s3"]);
  });

  for (const primary of [undefined, null, new Error("authored Azure startup failure")]) {
    it(`partial startup retains ${primary === undefined ? "undefined" : primary === null ? "null" : "Error"} and releases S3`, async () => {
      const calls: string[] = [];
      let failed = false;
      let observed: unknown;
      try {
        await openProviders({
          s3: async () => s3(async () => calls.push("s3")),
          azure: async () => {
            throw primary;
          },
        });
      } catch (reason) {
        failed = true;
        observed = reason;
      }
      strictEqual(failed, true);
      strictEqual(observed, primary);
      deepStrictEqual(calls, ["s3"]);
    });
  }

  it("partial startup retains cleanup failure independently from an undefined original reason", async () => {
    const cleanup = new Error("authored S3 cleanup failure");
    const calls: string[] = [];
    await rejects(
      openProviders({
        s3: async () =>
          s3(async () => {
            calls.push("s3");
            throw cleanup;
          }),
        azure: async () => {
          throw undefined;
        },
      }),
      (reason: unknown) => {
        if (!(reason instanceof AggregateError)) return false;
        strictEqual(reason.cause, undefined);
        deepStrictEqual(reason.errors, [undefined, cleanup]);
        return true;
      },
    );
    deepStrictEqual(calls, ["s3"]);
  });

  for (const stage of ["azure-endpoint", "s3-construction"] as const) {
    it(`releases both acquired resources after ${stage} observation fails`, async () => {
      const primary = new Error(`authored ${stage} failure`);
      const calls: string[] = [];
      await rejects(
        openProviders({
          s3: async () =>
            s3(async () => calls.push("s3"), () => {
              if (stage === "s3-construction") throw primary;
              return 32123;
            }),
          azure: async () =>
            azure(async () => calls.push("azure"), () => {
              if (stage === "azure-endpoint") throw primary;
              return "http://172.17.0.1:32124/devstoreaccount1";
            }),
        }),
        (reason: unknown) => reason === primary,
      );
      deepStrictEqual(calls, ["azure", "s3"]);
    });
  }

  it("failed metadata observation retains every independent retirement fault", async () => {
    const primary = new Error("authored endpoint failure");
    const a = new Error("authored Azure cleanup failure");
    const b = new Error("authored S3 cleanup failure");
    const calls: string[] = [];
    await rejects(
      openProviders({
        s3: async () =>
          s3(async () => {
            calls.push("s3");
            throw b;
          }),
        azure: async () =>
          azure(async () => {
            calls.push("azure");
            throw a;
          }, () => {
            throw primary;
          }),
      }),
      (reason: unknown) => {
        if (!(reason instanceof AggregateError)) return false;
        strictEqual(reason.cause, primary);
        deepStrictEqual(reason.errors, [primary, a, b]);
        return true;
      },
    );
    deepStrictEqual(calls, ["azure", "s3"]);
  });
});
