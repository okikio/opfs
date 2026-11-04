import { test as base } from "@playwright/test";
import type { BrowserContext, Frame, Page, Request, Response } from "@playwright/test";
import { withReleases } from "../close.ts";

/** Acquisition time is separate from the ordinary functional test body. */
export const READY_TIMEOUT = 90_000;
/** Leave the owning fixture time to close its page after native admission settles. */
const RETIREMENT_TIMEOUT = 30_000;
/** Fixed fixture entrypoints declare exactly which module API must be installed. */
export type EntryType = "app" | "upstream" | "benchmark" | "opaque";

/** Bounded observations explain acquisition failures without admitting a late result. */
interface ObservationType {
  readonly kind: "page" | "request" | "response";
  readonly message: string;
  readonly url?: string;
  readonly status?: number;
}

/** Native failure and acquisition stage remain inspectable without message matching. */
export class AdmissionError extends Error {
  /** The stage that refused to hand the document to its consumer. */
  readonly stage: "navigation" | "api";
  /** Why the acquisition failed; a timeout remains different from a malformed API. */
  readonly category: "native" | "shape" | "owner";
  /** Bounded actual load observations, independent from the native failure cause. */
  readonly observations: readonly ObservationType[];

  constructor(
    stage: AdmissionError["stage"],
    category: AdmissionError["category"],
    cause: unknown,
    observations: readonly ObservationType[] = [],
  ) {
    super(`Browser fixture admission failed during ${stage}.`, { cause });
    this.name = "AdmissionError";
    this.stage = stage;
    this.category = category;
    this.observations = observations;
  }
}

/** Refuses dispatch after expiry; every native wait leaves the same retirement reserve. */
export function remaining(deadline: number, stage: AdmissionError["stage"]): number {
  const value = Math.floor(deadline - performance.now() - RETIREMENT_TIMEOUT);
  if (!Number.isFinite(value) || value < 1) throw new AdmissionError(stage, "owner", undefined);
  return value;
}

/** Routes are authored test inputs; no storage probe or work is performed during admission. */
function url(entry: Exclude<EntryType, "opaque">): string {
  return `http://127.0.0.1:4173/tests/browser/fixtures/${
    entry === "app" ? "index" : entry === "benchmark" ? "benchmark" : "upstream"
  }.html`;
}

/**
 * Admits one existing realm. Its caller owns the page/context and retirement.
 * Numeric polling observes module installation independently of rendering.
 * Shape or native load failures remain failures even if an API appears later.
 */
export async function admit(
  frame: Frame,
  entry: EntryType,
  deadline: number,
  navigation?: { readonly url: string } | { readonly reload: true },
): Promise<void> {
  let stage: AdmissionError["stage"] = navigation === undefined ? "api" : "navigation";
  remaining(deadline, stage);
  const page = frame.page();
  const controller = new AbortController();
  const observations: ObservationType[] = [];
  let failed = false;
  let primary: unknown;
  let navigating = navigation !== undefined;
  const responses = new WeakSet<Response>();
  const fail = (cause: unknown, observation: ObservationType) => {
    if (observations.length < 16) observations.push(observation);
    if (!failed) {
      failed = true;
      primary = cause;
    }
    // Native navigation must settle its own transaction before the fixture refuses admission.
    if (!navigating && !controller.signal.aborted) controller.abort(primary);
  };
  // The caller owns this isolated fixture page; no external application page is watched.
  const onError = (error: Error) => fail(error, { kind: "page", message: error.message.slice(0, 2048) });
  const onRequest = (request: Request) => {
    // Only scripts in the admitted document's origin belong to this module acquisition.
    if (
      request.resourceType() !== "script" ||
      new URL(request.url()).origin !==
        new URL(navigation !== undefined && "url" in navigation ? navigation.url : frame.url()).origin
    ) return;
    const error = new Error(request.failure()?.errorText ?? "Fixture script request failed.");
    fail(error, {
      kind: "request",
      message: error.message.slice(0, 2048),
      url: new URL(request.url()).pathname.slice(0, 2048),
    });
  };
  const onResponse = (response: Response) => {
    if (response.status() < 400 || responses.has(response)) return;
    const request = response.request();
    const target = new URL(navigation !== undefined && "url" in navigation ? navigation.url : frame.url());
    const actual = new URL(response.url());
    const script = request.resourceType() === "script" && actual.origin === target.origin;
    const document = request.isNavigationRequest() && request.frame() === frame;
    if (!script && !document) return;
    responses.add(response);
    fail(new Error("Fixture resource returned an HTTP failure."), {
      kind: "response",
      message: "Fixture resource returned an HTTP failure.",
      url: actual.pathname.slice(0, 2048),
      status: response.status(),
    });
  };
  page.on("response", onResponse);
  page.on("pageerror", onError);
  page.on("requestfailed", onRequest);
  try {
    if (navigation !== undefined) {
      const options = {
        waitUntil: "domcontentloaded" as const,
        timeout: remaining(deadline, stage),
        signal: controller.signal,
      };
      try {
        const response = "url" in navigation ? await frame.goto(navigation.url, options) : await page.reload(options);
        // A returned main response remains authoritative when an engine omits its event.
        if (response !== null) onResponse(response);
      } finally {
        navigating = false;
      }
      if (failed) throw primary;
    }
    stage = "api";
    const result = await frame.waitForFunction(
      (entry) => {
        const fixture = globalThis as typeof globalThis & Record<string, unknown>;
        if (entry === "opaque") return fixture.ready === true ? "ready" : false;
        const name = entry === "upstream" ? "upstreamTest" : "opfsTest";
        const api = fixture[name];
        if (api === undefined) return false;
        if (typeof api !== "object" || api === null) return "invalid";
        const value = api as Record<string, unknown>;
        const methods = entry === "upstream" ? ["directory", "sync"] : [
          "probe",
          "roundTrip",
          "read",
          "dedicated",
          "shared",
          "service",
          "abort",
          "queuedAbort",
          "adapter",
          "indexedDbAppend",
          "providerBody",
          "benchmark",
          "benchmarkAdapter",
        ];
        if (!methods.every((method) => typeof value[method] === "function")) return "invalid";
        if (entry !== "upstream" && value.ready !== true) return "invalid";
        if (entry !== "upstream") {
          const reliability = fixture.opfsReliability;
          if (
            typeof reliability !== "object" || reliability === null ||
            !["bytes", "failure", "write"].every((method) =>
              typeof (reliability as Record<string, unknown>)[method] === "function"
            )
          ) return "invalid";
        }
        if (entry === "benchmark" && fixture.opfsBenchmarkReady !== true) return false;
        return "ready";
      },
      entry,
      { polling: 50, timeout: remaining(deadline, stage), signal: controller.signal },
    );
    await withReleases(async (releases) => {
      releases.push(() => result.dispose());
      if (await result.jsonValue() !== "ready") throw new AdmissionError("api", "shape", undefined, observations);
    });
    remaining(deadline, "api");
    if (failed) throw primary;
  } catch (error) {
    if (error instanceof AdmissionError && !failed) throw error;
    const cause = failed && error !== primary
      ? new AggregateError([primary, error], "Fixture load and native admission failed.", { cause: primary })
      : failed
      ? primary
      : error;
    throw new AdmissionError(stage, "native", cause, observations);
  } finally {
    page.off("response", onResponse);
    page.off("pageerror", onError);
    page.off("requestfailed", onRequest);
  }
}

/** Native navigation is bounded independently from subsequent API installation. */
export async function navigate(page: Page, entry: Exclude<EntryType, "opaque">, deadline: number): Promise<void> {
  await admit(page.mainFrame(), entry, deadline, { url: url(entry) });
}

/** Reload remains an actual scenario action; its caller supplies the finite scenario owner. */
export async function reload(page: Page, entry: Exclude<EntryType, "opaque">, deadline: number): Promise<void> {
  await admit(page.mainFrame(), entry, deadline, { reload: true });
}

/** Acquires an owned page in a borrowed context and registers close before navigation can fail. */
export async function open(
  context: BrowserContext,
  entry: Exclude<EntryType, "opaque">,
  releases: Array<() => void | Promise<unknown>>,
  deadline: number,
): Promise<Page> {
  remaining(deadline, "navigation");
  const page = await context.newPage();
  let closing: Promise<void> | undefined;
  releases.push(() => closing ??= page.close());
  remaining(deadline, "navigation");
  await navigate(page, entry, deadline);
  return page;
}

/** Consumers select an entry, then receive its actual callable API before their body starts. */
export const test = base.extend<{ entry: Exclude<EntryType, "opaque">; ready: Page }>({
  entry: ["app", { option: true }],
  ready: [async ({ context, entry }, use) => {
    await withReleases(async (releases) => {
      const page = await open(context, entry, releases, performance.now() + READY_TIMEOUT);
      await use(page);
    });
  }, { timeout: READY_TIMEOUT }],
});
