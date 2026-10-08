import process from "node:process";
import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** These subprocess fixtures use the real pinned Bumpy and owned Git repositories, never public registry uploads. */
interface FixtureType {
  root: string;
  env: Record<string, string>;
  release(...args: string[]): Promise<Deno.CommandOutput>;
}

/** Registry doubles retain attempted uploads separately from metadata observations. */
interface RegistryType {
  npm: boolean;
  jsr: boolean;
  status?: number;
  different?: boolean;
  failUpload?: boolean;
  staleJsr?: boolean;
  uploads: string[][];
  archive: string;
}

/** Bounds a real subprocess and always releases its deadline timer. */
async function run(root: string, file: string, args: string[], env: Record<string, string> = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Release fixture command exceeded 30 seconds.")), 30_000);
  try {
    const command = file === "git" ? ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args] : args;
    return await new Deno.Command(file, { args: command, cwd: root, env, stdin: "null", signal: controller.signal })
      .output();
  } finally {
    clearTimeout(timer);
  }
}

/** Test manifests and registry state are inspectable data, while Bumpy owns all release decisions. */
async function json(path: string, value: unknown): Promise<void> {
  await Deno.writeTextFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Reads one fixture-owned JSON record. */
async function read<T>(path: string): Promise<T> {
  return JSON.parse(await Deno.readTextFile(path)) as T;
}

/** Reports child diagnostics when a fixture setup command fails. */
function success(result: Deno.CommandOutput): void {
  if (!result.success) {
    throw new Error(new TextDecoder().decode(result.stderr) + new TextDecoder().decode(result.stdout));
  }
}

/** Owns each temporary root immediately and retains independent fixture/cleanup failures. */
async function fixture(body: (value: FixtureType) => Promise<void>, workspace = false): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "opfs-release-test-" });
  const errors: unknown[] = [];
  try {
    const source = new URL("../../", import.meta.url);
    await Deno.mkdir(join(root, ".mise/tasks"), { recursive: true });
    await Deno.mkdir(join(root, ".bumpy"));
    await Deno.mkdir(join(root, ".tmp"));
    await Deno.mkdir(join(root, "bin"));
    await Deno.copyFile(new URL(".mise/tasks/release.ts", source), join(root, ".mise/tasks/release.ts"));
    await Deno.copyFile(new URL(".bumpy/format.ts", source), join(root, ".bumpy/format.ts"));
    await fixtureDependencies(root, source);
    await Deno.writeTextFile(join(root, ".gitignore"), ".tmp/\n.release/\nnode_modules\n");
    await json(join(root, ".bumpy/_config.json"), {
      baseBranch: "main",
      changelog: "./.bumpy/format.ts",
      updateInternalDependencies: "out-of-range",
    });
    const child = `${quote(Deno.execPath())} run --cached-only --no-lock -A .mise/tasks/release.ts`;
    await json(join(root, "deno.json"), {
      name: "@okikio/opfs",
      version: "0.1.0",
      exports: "./mod.js",
      nodeModulesDir: "manual",
      tasks: {
        "release:upload": `${child} upload`,
        "release:npm": "npm publish",
        quality: "deno task deps:ci && deno task quality:source",
        "deps:ci": "deno run -A deps.ts",
        "quality:source": "deno run --allow-read check.ts",
        test: "deno run --allow-read check.ts",
        "test:node": "deno run --allow-read check.ts",
        "test:bun": "deno run --allow-read check.ts",
        "test:browser": "deno run --allow-read check.ts",
        "test:ecosystems": "deno run --allow-read check.ts",
        "test:providers": "deno run --allow-read check.ts",
        "test:linux": "deno run --allow-read check.ts",
        "bench:report": "deno run --allow-read check.ts",
        "bench:browser": "deno run --allow-read check.ts",
        "pack:npm": "deno run -A pack.ts",
        "verify:npm:artifact": "deno run --allow-read verify.ts",
      },
    });
    await json(
      join(root, "package.json"),
      workspace
        ? { name: "release-workspace", private: true, workspaces: ["packages/*"] }
        : { name: "@okikio/opfs", version: "0.1.0", type: "module", files: ["mod.js"] },
    );
    await Deno.writeTextFile(join(root, "mod.js"), "export const value = 7;\n");
    const node = await executable("node");
    const npm = await executable("npm");
    await Deno.writeTextFile(
      join(root, "deps.ts"),
      "await Deno.mkdir('.tmp',{recursive:true}); await Deno.writeTextFile('.tmp/dependencies-complete','installed');\n",
    );
    await Deno.writeTextFile(
      join(root, "check.ts"),
      "if ((await import('./mod.js')).value !== 7) throw new Error('toy behavior failed');\n",
    );
    await Deno.writeTextFile(
      join(root, "pack.ts"),
      `
      await Deno.mkdir('.release/npm/package', { recursive:true });
      await Deno.copyFile('package.json','.release/npm/package/package.json');
      await Deno.copyFile('mod.js','.release/npm/package/mod.js');
      const result=await new Deno.Command(${
        JSON.stringify(npm)
      },{args:['pack','.release/npm/package','--pack-destination','.release/npm','--ignore-scripts','--json'],env:{npm_config_cache:Deno.cwd()+'/.tmp/npm-cache'}}).output();
      if(!result.success)throw new Error(new TextDecoder().decode(result.stderr));
    `,
    );
    await Deno.writeTextFile(
      join(root, "verify.ts"),
      "const bytes=await Deno.readFile(Deno.args[0]);if(bytes[0]!==31||bytes[1]!==139)throw new Error('toy archive is not gzip');\n",
    );
    await Deno.writeTextFile(join(root, "bin/registry.mjs"), REGISTRY);
    for (const command of ["curl", "npm"]) {
      await Deno.writeTextFile(join(root, "bin", command), `#!/bin/sh\nexec ${quote(node)} "$0".mjs "$@"\n`);
      await Deno.writeTextFile(
        join(root, "bin", `${command}.mjs`),
        `process.env.REGISTRY_COMMAND=${JSON.stringify(command)};await import('./registry.mjs');\n`,
      );
      await Deno.chmod(join(root, "bin", command), 0o755);
    }
    const env = {
      PATH: `${join(root, "bin")}:${Deno.env.get("PATH")}`,
      REGISTRY_STATE: join(root, ".tmp/registry.json"),
      GITHUB_ACTIONS: "false",
      DENO_DIR: join(root, ".tmp/deno-cache"),
    };
    await json(env.REGISTRY_STATE, {
      npm: false,
      jsr: false,
      uploads: [],
      archive: join(root, ".release/npm/okikio-opfs-0.1.0.tgz"),
    });
    if (workspace) {
      for (const [name, dependencies] of [["core", {}], ["app", { "@release/core": "workspace:~0.1.0" }]] as const) {
        const path = join(root, "packages", name);
        await Deno.mkdir(path, { recursive: true });
        await json(join(path, "package.json"), { name: `@release/${name}`, version: "0.1.0", dependencies });
        await json(join(path, "deno.json"), { name: `@release/${name}`, version: "0.1.0" });
      }
    }
    success(await run(root, "git", ["init", "-b", "main"]));
    success(await run(root, "git", ["add", "."]));
    success(
      await run(root, "git", [
        "-c",
        "user.name=Release Fixture",
        "-c",
        "user.email=release@example.test",
        "commit",
        "-m",
        "test: create isolated release fixture",
      ]),
    );
    await body({
      root,
      env,
      release: (...args) =>
        run(root, Deno.execPath(), ["run", "--cached-only", "--no-lock", "-A", ".mise/tasks/release.ts", ...args], env),
    });
  } catch (reason) {
    errors.push(reason);
  }
  try {
    await Deno.remove(root, { recursive: true });
    try {
      await Deno.lstat(root);
      throw new Error("Release fixture root survived cleanup.");
    } catch (reason) {
      if (!(reason instanceof Deno.errors.NotFound)) throw reason;
    }
  } catch (reason) {
    errors.push(reason);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Release fixture and cleanup failed.", { cause: errors[0] });
}

/** Resolves real build tools before controlled registry commands are placed on PATH. */
async function executable(name: string): Promise<string> {
  const result = await new Deno.Command("which", { args: [name] }).output();
  success(result);
  return new TextDecoder().decode(result.stdout).trim();
}

/** Quotes an owned executable for the fixture's POSIX command seam. */
function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Updates only controlled external registry state, outside the prepared source identity. */
async function registry(value: FixtureType, changes: Partial<RegistryType>): Promise<void> {
  await json(value.env.REGISTRY_STATE!, { ...await read<RegistryType>(value.env.REGISTRY_STATE!), ...changes });
}

/** Confirms no irreversible command was admitted by a failed guard. */
async function noUploads(value: FixtureType): Promise<void> {
  expect((await read<RegistryType>(value.env.REGISTRY_STATE!)).uploads).toEqual([]);
}

describe("Deno release command", { skip: Deno.build.os === "windows" }, () => {
  it("rejects Unix root before creating snapshots or running any gate", async () => {
    await fixture(async (value) => {
      await Deno.writeTextFile(
        join(value.root, ".tmp/root-admission.ts"),
        `
        import process from 'node:process';
        if (!Reflect.set(process, 'getuid', () => 0)) throw new Error('Cannot install owned identity double.');
        Deno.args.splice(0, Deno.args.length, 'prepare');
        await import('../.mise/tasks/release.ts');
      `,
      );
      const result = await run(value.root, Deno.execPath(), [
        "run",
        "--cached-only",
        "--no-lock",
        "-A",
        ".tmp/root-admission.ts",
      ], value.env);
      expect(result.success).toBe(false);
      expect(new TextDecoder().decode(result.stderr)).toContain("does not support Unix UID 0");
      await expect(Deno.stat(join(value.root, ".tmp/releases/prepared.json"))).rejects.toThrow(Deno.errors.NotFound);
      await expect(Deno.stat(join(value.root, ".tmp/releases"))).rejects.toThrow(Deno.errors.NotFound);
      await noUploads(value);
    });
    // This suite exercises ordinary-account protection and real permission
    // failures. A privileged runner must select a dedicated ordinary account.
    expect(process.getuid?.(), "Run release fixtures as an ordinary Unix account.").not.toBe(0);
  });

  it("rejects Windows preparation before unprotected gates without changing consumer support", async () => {
    await fixture(async (value) => {
      await Deno.writeTextFile(
        join(value.root, ".tmp/windows-admission.ts"),
        `
        Object.defineProperty(Deno, 'build', { value: { ...Deno.build, os: 'windows' } });
        Deno.args.splice(0, Deno.args.length, 'prepare');
        await import('../.mise/tasks/release.ts');
      `,
      );
      const result = await run(value.root, Deno.execPath(), [
        "run",
        "--cached-only",
        "--no-lock",
        "-A",
        ".tmp/windows-admission.ts",
      ], value.env);
      expect(result.success).toBe(false);
      expect(new TextDecoder().decode(result.stderr)).toContain("does not support Windows source protection");
      await expect(Deno.stat(join(value.root, ".tmp/releases"))).rejects.toThrow(Deno.errors.NotFound);
      await noUploads(value);
    });
  });

  it("protects maintained files against direct writes and atomic replacement", async () => {
    await fixture(async (value) => {
      const config = await read<{ tasks: Record<string, string> }>(join(value.root, "deno.json"));
      for (const [name, task] of Object.entries(config.tasks)) {
        if (task.includes("check.ts")) config.tasks[name] = "deno run -A check.ts";
      }
      await json(join(value.root, "deno.json"), config);
      await Deno.writeTextFile(
        join(value.root, "check.ts"),
        `
        const expected = 'export const value = 7;\\n';
        // Coverage --clean and Playwright cleanup must recreate their output
        // directories without requiring write access to the maintained root.
        for (const path of ['.tmp/reports/coverage', '.tmp/reports/browser/artifacts', '.tmp/reports/browser-bench/artifacts']) {
          await Deno.mkdir(path, { recursive: true });
          await Deno.writeTextFile(path+'/old.txt', 'old output');
          await Deno.remove(path, { recursive: true });
          await Deno.mkdir(path, { recursive: true });
          await Deno.writeTextFile(path+'/proof.txt', 'recreated owned output');
        }
        let direct = false;
        try { await Deno.writeTextFile('mod.js', 'export const value = 9;\\n'); }
        catch (error) { if (!(error instanceof Deno.errors.PermissionDenied)) throw error; direct = true; }
        if (!direct) throw new Error('Maintained source accepted a direct write.');
        await Deno.writeTextFile('.tmp/replacement.js', 'export const value = 9;\\n');
        let atomic = false;
        try { await Deno.rename('.tmp/replacement.js', 'mod.js'); }
        catch (error) { if (!(error instanceof Deno.errors.PermissionDenied)) throw error; atomic = true; }
        if (!atomic) throw new Error('Maintained source accepted atomic replacement.');
        if (await Deno.readTextFile('mod.js') !== expected) throw new Error('Source bytes changed.');
      `,
      );
      await commitFixture(value);
      success(await value.release("prepare"));
      expect(await Deno.readTextFile(join(value.root, "mod.js"))).toBe("export const value = 7;\n");
      await noUploads(value);
    });
  });

  it("replaces the dependency root before protection and then runs the committed quality source task", async () => {
    await fixture(async (value) => {
      await Deno.writeTextFile(
        join(value.root, "deps.ts"),
        `
        if (!((await Deno.stat('.')).mode & 0o222)) throw new Error('Dependency root was already protected.');
        await Deno.remove('node_modules', { recursive: true });
        await Deno.mkdir('node_modules');
        await Deno.writeTextFile('.tmp/dependencies-complete', 'installed');
        console.log('dependency replacement completed'); console.error('retained dependency diagnostic');
        const bytes = new Uint8Array([0, 255, 226, 130, 172, 10]);
        await Deno.stdout.write(bytes); await Deno.stderr.write(bytes);
      `,
      );
      const config = await read<{ tasks: Record<string, string> }>(join(value.root, "deno.json"));
      config.tasks["quality:source"] = "deno run -A quality-source.ts";
      await json(join(value.root, "deno.json"), config);
      await Deno.writeTextFile(
        join(value.root, "quality-source.ts"),
        `
        if (await Deno.readTextFile('.tmp/dependencies-complete') !== 'installed') throw new Error('Source phase preceded installation.');
        if ((await Deno.stat('.')).mode & 0o222) throw new Error('Source phase root is writable.');
        let denied = false; try { await Deno.writeTextFile('mod.js','bad'); } catch(error) { if (!(error instanceof Deno.errors.PermissionDenied)) throw error; denied = true; }
        if (!denied) throw new Error('Source phase bytes are writable.');
      `,
      );
      await commitFixture(value);
      // Real files deliberately accept at most three bytes per write. This
      // controls OS short-write behavior while preserving the actual task pipes.
      await Deno.writeTextFile(
        join(value.root, ".tmp/partial-logs.ts"),
        `
        const open = Deno.open.bind(Deno);
        if (!Reflect.set(Deno, 'open', async(path, options) => {
          const file = await open(path, options);
          if (options?.write && ['/dependencies/stdout.log', '/dependencies/stderr.log'].some(suffix => String(path).endsWith(suffix))) {
            return {write(bytes){return file.write(bytes.subarray(0, 3));}, close(){file.close();}};
          }
          return file;
        })) throw new Error('Cannot install short-write control.');
        Deno.args.splice(0, Deno.args.length, 'prepare'); await import('../.mise/tasks/release.ts');
      `,
      );
      success(
        await run(value.root, Deno.execPath(), [
          "run",
          "--cached-only",
          "--no-lock",
          "-A",
          ".tmp/partial-logs.ts",
        ], value.env),
      );
      const candidate = await read<{ source: string; revision: string; gates: { file: string } }>(
        join(value.root, ".tmp/releases/prepared.json"),
      );
      const evidence = await read<
        {
          steps: Array<
            {
              task: string;
              phase: string;
              code: number;
              source: string;
              revision: string;
              before: { source: string; revision: string };
              logs?: { stdout: { file: string }; stderr: { file: string } };
            }
          >;
        }
      >(join(value.root, candidate.gates.file));
      expect(evidence.steps.slice(0, 2).map(({ task, phase, code }) => ({ task, phase, code }))).toEqual([{
        task: "deps:ci",
        phase: "dependencies",
        code: 0,
      }, { task: "quality:source", phase: "source", code: 0 }]);
      expect(
        evidence.steps.every((step) =>
          step.source === candidate.source && step.revision === candidate.revision &&
          step.before.source === candidate.source && step.before.revision === candidate.revision
        ),
      ).toBe(true);
      expect(await Deno.readTextFile(join(value.root, evidence.steps[0]!.logs!.stdout.file))).toContain(
        "dependency replacement completed",
      );
      expect(await Deno.readTextFile(join(value.root, evidence.steps[0]!.logs!.stderr.file))).toContain(
        "retained dependency diagnostic",
      );
      const bytes = new Uint8Array([0, 255, 226, 130, 172, 10]);
      expect(await Deno.readFile(join(value.root, evidence.steps[0]!.logs!.stdout.file))).toEqual(
        new Uint8Array([...new TextEncoder().encode("dependency replacement completed\n"), ...bytes]),
      );
      expect((await Deno.readFile(join(value.root, evidence.steps[0]!.logs!.stderr.file))).slice(-bytes.length))
        .toEqual(bytes);
      await noUploads(value);
    });
  });

  it("ordinary quality still runs dependency installation and the canonical source remainder", async () => {
    await fixture(async (value) => {
      await Deno.writeTextFile(
        join(value.root, "deps.ts"),
        "await Deno.writeTextFile('.tmp/order.txt', 'dependencies\\n');\n",
      );
      const config = await read<{ tasks: Record<string, string> }>(join(value.root, "deno.json"));
      config.tasks["quality:source"] = "deno run -A quality-source.ts";
      await json(join(value.root, "deno.json"), config);
      await Deno.writeTextFile(
        join(value.root, "quality-source.ts"),
        "await Deno.writeTextFile('.tmp/order.txt', 'source\\n',{append:true});\n",
      );
      success(await run(value.root, Deno.execPath(), ["task", "quality"], value.env));
      expect(await Deno.readTextFile(join(value.root, ".tmp/order.txt"))).toBe("dependencies\nsource\n");
      await noUploads(value);
    });
  });

  for (const failure of ["dependency status", "dependency source change", "canonical source task"] as const) {
    it(`refuses preparation after ${failure} and never admits a later source gate`, async () => {
      await fixture(async (value) => {
        value.env.ORIGINAL_RELEASE_ROOT = value.root;
        await Deno.writeTextFile(
          join(value.root, "deps.ts"),
          failure === "dependency status"
            ? "console.error('controlled install failure');Deno.exit(7);\n"
            : failure === "dependency source change"
            ? "await Deno.writeTextFile('mod.js','export const value = 9;\\n');\n"
            : "console.log('controlled successful install');\n",
        );
        const config = await read<{ tasks: Record<string, string> }>(join(value.root, "deno.json"));
        config.tasks["quality:source"] = "deno run -A quality-source.ts";
        config.tasks.test = "deno run -A later-source.ts";
        await json(join(value.root, "deno.json"), config);
        await Deno.writeTextFile(
          join(value.root, "quality-source.ts"),
          "await Deno.writeTextFile(Deno.env.get('ORIGINAL_RELEASE_ROOT')+'/.tmp/source-ran','source');Deno.exit(8);\n",
        );
        await Deno.writeTextFile(
          join(value.root, "later-source.ts"),
          "await Deno.writeTextFile(Deno.env.get('ORIGINAL_RELEASE_ROOT')+'/.tmp/later-source-ran','later');\n",
        );
        await commitFixture(value);
        const result = await value.release("prepare");
        expect(result.success).toBe(false);
        const records = [];
        for await (const file of Deno.readDir(join(value.root, ".tmp/releases"))) {
          if (file.name.startsWith("gates-")) {
            records.push(
              await read<
                {
                  passed: boolean;
                  steps: Array<
                    {
                      task: string;
                      code: number;
                      source: string;
                      before: { source: string };
                      logs?: { stderr: { file: string } };
                    }
                  >;
                }
              >(join(value.root, ".tmp/releases", file.name)),
            );
          }
        }
        expect(records).toHaveLength(1);
        const evidence = records[0]!;
        expect(evidence.passed).toBe(false);
        expect(evidence.steps.map(({ task, code }) => ({ task, code }))).toEqual(
          failure === "canonical source task"
            ? [{ task: "deps:ci", code: 0 }, { task: "quality:source", code: 8 }]
            : [{ task: "deps:ci", code: failure === "dependency status" ? 7 : 0 }],
        );
        if (failure === "dependency source change") {
          expect(evidence.steps[0]!.source).not.toBe(evidence.steps[0]!.before.source);
        }
        if (failure === "dependency status") {
          expect(await Deno.readTextFile(join(value.root, evidence.steps[0]!.logs!.stderr.file))).toContain(
            "controlled install failure",
          );
        }
        if (failure !== "canonical source task") {
          await expect(Deno.stat(join(value.root, ".tmp/source-ran"))).rejects.toThrow(Deno.errors.NotFound);
        }
        await expect(Deno.stat(join(value.root, ".tmp/later-source-ran"))).rejects.toThrow(Deno.errors.NotFound);
        await expect(Deno.stat(join(value.root, ".tmp/releases/prepared.json"))).rejects.toThrow(Deno.errors.NotFound);
        expect(await Deno.readTextFile(join(value.root, "mod.js"))).toBe("export const value = 7;\n");
        await noUploads(value);
      });
    });
  }

  it("refuses upload after retained dependency output changes", async () => {
    await fixture(async (value) => {
      success(await value.release("prepare"));
      const candidate = await read<{ gates: { file: string } }>(join(value.root, ".tmp/releases/prepared.json"));
      const journal = await read<{ steps: Array<{ logs?: { stdout: { file: string } } }> }>(
        join(value.root, candidate.gates.file),
      );
      await Deno.writeTextFile(join(value.root, journal.steps[0]!.logs!.stdout.file), "altered log");
      const result = await value.release("upload", "@okikio/opfs", "0.1.0", "npm");
      expect(result.success).toBe(false);
      expect(new TextDecoder().decode(result.stderr)).toContain("dependency raw evidence changed");
      await noUploads(value);
    });
  });

  for (const failure of ["rejection", "zero progress"]) {
    it(`retains raw output ${failure} and close failures without admitting source gates`, async () => {
      await fixture(async (value) => {
        await Deno.writeTextFile(join(value.root, "deps.ts"), "console.log('trigger owned raw stdout');\n");
        const config = await read<{ tasks: Record<string, string> }>(join(value.root, "deno.json"));
        config.tasks["quality:source"] = "deno run -A source-marker.ts";
        await json(join(value.root, "deno.json"), config);
        await Deno.writeTextFile(
          join(value.root, "source-marker.ts"),
          "await Deno.writeTextFile(Deno.env.get('ORIGINAL_RELEASE_ROOT')+'/.tmp/source-ran','source');\n",
        );
        await commitFixture(value);
        value.env.ORIGINAL_RELEASE_ROOT = value.root;
        // Inject only this owned destination's write failure. The actual task CLI,
        // pipe, status, source permissions and file cleanup run unchanged.
        await Deno.writeTextFile(
          join(value.root, ".tmp/raw-log-failure.ts"),
          `
        const open=Deno.open.bind(Deno);
        if(!Reflect.set(Deno,'open',async(path,options)=>{
          const file=await open(path,options);
          if(options?.write && String(path).endsWith('/dependencies/stdout.log'))return {write(){${
            failure === "rejection" ? "throw new Error('owned raw stdout rejected');" : "return 0;"
          }},close(){file.close();throw new Error('independent owned log close rejected');}};
          return file;
        }))throw new Error('Cannot install owned stream control.');
        Deno.args.splice(0,Deno.args.length,'prepare');await import('../.mise/tasks/release.ts');
      `,
        );
        const result = await run(value.root, Deno.execPath(), [
          "run",
          "--cached-only",
          "--no-lock",
          "-A",
          ".tmp/raw-log-failure.ts",
        ], value.env);
        expect(result.success).toBe(false);
        const error = new TextDecoder().decode(result.stderr);
        expect(error).toContain(
          failure === "rejection" ? "owned raw stdout rejected" : "Dependency raw output writer made invalid progress",
        );
        expect(error).toContain("independent owned log close rejected");
        await expect(Deno.stat(join(value.root, ".tmp/source-ran"))).rejects.toThrow(Deno.errors.NotFound);
        await expect(Deno.stat(join(value.root, ".tmp/releases/prepared.json"))).rejects.toThrow(Deno.errors.NotFound);
        const files = [];
        for await (const file of Deno.readDir(join(value.root, ".tmp/releases"))) {
          if (file.name.startsWith("gates-")) files.push(file.name);
        }
        expect(files).toHaveLength(1);
        expect((await read<{ passed: boolean }>(join(value.root, ".tmp/releases", files[0]!))).passed).toBe(false);
        await noUploads(value);
      });
    });
  }

  it("retains independent gate and cleanup failures without a passed receipt", async () => {
    await fixture(async (value) => {
      const config = await read<{ tasks: Record<string, string> }>(join(value.root, "deno.json"));
      config.tasks["quality:source"] = "deno run -A block-cleanup.ts";
      await json(join(value.root, "deno.json"), config);
      await Deno.writeTextFile(
        join(value.root, "block-cleanup.ts"),
        `
        await Deno.writeTextFile(Deno.env.get('ORIGINAL_RELEASE_ROOT')+'/.tmp/failed-snapshot.txt', Deno.cwd());
        await Deno.mkdir('.tmp/blocked');
        await Deno.writeTextFile('.tmp/blocked/owned.txt', 'owned cleanup fixture');
        await Deno.chmod('.tmp/blocked', 0);
        Deno.exit(9);
      `,
      );
      value.env.ORIGINAL_RELEASE_ROOT = value.root;
      await commitFixture(value);
      const result = await value.release("prepare");
      const snapshot = await Deno.readTextFile(join(value.root, ".tmp/failed-snapshot.txt"));
      const failures: unknown[] = [];
      try {
        expect(result.success).toBe(false);
        await expect(Deno.stat(join(value.root, ".tmp/releases/prepared.json"))).rejects.toThrow(Deno.errors.NotFound);
        const files = [];
        for await (const entry of Deno.readDir(join(value.root, ".tmp/releases"))) {
          if (entry.name.startsWith("gates-")) files.push(entry.name);
        }
        expect(files).toHaveLength(1);
        const evidence = await read<{ passed: boolean; failures: string[]; steps: Array<{ code: number }> }>(
          join(value.root, ".tmp/releases", files[0]!),
        );
        expect(evidence.passed).toBe(false);
        expect(evidence.failures.length).toBeGreaterThanOrEqual(2);
        expect(evidence.steps.map((step) => step.code)).toEqual([0, 9]);
        await noUploads(value);
      } catch (reason) {
        failures.push(reason);
      } finally {
        // The fixture deliberately removed directory access. Restore only its
        // owned path so the test itself leaves no failed-cleanup snapshot behind.
        try {
          await Deno.chmod(join(snapshot, ".tmp/blocked"), 0o755);
        } catch (reason) {
          if (!(reason instanceof Deno.errors.NotFound)) failures.push(reason);
        }
        try {
          await Deno.remove(join(snapshot, ".."), { recursive: true });
        } catch (reason) {
          if (!(reason instanceof Deno.errors.NotFound)) failures.push(reason);
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, "Cleanup-failure fixture and repair failed.", { cause: failures[0] });
      }
    });
  });

  it("rejects dependency aliases into uncommitted source instead of borrowing them", async () => {
    await fixture(async (value) => {
      const outside = join(value.root, ".tmp/uncommitted-package");
      await Deno.mkdir(outside);
      await Deno.writeTextFile(join(outside, "mod.js"), "export const value = 9;\n");
      await Deno.mkdir(join(value.root, "node_modules/@fixture"), { recursive: true });
      await Deno.symlink(outside, join(value.root, "node_modules/@fixture/uncommitted"), { type: "dir" });
      const result = await value.release("prepare");
      expect(result.success).toBe(false);
      await expect(Deno.stat(join(value.root, ".tmp/releases/prepared.json"))).rejects.toThrow(Deno.errors.NotFound);
      await noUploads(value);
    });
  });
  it("refuses a receipt when an original-source edit remains after snapshot gates", async () => {
    await fixture(async (value) => {
      const config = await read<{ tasks: Record<string, string> }>(join(value.root, "deno.json"));
      config.tasks["quality:source"] = "deno run -A change-original.ts";
      await json(join(value.root, "deno.json"), config);
      await Deno.writeTextFile(
        join(value.root, "change-original.ts"),
        "await Deno.writeTextFile(Deno.env.get('ORIGINAL_RELEASE_ROOT')+'/mod.js','export const value = 9;\\n');\n",
      );
      value.env.ORIGINAL_RELEASE_ROOT = value.root;
      await commitFixture(value);
      const result = await value.release("prepare");
      expect(result.success).toBe(false);
      expect(await Deno.readTextFile(join(value.root, "mod.js"))).toBe("export const value = 9;\n");
      await expect(Deno.stat(join(value.root, ".tmp/releases/prepared.json"))).rejects.toThrow(Deno.errors.NotFound);
      await noUploads(value);
    });
  });
  it("rejects changed durable gate evidence before any registry command", async () => {
    await fixture(async (value) => {
      success(await value.release("prepare"));
      const candidate = await read<{ gates: { file: string } }>(join(value.root, ".tmp/releases/prepared.json"));
      await Deno.writeTextFile(join(value.root, candidate.gates.file), "{}\n");
      const result = await value.release("upload", "@okikio/opfs", "0.1.0", "npm");
      expect(result.success).toBe(false);
      expect(new TextDecoder().decode(result.stderr)).toContain("gate evidence changed");
      await noUploads(value);
    });
  });

  it("rejects initially dirty source before running preparation gates", async () => {
    await fixture(async (value) => {
      await Deno.writeTextFile(join(value.root, "mod.js"), "export const value = 9;\n");
      const result = await value.release("prepare");
      expect(result.success).toBe(false);
      expect(new TextDecoder().decode(result.stderr)).toContain("clean immutable checkout");
      await expect(Deno.stat(join(value.root, ".tmp/releases/prepared.json"))).rejects.toThrow(Deno.errors.NotFound);
      await noUploads(value);
    });
  });
  it("builds committed snapshot bytes despite original A-to-B-to-A edits between gates", async () => {
    await fixture(async (value) => {
      await Deno.mkdir(join(value.root, "linked"));
      await Deno.writeTextFile(join(value.root, "linked/mod.js"), "export const value = 7;\n");
      await json(join(value.root, "linked/package.json"), {
        name: "@fixture/source",
        type: "module",
        exports: "./mod.js",
      });
      await Deno.mkdir(join(value.root, "node_modules/@fixture"), { recursive: true });
      await Deno.symlink(join(value.root, "linked"), join(value.root, "node_modules/@fixture/source"), { type: "dir" });
      await Deno.mkdir(join(value.root, ".tmp/reports"), { recursive: true });
      await Deno.writeTextFile(join(value.root, ".tmp/reports/local-review.txt"), "retain this local review");
      await Deno.mkdir(join(value.root, "node_modules/.bin"), { recursive: true });
      await Deno.writeTextFile(
        join(value.root, "node_modules/.bin/snapshot-check"),
        '#!/bin/sh\nprintf "snapshot-executable\\n"\n',
      );
      await Deno.chmod(join(value.root, "node_modules/.bin/snapshot-check"), 0o755);
      const config = await read<{ tasks: Record<string, string> }>(join(value.root, "deno.json"));
      config.tasks["quality:source"] = "deno run -A change-original.ts";
      await json(join(value.root, "deno.json"), config);
      await Deno.writeTextFile(
        join(value.root, "change-original.ts"),
        `
        await Deno.writeTextFile(Deno.env.get('ORIGINAL_RELEASE_ROOT')+'/mod.js','export const value = 9;\\n');
        await Deno.writeTextFile(Deno.env.get('ORIGINAL_RELEASE_ROOT')+'/.tmp/snapshot-root.txt', Deno.cwd());
        await Deno.writeTextFile(Deno.env.get('ORIGINAL_RELEASE_ROOT')+'/linked/mod.js','export const value = 9;\\n');
        await Deno.mkdir('.tmp/reports', { recursive: true });
        await Deno.writeTextFile('.tmp/reports/clone-proof.txt', 'report from committed snapshot');
        await Deno.writeTextFile(Deno.env.get('ORIGINAL_RELEASE_ROOT')+'/node_modules/.bin/snapshot-check', '#!/bin/sh\\nexit 9\\n');
        const executable = await new Deno.Command('./node_modules/.bin/snapshot-check').output();
        if (!executable.success || new TextDecoder().decode(executable.stdout) !== 'snapshot-executable\\n') throw new Error('Snapshot executable bytes/mode were borrowed');
        if ((await import('./mod.js')).value !== 7) throw new Error('Snapshot borrowed original source');
        if ((await import('./node_modules/@fixture/source/mod.js')).value !== 7) throw new Error('Snapshot borrowed original alias');
      `,
      );
      const pack = join(value.root, "pack.ts");
      await Deno.writeTextFile(
        pack,
        await Deno.readTextFile(pack) +
          "\nawait Deno.writeTextFile(Deno.env.get('ORIGINAL_RELEASE_ROOT')+'/mod.js','export const value = 7;\\n');\n",
      );
      await Deno.writeTextFile(
        pack,
        await Deno.readTextFile(pack) +
          "\nawait Deno.writeTextFile(Deno.env.get('ORIGINAL_RELEASE_ROOT')+'/linked/mod.js','export const value = 7;\\n');\n",
      );
      value.env.ORIGINAL_RELEASE_ROOT = value.root;
      await commitFixture(value);
      success(await value.release("prepare"));
      // Extract the actual tar member. Expected bytes are an authored oracle,
      // independent from the source hash or the candidate's own receipt.
      const extracted = await run(value.root, "tar", ["-xOf", ".release/npm/okikio-opfs-0.1.0.tgz", "package/mod.js"]);
      success(extracted);
      expect(new TextDecoder().decode(extracted.stdout)).toBe("export const value = 7;\n");
      expect(await Deno.readTextFile(join(value.root, "mod.js"))).toBe("export const value = 7;\n");
      const candidate = await read<{ gates: { file: string }; source: string; revision: string }>(
        join(value.root, ".tmp/releases/prepared.json"),
      );
      const evidence = await read<
        {
          passed: boolean;
          source: string;
          revision: string;
          steps: Array<{ source: string }>;
          reports: { path: string; source: string; revision: string };
        }
      >(join(value.root, candidate.gates.file));
      expect(evidence.passed).toBe(true);
      expect(evidence.source).toBe(candidate.source);
      expect(evidence.revision).toBe(candidate.revision);
      expect(evidence.steps.length).toBeGreaterThan(1);
      expect(evidence.steps.every((step) => step.source === candidate.source)).toBe(true);
      expect(await Deno.readTextFile(join(value.root, ".tmp/reports/local-review.txt"))).toBe(
        "retain this local review",
      );
      expect(evidence.reports.source).toBe(candidate.source);
      expect(evidence.reports.revision).toBe(candidate.revision);
      expect(await Deno.readTextFile(join(value.root, evidence.reports.path, "clone-proof.txt"))).toBe(
        "report from committed snapshot",
      );
      const snapshot = await Deno.readTextFile(join(value.root, ".tmp/snapshot-root.txt"));
      await expect(Deno.lstat(join(snapshot, ".."))).rejects.toThrow(Deno.errors.NotFound);
      await noUploads(value);
    });
  });

  it("rejects source edits during passing gates before recording a prepared release", async () => {
    await fixture(async (value) => {
      const path = join(value.root, "deno.json");
      const config = await read<{ tasks: Record<string, string> }>(path);
      config.tasks["quality:source"] = "deno run --allow-read --allow-write check.ts";
      await json(path, config);
      await Deno.writeTextFile(
        join(value.root, "check.ts"),
        `await Deno.writeTextFile(${JSON.stringify(join(value.root, ".tmp/failed-snapshot.txt"))}, Deno.cwd());
        await Deno.writeTextFile('gate-change.txt', 'edit during validation');\n`,
      );
      await commitFixture(value);
      const result = await value.release("prepare");
      expect(result.success).toBe(false);
      const snapshot = await Deno.readTextFile(join(value.root, ".tmp/failed-snapshot.txt"));
      await expect(Deno.lstat(join(snapshot, ".."))).rejects.toThrow(Deno.errors.NotFound);
      await expect(Deno.stat(join(value.root, ".tmp/releases/prepared.json"))).rejects.toThrow(
        Deno.errors.NotFound,
      );
      await noUploads(value);
    });
  });

  it("rejects npm/Deno metadata disagreement before planning", async () => {
    await fixture(async (value) => {
      await json(join(value.root, "package.json"), { name: "@okikio/opfs", version: "0.2.0" });
      const result = await value.release("plan");
      expect(result.success).toBe(false);
      expect(new TextDecoder().decode(result.stderr)).toContain("metadata disagree");
      await noUploads(value);
    });
  });

  it("uses Bumpy for rich stories, synchronized manifests and dependency propagation", async () => {
    await fixture(async (value) => {
      const story =
        "### Preserve exact bytes\n\nA complete explanation.\n\n```ts\nawait store.save(bytes);\n```\n\n| Input | Result |\n| --- | --- |\n| bytes | same bytes |";
      await Deno.writeTextFile(join(value.root, ".bumpy/bytes.md"), `---\n"@release/core": minor\n---\n\n${story}\n`);
      const plan = await value.release("plan");
      success(plan);
      const parsed = JSON.parse(new TextDecoder().decode(plan.stdout)) as {
        releases: Array<{ name: string; newVersion: string }>;
      };
      expect(parsed.releases).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "@release/core", newVersion: "0.2.0" }),
        expect.objectContaining({ name: "@release/app", newVersion: "0.1.1" }),
      ]));
      success(await value.release("version"));
      const storyPath = join(value.root, ".tmp/story.md");
      await Deno.mkdir(join(value.root, ".tmp"), { recursive: true });
      await Deno.writeTextFile(storyPath, story);
      success(await run(value.root, Deno.execPath(), ["fmt", storyPath]));
      for (const [name, version] of [["core", "0.2.0"], ["app", "0.1.1"]]) {
        expect((await read<{ version: string }>(join(value.root, "packages", name!, "package.json"))).version).toBe(
          version,
        );
        expect((await read<{ version: string }>(join(value.root, "packages", name!, "deno.json"))).version).toBe(
          version,
        );
      }
      expect(await Deno.readTextFile(join(value.root, "packages/core/CHANGELOG.md"))).toContain(
        (await Deno.readTextFile(storyPath)).trim(),
      );
      success(
        await run(value.root, Deno.execPath(), [
          "fmt",
          "--check",
          "packages/core/CHANGELOG.md",
          "packages/app/CHANGELOG.md",
        ]),
      );
      expect(
        (await read<{ dependencies: Record<string, string> }>(join(value.root, "packages/app/package.json")))
          .dependencies["@release/core"],
      ).toBe("workspace:~0.2.0");
      expect(await Deno.readTextFile(join(value.root, "packages/app/CHANGELOG.md"))).toContain("@release/core@0.2.0");
    }, true);
  });

  for (const updateRevision of [false, true]) {
    it(`rejects changed prepared ${updateRevision ? "source independently from" : "Git revision despite"} a clean checkout`, async () => {
      await fixture(async (value) => {
        success(await value.release("prepare"));
        await Deno.writeTextFile(join(value.root, "mod.js"), "export const value = 9;\n");
        success(await run(value.root, "git", ["add", "mod.js"]));
        success(
          await run(value.root, "git", [
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.test",
            "commit",
            "-m",
            "test: change source",
          ]),
        );
        if (updateRevision) {
          // Alter only the claimed revision, so this control reaches the independent source-content guard.
          const path = join(value.root, ".tmp/releases/prepared.json");
          const candidate = await read<Record<string, unknown>>(path);
          const revision = await run(value.root, "git", ["rev-parse", "HEAD"]);
          success(revision);
          await json(path, { ...candidate, revision: new TextDecoder().decode(revision.stdout).trim() });
        }
        const result = await value.release("upload", "@okikio/opfs", "0.1.0", "npm");
        expect(result.success).toBe(false);
        expect(new TextDecoder().decode(result.stderr)).toContain(
          updateRevision ? "Source changed" : "Prepared revision",
        );
        await noUploads(value);
      });
    });
  }

  it("rejects an altered prepared archive before admitting a registry upload", async () => {
    await fixture(async (value) => {
      success(await value.release("prepare"));
      await Deno.writeTextFile(join(value.root, ".release/npm/okikio-opfs-0.1.0.tgz"), "changed archive");
      const result = await value.release("upload", "@okikio/opfs", "0.1.0", "npm");
      expect(result.success).toBe(false);
      expect(new TextDecoder().decode(result.stderr)).toContain("Release archive changed");
      await noUploads(value);
    });
  });

  it("rejects direct upload from a dirty prepared checkout", async () => {
    await fixture(async (value) => {
      success(await value.release("prepare"));
      await Deno.writeTextFile(join(value.root, "extra.txt"), "uncommitted candidate\n");
      const result = await value.release("upload", "@okikio/opfs", "0.1.0", "npm");
      expect(result.success).toBe(false);
      expect(new TextDecoder().decode(result.stderr)).toContain("clean immutable checkout");
      await noUploads(value);
    });
  });

  for (const different of [false, true]) {
    it(`${different ? "rejects differing" : "accepts exact matching"} existing npm bytes without uploading`, async () => {
      await fixture(async (value) => {
        success(await value.release("prepare"));
        await registry(value, { npm: true, different });
        const result = await value.release("publish", "npm");
        expect(result.success).toBe(!different);
        if (different) {
          expect(new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr)).toContain(
            "npm bytes differ",
          );
        }
        await noUploads(value);
      });
    });
  }

  it("observes the origin JSR version despite a cached missing-version response", async () => {
    await fixture(async (value) => {
      await registry(value, { staleJsr: true });
      const preflight = await value.release("registry", "jsr");
      success(preflight);
      expect(JSON.parse(new TextDecoder().decode(preflight.stdout)).published).toBe(false);
      await registry(value, { jsr: true });
      for (let observation = 0; observation < 2; observation++) {
        const result = await value.release("registry", "jsr");
        success(result);
        expect(JSON.parse(new TextDecoder().decode(result.stdout)).published).toBe(true);
      }
      await noUploads(value);
    });
  });

  it("treats HTTP401 as a registry failure rather than available version", async () => {
    await fixture(async (value) => {
      success(await value.release("prepare"));
      await registry(value, { status: 401 });
      const result = await value.release("publish", "npm");
      expect(result.success).toBe(false);
      expect(new TextDecoder().decode(result.stderr)).toContain("HTTP 401");
      await noUploads(value);
    });
  });

  it("retains a proven JSR phase after npm interruption and retries only npm with the same archive", async () => {
    await fixture(async (value) => {
      success(await value.release("prepare"));
      const candidate = await read<{ source: string; revision: string; packages: Array<{ sha256: string }> }>(
        join(value.root, ".tmp/releases/prepared.json"),
      );
      const receipt = join(value.root, ".tmp/releases/-okikio-opfs-0.1.0-jsr.json");
      const archive = await Deno.readFile(join(value.root, ".release/npm/okikio-opfs-0.1.0.tgz"));
      await json(receipt, {
        source: candidate.source,
        revision: candidate.revision,
        archiveSha256: candidate.packages[0]!.sha256,
      });
      await registry(value, { jsr: true, failUpload: true });
      expect((await value.release("publish", "both")).success).toBe(false);
      const completed = await Deno.readTextFile(receipt);
      await registry(value, { failUpload: false });
      success(await value.release("publish", "npm"));
      expect(await Deno.readTextFile(receipt)).toBe(completed);
      const uploads = (await read<RegistryType>(value.env.REGISTRY_STATE!)).uploads;
      expect(uploads).toHaveLength(2);
      expect(uploads.every((args) => args[0] === "publish" && args[1]!.endsWith("okikio-opfs-0.1.0.tgz"))).toBe(true);
      const npm = await read<{ archiveSha256: string }>(join(value.root, ".tmp/releases/-okikio-opfs-0.1.0-npm.json"));
      expect(npm.archiveSha256).toBe(candidate.packages[0]!.sha256);
      expect(await Deno.readFile(join(value.root, ".release/npm/okikio-opfs-0.1.0.tgz"))).toEqual(archive);
    });
  });
});

/** Fakes only the registry command boundary; real Bumpy and the real candidate tarball remain unchanged. */
const REGISTRY = `
import {readFileSync,writeFileSync} from 'node:fs';
const path=process.env.REGISTRY_STATE;const state=JSON.parse(readFileSync(path,'utf8'));const args=process.argv.slice(2);
if(process.env.REGISTRY_COMMAND==='npm'){
  if(args[0]!=='publish')throw new Error('Unexpected fake npm operation');
  state.uploads.push(args);writeFileSync(path,JSON.stringify(state));
  if(state.failUpload)process.exit(9);
  state.npm=true;writeFileSync(path,JSON.stringify(state));process.exit(0);
}
const url=args.at(-1);const npm=url.startsWith('https://registry.npmjs.org/');
if(url.endsWith('.tgz')){process.stdout.write(state.different?Buffer.from('different archive'):readFileSync(state.archive));process.exit(0);}
const origin=state.status??((npm?state.npm:state.jsr)?200:404);
let status=origin;
if(!npm&&state.staleJsr){state.jsrCache??={};status=state.jsrCache[url]??=origin;writeFileSync(path,JSON.stringify(state));}
const body=JSON.stringify({name:'@okikio/opfs',version:'0.1.0',dist:{tarball:'https://registry.npmjs.org/@okikio/opfs/-/opfs-0.1.0.tgz'}});
process.stdout.write(body+(args.includes('--write-out')?'\\n'+status:''));
if(args.includes('--fail')&&status>=400)process.exit(22);
`;

/** Copies the pinned bundled release implementation, not the project's unrelated dependency tree. */
async function fixtureDependencies(root: string, source: URL): Promise<void> {
  const from = await Deno.realPath(fileURLToPath(new URL("node_modules/@varlock/bumpy", source)));
  const metadata = await read<{ version: string; dependencies?: Record<string, string> }>(join(from, "package.json"));
  if (metadata.version !== "1.18.1" || Object.keys(metadata.dependencies ?? {}).length !== 0) {
    throw new Error("Release fixture expects the pinned bundled Bumpy implementation.");
  }
  await copy(from, join(root, "node_modules/@varlock/bumpy"));
  await Deno.mkdir(join(root, ".tmp/deno-cache"), { recursive: true });
  /** Owns copied fixture dependency bytes; no link points at the project checkout. */
  async function copy(from: string, to: string): Promise<void> {
    const info = await Deno.lstat(from);
    if (info.isDirectory) {
      await Deno.mkdir(to, { recursive: true });
      for await (const entry of Deno.readDir(from)) await copy(join(from, entry.name), join(to, entry.name));
    } else if (info.isFile) await Deno.copyFile(from, to);
    else throw new Error("Bundled Bumpy fixture contains an unexpected alias.");
  }
}

/** Commits intentional test-control edits before immutable preparation begins. */
async function commitFixture(value: FixtureType): Promise<void> {
  success(await run(value.root, "git", ["add", "."]));
  success(
    await run(value.root, "git", [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-m",
      "test: freeze gate controls",
    ]),
  );
}
