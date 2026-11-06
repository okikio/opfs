/** Inert, exact-version Netlify SDK closure acquisition. Never installs, imports or executes acquired code. */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { check, digest, fetchBytes, gitBlob, json, output, record, safe, snapshot, tar } from "../acquire.ts";

interface PinType {
  readonly version: string;
  readonly integrity: string;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly peers: Readonly<Record<string, string>>;
}
function pin(
  version: string,
  sri: string,
  dependencies: Record<string, string> = {},
  peers: Record<string, string> = {},
): PinType {
  return { version, integrity: "sha512-" + sri, dependencies, peers };
}
/**
 * Exact primary-registry manifests reviewed on 2026-11-06. Ranges are evidence, not instructions to resolve versions.
 * Each dependency name has one reviewed target below. API 1.9.1 satisfies the SDK's exact pin and all retained peers;
 * historical partial metadata also included 1.10.0, which cannot satisfy several <1.10.0 peers and is not selected here.
 */
const PINS: Readonly<Record<string, PinType>> = {
  "@netlify/blobs": pin(
    "11.1.7",
    "iOOQSC990P5JtvBGfPMngRxId9H7FWJWAZrzGyYWanCreYElkU5VjoTBt0DgJE859ukNGHAwULZlOdiYHESHfA==",
    { "@netlify/otel": "^7.0.6", "@netlify/dev-utils": "6.0.4", "@netlify/runtime-utils": "3.0.0" },
  ),
  "@netlify/runtime-utils": pin(
    "3.0.0",
    "OHo40+V3QZkR+UrDjqhN+LekrAby/dSSJxsvyYs9i88E/mSl3goB/ysoL+VYROm190egxmQyRYlHK7vL4GeHBQ==",
  ),
  "@netlify/dev-utils": pin(
    "6.0.4",
    "VZgq2gqRLQual8P2v6B8/W1WgUNYJvVvgqCIbviPR/BcI6hKvxVBdAMjz+84eU3qpfMau1Bn2J70JDSQSNkNgg==",
    {
      ansis: "^4.1.0",
      dettle: "^1.0.5",
      semver: "^7.7.2",
      decache: "^4.6.2",
      chokidar: "^5.0.0",
      "dot-prop": "9.0.0",
      empathic: "^2.0.0",
      "env-paths": "^3.0.0",
      atomically: "^2.0.3",
      "parse-gitignore": "^2.0.0",
      "@whatwg-node/server": "^0.11.0",
    },
  ),
  "@netlify/otel": pin(
    "7.0.6",
    "PUE0NwWiXU2xh64WNb2y5cFFjkn3CvMH5ReL1zL8M9cue3BmEpqpCb1VPdsnrMtZdatjqmGDND8ACmGdrR/THg==",
    {
      "@opentelemetry/api": "1.9.1",
      "@opentelemetry/core": "2.12.0",
      "@opentelemetry/resources": "2.12.0",
      "@opentelemetry/sdk-trace-node": "2.12.0",
      "@opentelemetry/instrumentation": "^0.223.0",
    },
  ),
  "@envelop/instrumentation": pin(
    "1.0.1",
    "FuexE2qd3Yc1Kh1DjTliwGxb9kyyv4ySBNnfJOxnQasVmGdcqX6AkkO5sIMxLWFRftp8PErOcIn2dQW/1RwytQ==",
    { tslib: "^2.5.0", "@whatwg-node/promise-helpers": "^1.2.1" },
  ),
  "@fastify/busboy": pin(
    "3.2.5",
    "y8MTAeBlEQUNVnskmZQwpseZN3EgCksQNOULlfxWY6o6VEqh01+oExMgbM7gN6YLQ8pNDYeweNPKJRt8jQm2ZQ==",
  ),
  "@opentelemetry/api": pin(
    "1.9.1",
    "gLyJlPHPZYdAk1JENA9LeHejZe1Ti77/pTeFm/nMXmQH/HFZlcS/O2XJB+L8fkbrNSqhdtlvjBVjxwUYanNH5Q==",
  ),
  "@opentelemetry/api-logs": pin(
    "0.223.0",
    "Oepm6etVPFCn0VWB1t833iOTgz1eYBDUPxcrOR/XvwzD1+Ag9VzSPSrrKAFNJ/haatj+8CXbG47pZXvdNQKDJw==",
    { "@opentelemetry/api": "^1.3.0" },
  ),
  "@opentelemetry/context-async-hooks": pin(
    "2.12.0",
    "iK/1nD7mmZVkuYjVjkdFBiCvzntJdFny1S3CYbUYyOq7V5enL6XX+gJ7eh965L1LnS11VA8mQ7Ej/ck04SB0MQ==",
    {},
    { "@opentelemetry/api": ">=1.0.0 <1.10.0" },
  ),
  "@opentelemetry/core": pin(
    "2.12.0",
    "1HsSAuvT4/my0QrXWsyXFdWjKaPeCHsismKZgEEIb8NK13LP6DrMRlsUbvD/0F9mDWK3xDom9AMv3IscxgOnOQ==",
    { "@opentelemetry/semantic-conventions": "^1.29.0" },
    { "@opentelemetry/api": ">=1.0.0 <1.10.0" },
  ),
  "@opentelemetry/instrumentation": pin(
    "0.223.0",
    "tttBo88TbwK1zpsH6VeJoxLQopxOjW3cnrP50fsQJRZftkSKDDwjolXXBvow2jy0LKXlNRkDQh0NT6yI/q+BEQ==",
    { "import-in-the-middle": "^3.0.0", "require-in-the-middle": "^8.0.0", "@opentelemetry/api-logs": "0.223.0" },
    { "@opentelemetry/api": "^1.3.0" },
  ),
  "@opentelemetry/resources": pin(
    "2.12.0",
    "+rSRoOdln6NhXTVcBdHSlZxJDNzwxadeweK2ltZO3tVtfp6aklABc06xclDk6ovRR+EiGgIcSbh/6NgjFhnb3A==",
    { "@opentelemetry/core": "2.12.0", "@opentelemetry/semantic-conventions": "^1.29.0" },
    { "@opentelemetry/api": ">=1.3.0 <1.10.0" },
  ),
  "@opentelemetry/sdk-trace-base": pin(
    "2.12.0",
    "JOERgZCxRM06FEJ5kEWxlSRChah6MmXDx3KwCruqEv/iEyLkTokCSemf2y1w8oIHtfrr8EVTpzebq/31vn2Cpg==",
    {
      "@opentelemetry/core": "2.12.0",
      "@opentelemetry/resources": "2.12.0",
      "@opentelemetry/sdk-trace": "2.12.0",
      "@opentelemetry/semantic-conventions": "^1.29.0",
    },
    { "@opentelemetry/api": ">=1.3.0 <1.10.0" },
  ),
  "@opentelemetry/sdk-trace-node": pin(
    "2.12.0",
    "9DufH1IlmQMoKAfot5y/FhTP1RnmhLb5K6eKmJO/bvzPjYwPAazoiAUbTZFdPbqxOXN0FEbhZx/e6SB1Og4jmg==",
    {
      "@opentelemetry/core": "2.12.0",
      "@opentelemetry/sdk-trace-base": "2.12.0",
      "@opentelemetry/context-async-hooks": "2.12.0",
    },
    { "@opentelemetry/api": ">=1.0.0 <1.10.0" },
  ),
  "@opentelemetry/sdk-trace": pin(
    "2.12.0",
    "ImVuRQ6faOsTi1Wna88s2avgrrf/iDgXPigIeynkUhjstMuoQUDOJXgkez2j1mlU4btjXcXBGa+q7qKFYR3GsA==",
    {
      "@opentelemetry/core": "2.12.0",
      "@opentelemetry/resources": "2.12.0",
      "@opentelemetry/semantic-conventions": "^1.29.0",
    },
    { "@opentelemetry/api": ">=1.3.0 <1.10.0" },
  ),
  "@opentelemetry/semantic-conventions": pin(
    "1.44.0",
    "E3JkOlMBi3N8OGGkbl7tFyqk2MAS6/lySRZBK3Mu7AzjF1fT8oIChH9ChE48SUWzDn9Kdwta+G/p5LJ4xW4CLQ==",
  ),
  "@whatwg-node/disposablestack": pin(
    "0.0.6",
    "LOtTn+JgJvX8WfBVJtF08TGrdjuFzGJc4mkP8EdDI8ADbvO7kiexYep1o8dwnt0okb0jYclCDXF13xU7Ge4zSw==",
    { tslib: "^2.6.3", "@whatwg-node/promise-helpers": "^1.0.0" },
  ),
  "@whatwg-node/fetch": pin(
    "0.10.13",
    "b4PhJ+zYj4357zwk4TTuF2nEe0vVtOrwdsrNo5hL+u1ojXNhh1FgJ6pg1jzDlwlT4oBdzfSwaBwMCtFCsIWg8Q==",
    { "urlpattern-polyfill": "^10.0.0", "@whatwg-node/node-fetch": "^0.8.3" },
  ),
  "@whatwg-node/node-fetch": pin(
    "0.8.6",
    "BDMdYFcerLQkwA2RTldxOqRCs6ZQD1S7UgP3pUdGUkcbgTrP/V5ko77ZkCww9DHmC4lpoYuwigGfQYj285gMvA==",
    {
      tslib: "^2.6.3",
      "@fastify/busboy": "^3.1.1",
      "@whatwg-node/disposablestack": "^0.0.6",
      "@whatwg-node/promise-helpers": "^1.3.2",
    },
  ),
  "@whatwg-node/promise-helpers": pin(
    "1.3.2",
    "Nst5JdK47VIl9UcGwtv2Rcgyn5lWtZ0/mhRQ4G8NN2isxpq2TO30iqHzmwoJycjWuyUfg3GFXqP/gFHXeV57IA==",
    { tslib: "^2.6.3" },
  ),
  "@whatwg-node/server": pin(
    "0.11.0",
    "VSdkwnJRr8Yv9UgB2aXB3VUPWwd6Oqnn0hycFwhg9pZgWxJXb7JmhsiXe9tmpMwjHFxli12PGcz9aI63YYloGQ==",
    {
      tslib: "^2.6.3",
      "@whatwg-node/fetch": "^0.10.13",
      "@envelop/instrumentation": "^1.0.0",
      "@whatwg-node/disposablestack": "^0.0.6",
      "@whatwg-node/promise-helpers": "^1.3.2",
    },
  ),
  ansis: pin("4.5.0", "KwIVkfFfJSSzBmZhDGuTmkhWqTdyB5oNVzzznBJbBZ5bZtHiqSrcugRF0RKJKT4Ss3d7ZrcjnlFVDlQNmtWfWw=="),
  atomically: pin("2.1.1", "P4w9o2dqARji6P7MHprklbfiArZAWvo07yW7qs3pdljb3BWr12FIB7W+p0zJiuiVsUpRO0iZn1kFFcpPegg0tQ==", {
    "when-exit": "^2.1.4",
    "stubborn-fs": "^2.0.0",
  }),
  callsite: pin("1.0.0", "0vdNRFXn5q+dtOqjfFtmtlI9N2eVZ7LMyEV2iKC5mEEFvSg/69Ml6b/WU2qF8W1nLRa0wiSrDT3Y5jOHZCwKPQ=="),
  chokidar: pin("5.0.0", "TQMmc3w+5AxjpL8iIiwebF73dRDF4fBIieAqGn9RGCWaEVwQ6Fb2cGe31Yns0RRIzii5goJ1Y7xbMwo1TxMplw==", {
    readdirp: "^5.0.0",
  }),
  "cjs-module-lexer": pin(
    "2.3.0",
    "lmNyBzi6iYiqyrExTctfmjd8tInx+dHu9PBomTfH5RXS53c27JMFJgzNv5TyAnm3PgGf+MLy0+Ws41/HlVxdKQ==",
  ),
  debug: pin("4.4.3", "RGwwWnwQvkVfavKVt22FGLw+xYSdzARwm0ru6DhTVA3umU5hZc28V3kO4stgYryrTlLpuvgI9GiijltAjNbcqA==", {
    ms: "^2.1.3",
  }),
  decache: pin("4.6.2", "2LPqkLeu8XWHU8qNCS3kcF6sCcb5zIzvWaAHYSvPfwhdd7mHuah29NssMzrTYyHN4F5oFy2ko9OBYxegtU0FEw==", {
    callsite: "^1.0.0",
  }),
  dettle: pin("1.0.5", "ZVyjhAJ7sCe1PNXEGveObOH9AC8QvMga3HJIghHawtG7mE4K5pW9nz/vDGAr/U7a3LWgdOzEE7ac9MURnyfaTA=="),
  "dot-prop": pin("9.0.0", "1gxPBJpI/pcjQhKgIU91II6Wkay+dLcN3M6rf2uwP8hRur3HtQXjVrdAK3sjC0piaEuxzMwjXChcETiJl47lAQ==", {
    "type-fest": "^4.18.2",
  }),
  empathic: pin("2.1.0", "AnfC1ATldl49/cvZdLPDjBfrRNwbDO05aibiOtzQu3qtlbJtomNLhF30HEtn/7iBz50dlMECqATo3fG0LrdEgw=="),
  "env-paths": pin("3.0.0", "dtJUTepzMW3Lm/NPxRf3wP4642UWhjL2sQxc+ym2YMj1m/H2zDNQOlezafzkHwn6sMstjHTwG6iQQsctDW/b1A=="),
  "es-module-lexer": pin(
    "3.0.4",
    "BldNY5mwkVu+cQ5Ymn3e6hB9Sx8XHx4ZevWbiUyZbfKxJxYO27Hf0wfzkxIaD5CAJMaGl3YspKELj0ff/7nCMA==",
  ),
  "import-in-the-middle": pin(
    "3.5.3",
    "usm/IiY63VtOyx/dm7uEoZV+EsanCDmwRUroQZIkFLGu1NVXZ8mZqIOhaN4QIJ7EsbMTuQbJXwCySCx+ozMA8g==",
    { "es-module-lexer": "^3.0.3", "cjs-module-lexer": "^2.2.0", "module-details-from-path": "^1.0.4" },
  ),
  "module-details-from-path": pin(
    "1.0.4",
    "EGWKgxALGMgzvxYF1UyGTy0HXX/2vHLkw6+NvDKW2jypWbHpjQuj4UMcqQWXHERJhVGKikolT06G3bcKe4fi7w==",
  ),
  ms: pin("2.1.3", "6FlzubTLZG3J2a/NVCAleEhjzq5oxgHyaCU9yYXvcLsvoVaHJq/s5xXI6/XXP6tz7R9xAOtHnSO/tXtF3WRTlA=="),
  "parse-gitignore": pin(
    "2.0.0",
    "RmVuCHWsfu0QPNW+mraxh/xjQVw/lhUCUru8Zni3Ctq3AoMhpDTq0OVdKS6iesd6Kqb7viCV3isAL43dciOSog==",
  ),
  readdirp: pin("5.1.1", "Kko+Y5XQ6fM+Ce3dq3m9YGxnacYZYl9cA1wZjaF3Vbry2L3i1qVg8+CAgNPsXRArPMUMCaOR7oa9Nqntc43JKA=="),
  "require-in-the-middle": pin(
    "8.0.1",
    "QT7FVMXfWOYFbeRBF6nu+I6tr2Tf3u0q8RIEjNob/heKY/nh7drD/k7eeMFmSQgnTtCzLDcCu/XEnpW2wk4xCQ==",
    { debug: "^4.3.5", "module-details-from-path": "^1.0.3" },
  ),
  semver: pin("7.8.6", "9lpSSU4Mly3mrtruwLs1eLK6+gzbzqeBFwRNjIjE+9LuDpWdYctrQlQ3ej1Ilgi7gknpsTRnPoLP8DpCHqHIJw=="),
  "stubborn-fs": pin(
    "2.0.0",
    "Y0AvSwDw8y+nlSNFXMm2g6L51rBGdAQT20J3YSOqxC53Lo3bjWRtr2BKcfYoAf352WYpsZSTURrA0tqhfgudPA==",
    { "stubborn-utils": "^1.0.1" },
  ),
  "stubborn-utils": pin(
    "1.0.2",
    "zOh9jPYI+xrNOyisSelgym4tolKTJCQd5GBhK0+0xJvcYDcwlOoxF/rnFKQ2KRZknXSG9jWAp66fwP6AxN9STg==",
  ),
  tslib: pin("2.9.1", "a4Ux9VKuIMHsOS7ENbEq6hK2ZGYIT27Rtl0E4eD9KqwxhKiQeMZE/9xb3IdYwWaSOyIBQLExhQgXDTYoiCxnWA=="),
  "type-fest": pin(
    "4.41.0",
    "TeTSQ6H5YHvpqVwBRcnLDCBnDOHWYu7IvGbHT6N8AOymcr9PJGjc1GTtiWZTYg0NCgYwvnYWEkVChQAr9bjfwA==",
  ),
  "urlpattern-polyfill": pin(
    "10.1.0",
    "IGjKp/o0NL3Bso1PymYURCJxMPNAf/ILOpendP9f5B6e1rTJgdgiOvgfoT8VxCAdY+Wisb9uhGaJJf3yZ2V9nw==",
  ),
  "when-exit": pin("2.1.5", "VGkKJ564kzt6Ms1dbgPP/yuIoQCrsFAnRbptpC5wOEsDaNsbCB2bnfnaA8i/vRs5tjUSEOtIuvl9/MyVsvQZCg=="),
};

/** Exact edge declarations reject unreviewed new ranges, registry aliases, peers and optional dependencies. */
function edges(value: unknown, expected: Readonly<Record<string, string>>, label: string): void {
  const actual = value === undefined ? {} : record(value);
  check(Object.keys(actual).length === Object.keys(expected).length, label + " dependency count differs.");
  for (const [name, range] of Object.entries(expected)) {
    check(
      Object.hasOwn(actual, name) && actual[name] === range && Object.hasOwn(PINS, name),
      label + " dependency edge differs.",
    );
  }
}
function declarations(value: Record<string, unknown>, expected: PinType, label: string): void {
  edges(value.dependencies, expected.dependencies, label);
  edges(value.optionalDependencies, {}, label + " optional");
  edges(value.peerDependencies, expected.peers, label + " peer");
  for (const field of [value.bundledDependencies, value.bundleDependencies]) {
    check(field === undefined || (Array.isArray(field) && field.length === 0), "Unreviewed bundled dependencies.");
  }
}

/** Preserve the upstream-only notice without pretending the published archive contained it. */
async function callsiteNotice(
  root: string,
  deadline: number,
): Promise<readonly { file: string; bytes: number; sha256: string }[]> {
  const parent = "8d3927995821596148e77f4af049ab38b03d1b99", commit = "8d7615a28a6507c3ef0731f072d3f1a100b3fe27";
  const api = "https://api.github.com/repos/tj/callsite/";
  const rawCommit = await fetchBytes(api + "commits/" + commit, 256 * 1024, deadline);
  const description = record(JSON.parse(rawCommit.toString("utf8")));
  check(
    description.sha === commit && Array.isArray(description.parents) && description.parents.length === 1 &&
      record(description.parents[0]).sha === parent && Array.isArray(description.files) &&
      description.files.length === 1,
    "Callsite notice parent/diff differs.",
  );
  const added = record(description.files[0]);
  check(
    added.filename === "LICENSE" && added.status === "added" &&
      added.sha === "8d7b58570b4c52998727e12c39cfdc98318c90fb",
    "Callsite notice-only commit differs.",
  );
  const rawTag = await fetchBytes(api + "git/ref/tags/1.0.0", 65536, deadline);
  const tag = record(JSON.parse(rawTag.toString("utf8"))), target = record(tag.object);
  check(
    tag.ref === "refs/tags/1.0.0" && target.type === "tag" && target.sha === "7a245ebbedda09ba425eb39a61912e3bf91c4c73",
    "Callsite tag differs.",
  );
  const rawAnnotated = await fetchBytes(api + "git/tags/7a245ebbedda09ba425eb39a61912e3bf91c4c73", 65536, deadline);
  const annotated = record(JSON.parse(rawAnnotated.toString("utf8"))), peeled = record(annotated.object);
  check(
    annotated.sha === target.sha && annotated.tag === "1.0.0" && peeled.type === "commit" && peeled.sha === parent,
    "Callsite annotated tag target differs.",
  );
  const rawSource = await fetchBytes(
    "https://raw.githubusercontent.com/tj/callsite/" + parent + "/index.js",
    65536,
    deadline,
  );
  check(
    digest(rawSource) === "948c9c1a2488241caafe25c4f90f5bfe06d3be0942989d74eae821828f31a35b",
    "Callsite tagged runtime source differs.",
  );
  const notice = await fetchBytes(
    "https://raw.githubusercontent.com/tj/callsite/" + commit + "/LICENSE",
    65536,
    deadline,
  );
  check(
    digest(notice) === "52d31bec4bb1a1d6175de0c75d50fcc3f30a5d9f360703a5ce666dc1fe8a6ec8" &&
      gitBlob(notice) === "8d7b58570b4c52998727e12c39cfdc98318c90fb",
    "Callsite supplemental notice identity differs.",
  );
  snapshot(root, "supplemental/callsite/commit.json", rawCommit);
  snapshot(root, "supplemental/callsite/tag.json", rawTag);
  snapshot(root, "supplemental/callsite/annotated-tag.json", rawAnnotated);
  snapshot(root, "supplemental/callsite/index.js.snapshot", rawSource);
  snapshot(root, "supplemental/callsite/LICENSE.snapshot", notice);
  json(root, "supplemental/callsite/provenance.json", {
    parent,
    commit,
    licenseSha256: digest(notice),
    licenseGitBlob: gitBlob(notice),
    runtimeSha256: digest(rawSource),
    scope: "Authentic upstream-only notice added immediately after tagged 1.0.0; original npm bytes remain unchanged.",
    legalReview: "supplemental attribution evidence retained; not an automated legal approval",
  });
  return [
    { file: "supplemental/callsite/commit.json", raw: rawCommit },
    { file: "supplemental/callsite/tag.json", raw: rawTag },
    { file: "supplemental/callsite/annotated-tag.json", raw: rawAnnotated },
    { file: "supplemental/callsite/index.js.snapshot", raw: rawSource },
    { file: "supplemental/callsite/LICENSE.snapshot", raw: notice },
  ].map(({ file, raw }) => ({ file, bytes: raw.length, sha256: digest(raw) }));
}

const { values, positionals } = parseArgs({ options: { output: { type: "string" } }, allowPositionals: true });
check(values.output && positionals.length === 0, "Usage: acquire.ts --output FRESH_DIRECTORY");
await output(resolve(values.output), async (root) => {
  const deadline = Date.now() + 600_000, names = Object.keys(PINS).sort(), inventory: unknown[] = [];
  check(names.length === 46, "Reviewed Netlify closure count differs.");
  const reached = new Set<string>();
  const visit = (name: string): void => {
    if (reached.has(name)) return;
    const node = PINS[name];
    check(node, "Unpinned closure target.");
    reached.add(name);
    for (const dependency of new Set([...Object.keys(node.dependencies), ...Object.keys(node.peers)])) {
      visit(dependency);
    }
  };
  visit("@netlify/blobs");
  check(reached.size === names.length, "Closure contains unreachable package pins.");
  let compressed = 0, expanded = 0, files = 0, metadataBytes = 0, legalBytes = 0;
  for (const name of names) {
    const node = PINS[name]!, id = name + "@" + node.version, path = name.replace("/", "__") + "@" + node.version;
    const metadataURL = "https://registry.npmjs.org/" + encodeURIComponent(name) + "/" + node.version;
    const rawMetadata = await fetchBytes(metadataURL, 256 * 1024, deadline);
    metadataBytes += rawMetadata.length;
    check(metadataBytes <= 8 * 1048576, "Aggregate registry metadata ceiling.");
    snapshot(root, "metadata/" + path + ".json", rawMetadata);
    const metadata = record(JSON.parse(rawMetadata.toString("utf8")));
    check(metadata.name === name && metadata.version === node.version, "Registry package identity differs.");
    declarations(metadata, node, id);
    const dist = record(metadata.dist), base = name.slice(name.lastIndexOf("/") + 1);
    const url = "https://registry.npmjs.org/" + name + "/-/" + base + "-" + node.version + ".tgz";
    check(dist.integrity === node.integrity && dist.tarball === url, "Registry archive identity differs.");
    const raw = await fetchBytes(url, 8 * 1048576, deadline);
    compressed += raw.length;
    check(compressed <= 64 * 1048576, "Aggregate compressed archive ceiling.");
    const sri = "sha512-" + createHash("sha512").update(raw).digest("base64");
    check(sri === node.integrity, "Archive SRI differs from reviewed pin.");
    snapshot(root, "archives/" + path + ".tgz.snapshot", raw);
    const archive = tar(raw, Math.min(32 * 1048576, 96 * 1048576 - expanded), Math.min(6000, 12000 - files));
    expanded += archive.expandedBytes;
    check(expanded <= 96 * 1048576, "Aggregate expanded archive ceiling.");
    const members: unknown[] = [], legal: string[] = [];
    let packed: Record<string, unknown> | undefined;
    for (const member of archive.members) {
      check(member.kind !== "link", "Acquired links are not admitted.");
      if (member.kind === "directory") {
        check(
          member.name === "package/" || member.name.startsWith("package/"),
          "Archive directory escapes package root.",
        );
        continue;
      }
      check(member.name.startsWith("package/"), "Archive file escapes package root.");
      const relative = safe(member.name.slice(8));
      check(++files <= 12000, "Aggregate acquired file count ceiling.");
      snapshot(root, "source/" + path + "/" + relative + ".snapshot", member.data);
      members.push({ path: relative, bytes: member.size, sha256: digest(member.data), mode: member.mode });
      if (relative === "package.json") {
        check(member.size <= 256 * 1024, "Packed package manifest ceiling.");
        packed = record(JSON.parse(member.data.toString("utf8")));
      }
      if (name === "callsite" && relative === "index.js") {
        check(
          digest(member.data) === "948c9c1a2488241caafe25c4f90f5bfe06d3be0942989d74eae821828f31a35b",
          "Callsite packed runtime differs from tagged source.",
        );
      }
      if (
        relative.split("/").some((part) => /^(?:licen[cs]e|notice|copying|copyright)(?:[-_.]|$)/iu.test(part)) ||
        (name === "callsite" && relative === "Readme.md")
      ) {
        legalBytes += member.size;
        check(member.size <= 256 * 1024 && legalBytes <= 4 * 1048576, "Legal evidence ceiling.");
        snapshot(root, "legal/" + path + "/" + relative + ".snapshot", member.data);
        legal.push(relative);
      }
    }
    check(packed && packed.name === name && packed.version === node.version, "Packed package identity differs.");
    declarations(packed, node, id + " packed");
    inventory.push({
      id,
      metadataURL,
      metadataSha256: digest(rawMetadata),
      tarball: url,
      integrity: sri,
      tarballBytes: raw.length,
      tarballSha256: digest(raw),
      expandedBytes: archive.expandedBytes,
      dependencies: node.dependencies,
      peers: node.peers,
      targets: Object.fromEntries(
        [...Object.keys(node.dependencies), ...Object.keys(node.peers)].map((
          dependency,
        ) => [dependency, dependency + "@" + PINS[dependency]!.version]),
      ),
      license: packed.license ?? null,
      legal,
      exports: packed.exports ?? null,
      main: packed.main ?? null,
      scripts: packed.scripts ?? {},
      members,
    });
  }
  const supplemental = await callsiteNotice(root, deadline);
  json(root, "closure.json", {
    root: "@netlify/blobs@11.1.7",
    packages: inventory,
    supplemental,
    totals: { packages: names.length, compressed, expanded, files, metadataBytes, legalBytes },
    scope: "Inert SRI/packed-manifest admission only; no package install, build, lifecycle, import or execution.",
    executableAdmission: false,
    legalReview:
      "pending; callsite upstream-only notice and source relationship retained separately; inspect every package's retained license/notice before SDK execution",
    productionDependencyApproved: false,
  });
});
