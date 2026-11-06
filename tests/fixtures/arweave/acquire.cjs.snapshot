// Test-only acquisition admission; validate before npm ci --ignore-scripts.
const fs = require("node:fs");
const assert = require("node:assert/strict");
const lock = JSON.parse(fs.readFileSync("/tool/package-lock.json", "utf8"));
const dependency = lock.packages["node_modules/arweave"];
assert.equal(dependency.version, "1.15.7");
assert.equal(dependency.resolved, "https://registry.npmjs.org/arweave/-/arweave-1.15.7.tgz");
assert.equal(
  dependency.integrity,
  "sha512-F+Y4iWU1qea9IsKQ/YNmLsY4DHQVsaJBuhEbFxQn9cfGHOmtXE+bwo14oY8xqymsqSNf/e1PeIfLk7G7qN/hVA==",
);
