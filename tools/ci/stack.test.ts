/** Only the top of a native stack runs the costly checks, and an unreadable stack must never skip them. */
import { it } from "node:test";
import { expect } from "@std/expect";
import * as stack from "./stack.ts";
import type { FetchType, MemberType } from "./stack.ts";

/** A three-layer stack on main: #1 at the bottom, #3 at the top. */
const layers: MemberType[] = [
  { number: 1, state: "open", base: { sha: "main-sha" } },
  { number: 2, state: "open", base: { sha: "one-sha" } },
  { number: 3, state: "open", base: { sha: "two-sha" } },
];

const context = { event: "pull_request", pull: 3, repository: "okikio/utils", api: "https://api.test", token: "t" };

/** Answer each URL path from a table; any other path is a 404. */
function answers(table: Record<string, unknown>): FetchType {
  return (url) => {
    const body = table[new URL(url).pathname];
    return Promise.resolve({
      ok: body !== undefined,
      status: body === undefined ? 404 : 200,
      json: () => Promise.resolve(body),
    });
  };
}

it("selects the top and compares it with the bottom layer base", () => {
  expect(stack.select(3, layers)).toMatchObject({ selected: true, baseSha: "main-sha" });
});

it("defers lower layers to the top", () => {
  expect(stack.select(1, layers)).toMatchObject({ selected: false, baseSha: "" });
  expect(stack.select(2, layers)).toMatchObject({ selected: false, baseSha: "" });
});

it("judges a stack by its open layers after the bottom merges", () => {
  const merged = [{ ...layers[0]!, state: "closed" }, ...layers.slice(1)];
  expect(stack.select(3, merged)).toMatchObject({ selected: true, baseSha: "one-sha" });
});

it("checks a pull request that is not an open member on its own base", () => {
  expect(stack.select(9, layers)).toMatchObject({ selected: true, baseSha: "" });
});

it("reads the stack through the pull request", async () => {
  const request = answers({
    "/repos/okikio/utils/pulls/3": { number: 3, stack: { number: 7 } },
    "/repos/okikio/utils/stacks/7": { number: 7, pull_requests: layers },
  });
  expect(await stack.resolve(context, request)).toMatchObject({ selected: true, baseSha: "main-sha" });
  expect(
    await stack.resolve(
      { ...context, pull: 2 },
      answers({
        "/repos/okikio/utils/pulls/2": { number: 2, stack: { number: 7 } },
        "/repos/okikio/utils/stacks/7": { pull_requests: layers },
      }),
    ),
  ).toMatchObject({ selected: false });
});

it("selects everything when the stack cannot be read", async () => {
  const unstacked = answers({ "/repos/okikio/utils/pulls/3": { number: 3, stack: null } });
  expect(await stack.resolve(context, unstacked)).toMatchObject({ selected: true, baseSha: "" });
  const missingStack = answers({ "/repos/okikio/utils/pulls/3": { number: 3, stack: { number: 7 } } });
  expect(await stack.resolve(context, missingStack)).toMatchObject({ selected: true, baseSha: "" });
  const offline: FetchType = () => Promise.reject(new Error("offline"));
  expect(await stack.resolve(context, offline)).toMatchObject({ selected: true, baseSha: "" });
  const odd = answers({
    "/repos/okikio/utils/pulls/3": { stack: { number: 7 } },
    "/repos/okikio/utils/stacks/7": { pull_requests: [{ number: "3" }] },
  });
  expect(await stack.resolve(context, odd)).toMatchObject({ selected: true, baseSha: "" });
});

it("selects every run that is not a pull request", async () => {
  const never: FetchType = () => Promise.reject(new Error("must not be called"));
  expect(await stack.resolve({ ...context, event: "push", pull: undefined }, never)).toMatchObject({ selected: true });
});
