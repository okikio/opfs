import assert from "node:assert/strict";
import { test } from "node:test";
import { admit, baseline, runs } from "./evidence.ts";

const repository = "okikio/utils";
const scope = { repository, branch: "main" };
const a = "a".repeat(40), b = "b".repeat(40), c = "c".repeat(40), d = "d".repeat(40);

/** A main-push run that passed, unless a test overrides a field. */
const run = (id: number, sha: string, fields: Record<string, unknown> = {}) => ({
  id,
  run_attempt: 1,
  head_sha: sha,
  head_branch: "main",
  event: "push",
  status: "completed",
  conclusion: "success",
  created_at: new Date(Date.UTC(2026, 10, 1, 0, id)).toISOString(),
  repository: { full_name: repository },
  head_repository: { full_name: repository },
  ...fields,
});

test("admit returns the latest passing push run for the exact commit", () => {
  assert.equal(admit([run(1, a), run(3, a), run(2, b)], { ...scope, revision: a }), 3);
});

test("admit rejects a commit whose latest run failed or is still running, even after an earlier pass", () => {
  assert.throws(
    () => admit([run(1, a), run(2, a, { conclusion: "failure" })], { ...scope, revision: a }),
    /has not passed/,
  );
  assert.throws(
    () => admit([run(1, a), run(2, a, { status: "in_progress", conclusion: null })], { ...scope, revision: a }),
    /has not passed/,
  );
});

test("admit ignores runs that are not pushes to main from this repository", () => {
  const others = [
    run(5, a, { event: "workflow_dispatch" }),
    run(6, a, { head_branch: "feature" }),
    run(7, a, { head_repository: { full_name: "someone/utils" } }),
    run(8, b),
  ];
  assert.throws(() => admit(others, { ...scope, revision: a }), /No CI run/);
  assert.equal(admit([run(4, a), ...others], { ...scope, revision: a }), 4);
});

test("admit refuses a push run with a malformed id or commit", () => {
  assert.throws(() => admit([run(0, a)], { ...scope, revision: a }), /valid id/);
  assert.throws(() => admit([run(1, "main")], { ...scope, revision: a }), /valid id/);
});

test("baseline picks the newest passing ancestor and skips commits outside the history", () => {
  // c is on another line of history; b is the newest passing ancestor of d.
  const ancestors = new Set([a, b]);
  const found = baseline(
    [run(1, a), run(2, b), run(3, c)],
    { ...scope, head: d, current: 9 },
    (base) => ancestors.has(base),
  );
  assert.equal(found, b);
});

test("baseline skips failed runs, the current run and runs created after it", () => {
  const list = [
    run(1, a),
    run(2, b, { conclusion: "failure" }),
    run(3, c, { created_at: "2026-11-01T00:10:00.000Z" }),
    run(4, d),
  ];
  // RunType 4 is the current run; run 3 started after it, so only a remains.
  assert.equal(baseline(list, { ...scope, head: d, current: 4 }, () => true), a);
});

test("baseline returns undefined when no passing ancestor exists, so the caller selects all work", () => {
  assert.equal(baseline([run(1, a)], { ...scope, head: d, current: 9 }, () => false), undefined);
  assert.equal(baseline([], { ...scope, head: d }, () => true), undefined);
});

test("runs sends the push and branch filters and rejects a page without runs", async () => {
  let seen: URL | undefined;
  const request = ((url: URL) => {
    seen = url;
    return Promise.resolve(Response.json({ total_count: 1, workflow_runs: [run(1, a)] }));
  }) as typeof fetch;
  const page = await runs({ ...scope, workflow: "ci.yml", token: "t" }, { head_sha: a }, request);
  assert.equal(page.length, 1);
  assert.equal(seen?.pathname, "/repos/okikio/utils/actions/workflows/ci.yml/runs");
  assert.deepEqual(Object.fromEntries(seen!.searchParams), {
    head_sha: a,
    branch: "main",
    event: "push",
    per_page: "100",
  });

  const empty = (() => Promise.resolve(Response.json({ message: "nope" }))) as typeof fetch;
  await assert.rejects(runs({ ...scope, workflow: "ci.yml", token: "t" }, {}, empty), /without workflow_runs/);
  const denied = (() => Promise.resolve(new Response("", { status: 403 }))) as typeof fetch;
  await assert.rejects(runs({ ...scope, workflow: "ci.yml", token: "t" }, {}, denied), /returned 403/);
});
