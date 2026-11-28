import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The CLI owns the temporary trace; these tests exercise that actual entrypoint with a native scanner. */
const entry = fileURLToPath(new URL("./secrets.ts", import.meta.url));

/** An isolated Git history and an empty temporary directory that exposes leaked invocation traces. */
interface Fixture {
  readonly root: string;
  readonly temporary: string;
  readonly env: NodeJS.ProcessEnv;
  readonly firstBlob: string;
  readonly secondBlob: string;
  readonly secondCommit: string;
}

/** Execute native Git with local fixture identity and no caller-specific global configuration. */
function git(root: string, env: NodeJS.ProcessEnv, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, env, encoding: "utf8" });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/** Three distinct blobs let a selected range avoid one old blob while still needing its excluded parent. */
function fixture(test: TestContext): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "secret-fixture-"));
  test.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, "repository");
  const temporary = join(directory, "temporary");
  mkdirSync(root);
  mkdirSync(temporary);
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_SYSTEM: devNull,
    GIT_NO_LAZY_FETCH: "1",
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
  };
  git(root, env, "init", "--quiet", "--initial-branch=main");
  git(root, env, "config", "user.name", "Scan fixture");
  git(root, env, "config", "user.email", "fixture@example.invalid");
  git(root, env, "config", "gc.auto", "0");
  const blobs: string[] = [];
  const commits: string[] = [];
  for (const value of ["first ordinary content", "second ordinary content", "third ordinary content"]) {
    writeFileSync(join(root, "document.txt"), `${value}\n`);
    git(root, env, "add", "document.txt");
    git(root, env, "commit", "--quiet", "-m", value);
    blobs.push(git(root, env, "rev-parse", "HEAD:document.txt"));
    commits.push(git(root, env, "rev-parse", "HEAD"));
  }
  return { root, temporary, env, firstBlob: blobs[0]!, secondBlob: blobs[1]!, secondCommit: commits[1]! };
}

/** Remove only an expendable loose blob; commit and tree identities remain the native Git history. */
function removeBlob(source: Fixture, sha: string): void {
  rmSync(join(source.root, ".git", "objects", sha.slice(0, 2), sha.slice(2)));
}

/** Run the unchanged scanner argument contract, before or after the status guard. */
function invoke(source: Fixture, args: readonly string[], guarded = true): SpawnSyncReturns<string> {
  const program = guarded ? "node" : "gitleaks";
  const options = guarded
    ? [entry, ...args]
    : ["git", "--redact", "--no-banner", "--log-level", "warn", "--exit-code", "1", ...args, "."];
  const result = spawnSync(program, options, {
    cwd: source.root,
    env: source.env,
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(result.error, undefined);
  assert.deepEqual(readdirSync(source.temporary), [], "the invocation must remove its raw Git trace");
  return result;
}

before(() => {
  const version = spawnSync("gitleaks", ["version"], { encoding: "utf8" });
  assert.equal(version.error, undefined, "run mise run test:secrets to provide the pinned native scanner");
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), "8.30.1", "review the native scanner contract when changing its pin");
});

describe("native secret scan status", () => {
  it("rejects Gitleaks' false success after a historical Git blob is missing", (test) => {
    const source = fixture(test);
    removeBlob(source, source.firstBlob);
    const before = invoke(source, [], false);
    assert.equal(before.status, 0, "the regression requires the actual scanner's false zero");
    assert.match(before.stderr, /unable to read/);
    const after = invoke(source, []);
    assert.equal(after.status, 2);
    assert.match(after.stderr, /Git log failed with exit code 128/);
  });
  it("accepts the complete visible scope of a valid shallow clone", (test) => {
    const source = fixture(test);
    const shallow = join(source.root, "..", "shallow");
    git(source.root, source.env, "clone", "--quiet", "--depth=1", pathToFileURL(source.root).href, shallow);
    assert.equal(git(shallow, source.env, "rev-parse", "--is-shallow-repository"), "true");
    assert.equal(invoke({ ...source, root: shallow }, []).status, 0);
  });
  it("preserves a selected range that does not read a missing older blob", (test) => {
    const source = fixture(test);
    removeBlob(source, source.firstBlob);
    const result = invoke(source, [`--log-opts=${source.secondCommit}..HEAD`]);
    assert.equal(result.status, 0, result.stderr);
  });
  it("checks the parent side of selected patches even when that commit is excluded", (test) => {
    const source = fixture(test);
    removeBlob(source, source.secondBlob);
    const result = invoke(source, ["--log-opts", `${source.secondCommit}..HEAD`]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Git log failed with exit code 128/);
  });
  it("preserves staged scanning without requiring unrelated history blobs", (test) => {
    const source = fixture(test);
    removeBlob(source, source.firstBlob);
    writeFileSync(join(source.root, "document.txt"), "ordinary staged change\n");
    git(source.root, source.env, "add", "document.txt");
    const result = invoke(source, ["--staged"]);
    assert.equal(result.status, 0, result.stderr);
  });
  it("preserves the scanner's own failure and both output streams", (test) => {
    const source = fixture(test);
    const args = ["--not-a-gitleaks-option"];
    const before = invoke(source, args, false);
    const after = invoke(source, args);
    assert.notEqual(before.status, 0);
    assert.equal(after.status, before.status);
    assert.equal(after.stdout, before.stdout);
    assert.equal(after.stderr, before.stderr);
  });
  for (const help of ["--help", "-h"]) {
    it(`preserves standalone ${help} before a repository exists`, (test) => {
      const source = fixture(test);
      rmSync(join(source.root, ".git"), { recursive: true });
      const before = invoke(source, [help], false);
      const after = invoke(source, [help]);
      assert.equal(after.status, 0, after.stderr);
      assert.equal(after.stdout, before.stdout);
      assert.equal(after.stderr, before.stderr);
    });
  }
  it("does not mistake another option's value for the standalone help control", (test) => {
    const source = fixture(test);
    removeBlob(source, source.firstBlob);
    const result = invoke(source, ["--report-path", "--help", "--report-format", "json"]);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /Git log failed with exit code 128/);
  });
});
