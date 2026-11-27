import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { expect } from "@std/expect";

/** Exercise the maintained task; the fixture replaces only its external package and browser commands. */
const task = fileURLToPath(new URL("../../.mise/tasks/prepare/browser.sh", import.meta.url));

/** Package-state transitions and failures supplied by the disposable command fixture. */
interface ScenarioType {
  readonly cached?: boolean;
  readonly partial?: boolean;
  readonly missing?: boolean;
  readonly planStatus?: number;
  readonly repairStatus?: number;
  readonly installStatus?: number;
}

/** Every privileged command resolves inside the fixture. Only temporary files represent package state. */
const command = `#!/usr/bin/env bash
set -euo pipefail
state="$OPFS_BROWSER_TEST_ROOT"
record() { printf '%s\\n' "$1" >> "$state/events"; }
case "\${0##*/}" in
  sudo)
    while [[ \${1:-} == *=* ]]; do export "$1"; shift; done
    if [[ $1 == chown ]]; then exit 0; fi
    exec "$@"
    ;;
  dpkg)
    record dpkg
    if [[ $OPFS_BROWSER_TEST_PARTIAL == true ]]; then
      touch "$state/broken"
      exit 100
    fi
    ;;
  sed)
    # GitHub's mirror list does not exist on every Linux development host.
    case "$*" in
      */etc/apt/apt-mirrors.txt) printf 'https://mirror.fixture.invalid/\\n' ;;
      *) exec /usr/bin/sed "$@" ;;
    esac
    ;;
  apt-get)
    if [[ $1 == update ]]; then
      record apt:update
    elif [[ " $* " == *" --print-uris "* ]]; then
      record apt:uris
    elif [[ " $* " == *" libfixture1 "* ]]; then
      record apt:install
      if (( OPFS_BROWSER_TEST_INSTALL_STATUS != 0 )); then exit "$OPFS_BROWSER_TEST_INSTALL_STATUS"; fi
      touch "$state/installed" "$OPFS_PLAYWRIGHT_APT/libfixture1.deb"
    elif [[ " $* " == *" --fix-broken "* ]]; then
      record apt:repair
      if (( OPFS_BROWSER_TEST_REPAIR_STATUS != 0 )); then exit "$OPFS_BROWSER_TEST_REPAIR_STATUS"; fi
      rm -f "$state/broken"
      touch "$OPFS_PLAYWRIGHT_APT/repaired.deb"
    else
      printf 'Unexpected apt operation: %s\\n' "$*" >&2
      exit 99
    fi
    ;;
  node)
    case "$2" in
      install-deps)
        record plan
        if [[ -f "$state/broken" ]]; then
          printf 'Package state still needs repair.\\n' >&2
          exit 1
        fi
        if (( OPFS_BROWSER_TEST_PLAN_STATUS != 0 )); then
          printf 'Package simulation failed.\\n' >&2
          exit "$OPFS_BROWSER_TEST_PLAN_STATUS"
        fi
        if [[ $OPFS_BROWSER_TEST_MISSING == true && ! -f "$state/installed" ]]; then
          printf 'Missing system dependencies (1):\\n  libfixture1\\n'
          exit 1
        fi
        printf 'All system dependencies are installed.\\n'
        ;;
      install)
        if [[ " $* " == *" --with-deps "* ]]; then record browser:fallback; else record browser:install; fi
        ;;
      *) exit 98 ;;
    esac
    ;;
  *) exit 97 ;;
esac
`;

/** Invoke the real shell task with isolated cache files and a command trace, then remove the fixture. */
function prepare(scenario: ScenarioType = {}) {
  const root = mkdtempSync(join(tmpdir(), "opfs-browser-prepare-"));
  try {
    const bin = join(root, "bin");
    const cache = join(root, "cache");
    mkdirSync(bin);
    mkdirSync(cache);
    writeFileSync(join(root, "events"), "");
    for (const name of ["sudo", "dpkg", "apt-get", "node", "sed"]) {
      writeFileSync(join(bin, name), command, { mode: 0o755 });
    }
    if (scenario.cached) writeFileSync(join(cache, "cached.deb"), "fixture");
    const result = spawnSync("bash", [task], {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        OPFS_PLAYWRIGHT_APT: cache,
        OPFS_BROWSER_TEST_ROOT: root,
        OPFS_BROWSER_TEST_PARTIAL: String(scenario.partial ?? false),
        OPFS_BROWSER_TEST_MISSING: String(scenario.missing ?? false),
        OPFS_BROWSER_TEST_PLAN_STATUS: String(scenario.planStatus ?? 0),
        OPFS_BROWSER_TEST_REPAIR_STATUS: String(scenario.repairStatus ?? 0),
        OPFS_BROWSER_TEST_INSTALL_STATUS: String(scenario.installStatus ?? 0),
      },
    });
    if (result.error) throw result.error;
    return {
      status: result.status,
      events: readFileSync(join(root, "events"), "utf8").trim().split("\n"),
      cached: readdirSync(cache).filter((name) => name.endsWith(".deb")).sort(),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Only apt-based Linux uses this task branch. Other hosts let Playwright own dependency installation.
describe("Playwright Ubuntu package preparation", { skip: process.platform !== "linux" }, () => {
  it("uses a complete cached installation without updating package indexes", () => {
    expect(prepare({ cached: true })).toEqual({
      status: 0,
      events: ["dpkg", "plan", "browser:install"],
      cached: ["cached.deb"],
    });
  });

  it("repairs a partial cached installation before asking for the dependency plan", () => {
    expect(prepare({ cached: true, partial: true })).toEqual({
      status: 0,
      events: ["dpkg", "apt:update", "apt:repair", "plan", "plan", "browser:install"],
      cached: ["repaired.deb"],
    });
  });

  it("installs a valid missing-package plan on a cache miss", () => {
    expect(prepare({ missing: true })).toEqual({
      status: 0,
      events: ["apt:update", "plan", "apt:uris", "apt:install", "plan", "browser:install"],
      cached: ["libfixture1.deb"],
    });
  });

  it("propagates a failed simulation instead of treating it as an empty plan", () => {
    expect(prepare({ planStatus: 1 })).toEqual({
      status: 1,
      events: ["apt:update", "plan"],
      cached: [],
    });
  });

  it("stops before planning when repair fails", () => {
    const result = prepare({ cached: true, partial: true, repairStatus: 100 });
    expect(result.status).toBe(100);
    expect(result.events).toEqual(["dpkg", "apt:update", "apt:repair"]);
  });

  it("stops before browser installation when the package installation fails", () => {
    const result = prepare({ missing: true, installStatus: 100 });
    expect(result.status).toBe(100);
    expect(result.events).toEqual(["apt:update", "plan", "apt:uris", "apt:install"]);
  });
});
