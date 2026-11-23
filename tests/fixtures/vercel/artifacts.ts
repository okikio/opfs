/** Reviewed primary-registry identities. Data only; no version resolution, acquisition or package execution. */
export interface VercelArtifactType {
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
  readonly license: string;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly targets: Readonly<Record<string, string>>;
}

/** Keep the declared upstream range distinct from the exact, independently selected closure target. */
function artifact(
  name: string,
  version: string,
  sri: string,
  license = "MIT",
  edges: Readonly<Record<string, readonly [range: string, version: string]>> = {},
): VercelArtifactType {
  return {
    name,
    version,
    integrity: "sha512-" + sri,
    license,
    dependencies: Object.fromEntries(Object.entries(edges).map(([name, [range]]) => [name, range])),
    targets: Object.fromEntries(Object.entries(edges).map(([name, [, version]]) => [name, name + "@" + version])),
  };
}

/** Exact version manifests reviewed on 2026-11-06. Every optional/peer map was empty; acquisition rechecks that fact. */
export const VERCEL_ARTIFACTS: readonly VercelArtifactType[] = [
  artifact(
    "@vercel/blob",
    "2.8.2",
    "ZUUWO2VA00r9ZTRtKgH4va7FGOUxUtge2FaRr9WZmeeX2s3C3qVe2tOTLTbv/tkcd+L+ijxaI2eP9S1/mGHc9Q==",
    "Apache-2.0",
    {
      undici: ["^6.23.0", "6.23.0"],
      "is-buffer": ["^2.0.5", "2.0.5"],
      throttleit: ["^2.1.0", "2.1.0"],
      "async-retry": ["^1.3.3", "1.3.3"],
      "@vercel/oidc": ["^3.6.1", "3.6.1"],
      "is-node-process": ["^1.2.0", "1.2.0"],
    },
  ),
  artifact(
    "@emulators/vercel",
    "0.13.0",
    "3lzIfV4U1iYjnKPppHlZHB3Mxt0lsXqbSZNQw43dMr8uXHlu0IHr7TMn3kQuWn6yU1MwXo4Qjo2hSljur+H2UA==",
    "Apache-2.0",
    {
      "@emulators/core": ["0.13.0", "0.13.0"],
    },
  ),
  artifact(
    "@emulators/core",
    "0.13.0",
    "uh9Z2ZsxsmrHyZQHENRKXRImqTAbHCqrPWCzDSQ/OKwVsiJFZhNZOu1bm/h8jsRsFU5kISuOJcD9XNMP1afwlQ==",
    "Apache-2.0",
    {
      jose: ["^6.2.2", "6.2.2"],
    },
  ),
  artifact(
    "undici",
    "6.23.0",
    "VfQPToRA5FZs/qJxLIinmU59u0r7LXqoJkCzinq3ckNJp3vKEh7jTWN589YQ5+aoAC/TGRLyJLCPKcLQbM8r9g==",
  ),
  artifact(
    "is-buffer",
    "2.0.5",
    "i2R6zNFDwgEHJyQUtJEk0XFi1i0dPFn/oqjK3/vPCcDeJvW5NQ83V8QbicfF1SupOaB0h8ntgBC2YiE7dfyctQ==",
  ),
  artifact(
    "throttleit",
    "2.1.0",
    "nt6AMGKW1p/70DF/hGBdJB57B8Tspmbp5gfJ8ilhLnt7kkr2ye7hzD6NVG8GGErk2HWF34igrL2CXmNIkzKqKw==",
  ),
  artifact(
    "async-retry",
    "1.3.3",
    "wfr/jstw9xNi/0teMHrRW7dsz3Lt5ARhYNZ2ewpadnhaIp5mbALhOAP+EAdsC7t4Z6wqsDVv9+W6gm1Dk9mEyw==",
    "MIT",
    {
      retry: ["0.13.1", "0.13.1"],
    },
  ),
  artifact(
    "retry",
    "0.13.1",
    "XQBQ3I8W1Cge0Seh+6gjj03LbmRFWuoszgK9ooCpwYIrhhoO80pfq4cUkU5DkknwfOfFteRwlZ56PYOGYyFWdg==",
  ),
  artifact(
    "is-node-process",
    "1.2.0",
    "Vg4o6/fqPxIjtxgUH5QLJhwZ7gW5diGCVlXpuUfELC62CuxM1iHcRe51f2W1FDy04Ai4KJkagKjx3XaqyfRKXw==",
  ),
  artifact(
    "@vercel/oidc",
    "3.6.1",
    "8ipTFoiX3WBRrvXLjSrmgAiwtMDQk3EgSxe8N7v2rXBz39NBIIyoGXeVbJRoBcP8WEuVnvjvIQsggbGU7ZKrMw==",
    "Apache-2.0",
    {
      jose: ["^5.9.6", "5.9.6"],
      "@vercel/cli-exec": ["0.1.1", "0.1.1"],
      "@vercel/cli-config": ["0.2.0", "0.2.0"],
    },
  ),
  artifact("jose", "5.9.6", "AMlnetc9+CV9asI19zHmrgS/WYsWUwCn2R7RzlbJWD7F9eWYUTGyBmU9o6PxngtLGOiDGPRu+Uc4fhKzbpteZQ=="),
  artifact("jose", "6.2.2", "d7kPDd34KO/YnzaDOlikGpOurfF0ByC2sEV4cANCtdqLlTfBlw2p14O/5d/zv40gJPbIQxfES3nSx1/oYNyuZQ=="),
  artifact(
    "@vercel/cli-exec",
    "0.1.1",
    "LMRMEai3Z+BODyxGcU9+KiWrS/UElNiOLKiNRfGNt2Vu3NTEmXgFeXG9wBfocAnTe5yJCX/DY6k3k7S/LkPp/g==",
    "Apache-2.0",
    {
      execa: ["5.1.1", "5.1.1"],
    },
  ),
  artifact(
    "@vercel/cli-config",
    "0.2.0",
    "fJRRRB7734BDuXZ89yBEaA2ncYhH7bWX30mk04W80J6VAfQc+4iB8lyzAdaGpFV3/vNlkt9VZt+/uoQoWX6UsQ==",
    "Apache-2.0",
    {
      zod: ["4.1.11", "4.1.11"],
      "xdg-app-paths": ["5", "5.0.0"],
    },
  ),
  artifact("zod", "4.1.11", "WPsqwxITS2tzx1bzhIKsEs19ABD5vmCVa4xBo2tq/SrV4RNZtfws1EnCWQXM6yh8bD08a1idvkB5MZSBiZsjwg=="),
  artifact(
    "xdg-app-paths",
    "5.0.0",
    "EpmEyuo04hiKBXPGmFFAe5aHKiu2FI1Rw25YaGLSnc3VqQeQjr5NzD4QlaaoJkj8kbwjKEUAeqUuL5Ct6nOmkA==",
    "MIT",
    {
      "xdg-portable": ["^7.0.0", "7.0.0"],
    },
  ),
  artifact(
    "xdg-portable",
    "7.0.0",
    "cTPoJ+H60CfK1B0+84y10ii7z12dfeR7bGYPT7SPOgj6bxSvrkloK4tvjU3itQHVBQciNtJCkdsJX0dm67ZNXA==",
  ),
  artifact(
    "execa",
    "5.1.1",
    "8uSpZZocAZRBAPIEINJj3Lo9HyGitllczc27Eh5YYojjMFMn8yHMDMaUHE2Jqfq05D/wucwI4JGURyXt1vchyg==",
    "MIT",
    {
      onetime: ["^5.1.2", "5.1.2"],
      "is-stream": ["^2.0.0", "2.0.1"],
      "get-stream": ["^6.0.0", "6.0.1"],
      "cross-spawn": ["^7.0.3", "7.0.6"],
      "signal-exit": ["^3.0.3", "3.0.7"],
      "merge-stream": ["^2.0.0", "2.0.0"],
      "npm-run-path": ["^4.0.1", "4.0.1"],
      "human-signals": ["^2.1.0", "2.1.0"],
      "strip-final-newline": ["^2.0.0", "2.0.0"],
    },
  ),
  artifact(
    "onetime",
    "5.1.2",
    "kbpaSSGJTWdAY5KPVeMOKXSrPtr8C8C7wodJbcsd51jRnmD+GZu8Y0VoU6Dm5Z4vWr0Ig/1NKuWRKf7j5aaYSg==",
    "MIT",
    {
      "mimic-fn": ["^2.1.0", "2.1.0"],
    },
  ),
  artifact(
    "is-stream",
    "2.0.1",
    "hFoiJiTl63nn+kstHGBtewWSKnQLpyb155KHheA1l39uvtO9nWIop1p3udqPcUd/xbF1VLMO4n7OI6p7RbngDg==",
  ),
  artifact(
    "get-stream",
    "6.0.1",
    "ts6Wi+2j3jQjqi70w5AlN8DFnkSwC+MqmxEzdEALB2qXZYV3X/b1CTfgPLGJNMeAWxdPfU8FO1ms3NUfaHCPYg==",
  ),
  artifact(
    "cross-spawn",
    "7.0.6",
    "uV2QOWP2nWzsy2aMp8aRibhi9dlzF5Hgh5SHaB9OiTGEyDTiJJyx0uy51QXdyWbtAHNua4XJzUKca3OzKUd3vA==",
    "MIT",
    {
      which: ["^2.0.1", "2.0.2"],
      "path-key": ["^3.1.0", "3.1.1"],
      "shebang-command": ["^2.0.0", "2.0.0"],
    },
  ),
  artifact(
    "signal-exit",
    "3.0.7",
    "wnD2ZE+l+SPC/uoS0vXeE9L1+0wuaMqKlfz9AMUo38JsyLSBWSFcHR1Rri62LZc12vLr1gb3jl7iwQhgwpAbGQ==",
    "ISC",
  ),
  artifact(
    "merge-stream",
    "2.0.0",
    "abv/qOcuPfk3URPfDzmZU1LKmuw8kT+0nIHvKrKgFrwifol/doWcdA4ZqsWQ8ENrFKkd67Mfpo/LovbIUsbt3w==",
  ),
  artifact(
    "npm-run-path",
    "4.0.1",
    "S48WzZW777zhNIrn7gxOlISNAqi9ZC/uQFnRdbeIHhZhCA6UqpkOT8T1G7BvfdgP4Er8gF4sUbaS0i7QvIfCWw==",
    "MIT",
    {
      "path-key": ["^3.0.0", "3.1.1"],
    },
  ),
  artifact(
    "human-signals",
    "2.1.0",
    "B4FFZ6q/T2jhhksgkbEW3HBvWIfDW85snkQgawt07S7J5QXTk6BkNV+0yAeZrM5QpMAdYlocGoljn0sJ/WQkFw==",
    "Apache-2.0",
  ),
  artifact(
    "strip-final-newline",
    "2.0.0",
    "BrpvfNAE3dcvq7ll3xVumzjKjZQ5tI1sEUIKr3Uoks0XUl45St3FlatVqef9prk4jRDzhW6WZg+3bk93y6pLjA==",
  ),
  artifact(
    "mimic-fn",
    "2.1.0",
    "OqbOk5oEQeAZ8WXWydlu9HJjz9WVdEIvamMCcXmuqUYjTknH/sqsWvhQ3vgwKFRR1HpjvNBKQ37nbJgYzGqGcg==",
  ),
  artifact(
    "path-key",
    "3.1.1",
    "ojmeN0qd+y0jszEtoY48r0Peq5dwMEkIlCOu6Q5f41lfkswXuKtYrhgoTpLnyIcHm24Uhqx+5Tqm2InSwLhE6Q==",
  ),
  artifact(
    "which",
    "2.0.2",
    "BLI3Tl1TW3Pvl70l3yq3Y64i+awpwXqsGBYWkkqMtnbXgrMD+yj7rhW0kuEDxzJaYXGjEW5ogapKNMEKNMjibA==",
    "ISC",
    {
      isexe: ["^2.0.0", "2.0.0"],
    },
  ),
  artifact(
    "shebang-command",
    "2.0.0",
    "kHxr2zZpYtdmrN1qDjrrX/Z1rR1kG8Dx+gkpK1G4eXmvXswmcE1hTWBWYUzlraYw1/yZp6YuDY77YtvbN0dmDA==",
    "MIT",
    {
      "shebang-regex": ["^3.0.0", "3.0.0"],
    },
  ),
  artifact(
    "isexe",
    "2.0.0",
    "RHxMLp9lnKHGHRng9QFhRCMbYAcVpn69smSGcq3f36xjgVVWThj4qqLbTLlq7Ssj8B+fIQ1EuCEGI2lKsyQeIw==",
    "ISC",
  ),
  artifact(
    "shebang-regex",
    "3.0.0",
    "7++dFhtcx3353uBaq8DDR4NuxBetBzC7ZQOhmTQInHEd6bSrXdiEyzCvG07Z44UYdLShWUyXt5M/yhz8ekcb1A==",
  ),
];

/** SDK and independently authored local service are separate acquisition roots, not provider-equivalence claims. */
export const VERCEL_ROOTS = ["@vercel/blob@2.8.2", "@emulators/vercel@0.13.0"] as const;
