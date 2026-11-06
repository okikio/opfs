/* Validate direct artifact pins after npm lock acquisition and before install. */
const fs = require("node:fs");
const assert = require("node:assert/strict");
const lock = JSON.parse(fs.readFileSync("/tool/package-lock.json", "utf8"));
for (
  const [name, version, integrity] of [
    [
      "ardrive-core-js",
      "5.1.1",
      "sha512-ekzPAJpGEUrWyBDvEU5/XrTfCHeUYIQ7FQDx14S3oNRtk9UP4r9l1Oywcp42LuTORT/T6hc5HOIr/oEdfnaX5g==",
    ],
    [
      "arweave",
      "1.15.7",
      "sha512-F+Y4iWU1qea9IsKQ/YNmLsY4DHQVsaJBuhEbFxQn9cfGHOmtXE+bwo14oY8xqymsqSNf/e1PeIfLk7G7qN/hVA==",
    ],
  ]
) {
  const entry = lock.packages[`node_modules/${name}`];
  assert.equal(entry.version, version);
  assert.equal(entry.integrity, integrity);
  assert.equal(entry.resolved, `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`);
}
