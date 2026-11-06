// Test-only acquisition admission; validate before npm ci --ignore-scripts.
import * as fs from "node:fs";
import * as assert from "node:assert/strict";
assert.ok(fs.statSync("/tool/package-lock.json").size <= 4 * 1024 * 1024, "Tool lock exceeds its input bound.");
const lock: { packages: Record<string, { version: string; integrity: string; resolved: string }> } = JSON.parse(
  fs.readFileSync("/tool/package-lock.json", "utf8"),
);
const dependency = lock.packages["node_modules/arweave"];
assert.ok(dependency, "Pinned Arweave package is missing.");
assert.equal(dependency.version, "1.15.7");
assert.equal(dependency.resolved, "https://registry.npmjs.org/arweave/-/arweave-1.15.7.tgz");
assert.equal(
  dependency.integrity,
  "sha512-F+Y4iWU1qea9IsKQ/YNmLsY4DHQVsaJBuhEbFxQn9cfGHOmtXE+bwo14oY8xqymsqSNf/e1PeIfLk7G7qN/hVA==",
);
