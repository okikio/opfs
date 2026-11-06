import { basename, dirname, relative, resolve } from "@std/path";

/** Builds one task-owned npm directory; registry publication is a separate operation. */
async function pack(): Promise<string> {
  const manifest: unknown = JSON.parse(await Deno.readTextFile("deno.json"));
  if (
    typeof manifest !== "object" || manifest === null || !("version" in manifest) ||
    typeof manifest.version !== "string"
  ) {
    throw new Error("deno.json must contain a package version.");
  }
  const version = Deno.env.get("RELEASE_VERSION") || (Deno.args.includes("--verify") ? "0.0.0-test" : manifest.version);
  const output = resolve(Deno.env.get("RELEASE_DIR") || ".release/npm");
  const path = relative(Deno.cwd(), output);
  if (
    !path.startsWith(".release/") && !path.startsWith(".release\\") && !path.startsWith(".tmp/") &&
    !path.startsWith(".tmp\\")
  ) {
    throw new Error("RELEASE_DIR must name a task-owned directory inside .release/ or .tmp/.");
  }
  // Existing parent symlinks must not redirect recursive cleanup outside the owned tree.
  let ancestor = output;
  let physical: string;
  while (true) {
    try {
      physical = await Deno.realPath(ancestor);
      break;
    } catch (reason) {
      if (!(reason instanceof Deno.errors.NotFound)) throw reason;
      ancestor = dirname(ancestor);
    }
  }
  const resolved = relative(await Deno.realPath(Deno.cwd()), resolve(physical, relative(ancestor, output)));
  if (
    !resolved.startsWith(".release/") && !resolved.startsWith(".release\\") && !resolved.startsWith(".tmp/") &&
    !resolved.startsWith(".tmp\\")
  ) {
    throw new Error("RELEASE_DIR symlinks must remain inside the task-owned .release/ or .tmp/ tree.");
  }
  try {
    await Deno.remove(output, { recursive: true });
  } catch (reason) {
    if (!(reason instanceof Deno.errors.NotFound)) throw reason;
  }
  await Deno.mkdir(output, { recursive: true });
  await run([
    "run",
    "--config",
    "scripts/deno.json",
    "--no-lock",
    "-A",
    "scripts/npm.ts",
    version,
    resolve(output, "package"),
  ]);
  // Deno's task shell resolves npm consistently on Windows as well as Unix hosts.
  const packed = await run([
    "task",
    "pack:npm:archive",
    resolve(output, "package"),
    "--pack-destination",
    output,
    "--json",
  ], true);
  const text = new TextDecoder().decode(packed.stdout);
  await Deno.writeTextFile(resolve(output, "pack.json"), text);
  const report: unknown = JSON.parse(text);
  const first: unknown = Array.isArray(report) && report.length === 1 ? report[0] : undefined;
  if (
    typeof first !== "object" || first === null || !("filename" in first) || typeof first.filename !== "string" ||
    first.filename.length === 0 || basename(first.filename) !== first.filename || !first.filename.endsWith(".tgz")
  ) {
    throw new Error("npm pack did not report one local tarball filename.");
  }
  return resolve(output, first.filename);
}

/** A nonzero child result stops packaging; stderr remains visible for diagnosis. */
async function run(args: string[], capture = false): Promise<Deno.CommandOutput> {
  const result = await new Deno.Command(Deno.execPath(), {
    args,
    stdin: "null",
    stdout: capture ? "piped" : "inherit",
    stderr: "inherit",
  }).output();
  if (!result.success) throw new Error(`Package command exited ${result.code}: deno ${args.join(" ")}`);
  return result;
}

const tarball = await pack();
console.log(tarball);
if (Deno.args.includes("--verify")) await run(["task", "verify:npm:artifact", tarball]);
