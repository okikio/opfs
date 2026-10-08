/** Installs pinned upstream consumers in a disposable task-owned directory. */
async function test(): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "opfs-ecosystems-" });
  const failures: unknown[] = [];
  try {
    await run(["task", "test:ecosystems:install", "--prefix", root, "--cache", `${root}/cache`]);
    await run(["task", "test:ecosystems:run"], { OPFS_ECOSYSTEM_ROOT: root });
  } catch (reason) {
    failures.push(reason);
  }
  try {
    await Deno.remove(root, { recursive: true });
  } catch (reason) {
    failures.push(reason);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Ecosystem tests and owned installation cleanup failed.", {
      cause: failures[0],
    });
  }
}

/** Runs through Deno's portable task shell so npm and Node discovery match other gates. */
async function run(args: string[], env: Record<string, string> = {}): Promise<void> {
  const result = await new Deno.Command(Deno.execPath(), {
    args,
    env,
    stdin: "null",
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!result.success) throw new Error(`Ecosystem command exited ${result.code}: deno ${args.join(" ")}`);
}

await test();
