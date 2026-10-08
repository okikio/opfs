/** Checks the selected Git range with the existing pinned Conventional Commits tool. @module */
const head = Deno.env.get("HEAD_SHA");
if (!head) throw new Error("HEAD_SHA is required.");
let base = Deno.env.get("BASE_SHA");
if (!base || /^0+$/u.test(base)) {
  const result = await new Deno.Command("git", {
    args: ["rev-list", "--max-parents=0", head],
    stdout: "piped",
    stderr: "inherit",
  }).output();
  if (!result.success) throw new Error("Cannot select the first commit.");
  base = new TextDecoder().decode(result.stdout).trim();
}
const status = await new Deno.Command("npx", {
  args: [
    "--yes",
    "--package=@commitlint/cli@21.2.1",
    "commitlint",
    "--default-config",
    "--from",
    base,
    "--to",
    head,
    "--verbose",
  ],
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
}).spawn().status;
if (!status.success) throw new Error(`Commit validation exited ${status.code}.`);
