import { z } from "zod";

/**
 * Performs a conservative, read-only audit of a Deno or hybrid repository.
 *
 * The report identifies project mode, manifests, lockfiles, workspace declarations,
 * broad permission tasks, likely entrypoints, tests, and CI configuration. Findings
 * are prompts for review, not guaranteed defects.
 */

const AuditFindingSchema = z.object({
  level: z.enum(["info", "warning"]),
  code: z.string(),
  message: z.string(),
});
type AuditFinding = z.infer<typeof AuditFindingSchema>;

const AuditReportSchema = z.object({
  root: z.string(),
  manifestShape: z.enum(["deno-only", "package-only", "both", "none"]),
  files: z.array(z.string()),
  findings: z.array(AuditFindingSchema),
});
type AuditReport = z.infer<typeof AuditReportSchema>;

const decoder = new TextDecoder();

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return decoder.decode(await Deno.readFile(path));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

async function walk(root: string, depth = 0): Promise<string[]> {
  if (depth > 4) return [];
  const output: string[] = [];
  for await (const entry of Deno.readDir(root)) {
    if (
      [".git", "node_modules", ".deno", "coverage", "dist", "build"].includes(
        entry.name,
      )
    ) {
      continue;
    }
    const path = `${root}/${entry.name}`;
    output.push(path);
    if (entry.isDirectory) output.push(...await walk(path, depth + 1));
  }
  return output;
}

function detectManifestShape(
  hasDeno: boolean,
  hasPackage: boolean,
): AuditReport["manifestShape"] {
  if (hasDeno && hasPackage) return "both";
  if (hasDeno) return "deno-only";
  if (hasPackage) return "package-only";
  return "none";
}

async function audit(root: string): Promise<AuditReport> {
  const denoPath = `${root}/deno.json`;
  const denoJsoncPath = `${root}/deno.jsonc`;
  const packagePath = `${root}/package.json`;
  const hasDeno = await exists(denoPath) || await exists(denoJsoncPath);
  const hasPackage = await exists(packagePath);
  const files = await walk(root);
  const findings: AuditFinding[] = [];
  const denoConfig = await readText(
    await exists(denoPath) ? denoPath : denoJsoncPath,
  );
  const packageJson = await readText(packagePath);

  if (!hasDeno && !hasPackage) {
    findings.push({
      level: "warning",
      code: "NO_MANIFEST",
      message: "No Deno or package.json manifest found.",
    });
  }
  if (!files.some((file) => file.endsWith("deno.lock"))) {
    findings.push({
      level: "warning",
      code: "NO_DENO_LOCK",
      message: "No deno.lock was found; confirm the reproducibility policy.",
    });
  }
  if (denoConfig?.match(/(?:^|[\s\":])-A(?:$|[\s\"])/m)) {
    findings.push({
      level: "warning",
      code: "BROAD_PERMISSION",
      message:
        "A configured task appears to grant all permissions; review whether narrower access is possible.",
    });
  }
  if (
    denoConfig?.includes('"workspace"') && packageJson?.includes('"workspaces"')
  ) {
    findings.push({
      level: "info",
      code: "DUAL_WORKSPACE",
      message:
        "Both Deno and package workspace declarations exist; document which one owns membership.",
    });
  }
  if (
    !files.some((file) =>
      /(?:_test|\.test|\.spec)\.(?:ts|tsx|js|jsx)$/.test(file)
    )
  ) {
    findings.push({
      level: "warning",
      code: "NO_TESTS",
      message: "No conventional test files were found within the audit depth.",
    });
  }
  if (!files.some((file) => file.includes("/.github/workflows/"))) {
    findings.push({
      level: "info",
      code: "NO_GITHUB_CI",
      message:
        "No GitHub Actions workflow was found; another CI system may own verification.",
    });
  }

  return AuditReportSchema.parse({
    root,
    manifestShape: detectManifestShape(hasDeno, hasPackage),
    files: files.filter((file) =>
      /(?:deno\.jsonc?|package\.json|lock|_test\.|\.test\.|\.spec\.|\.github\/workflows)/
        .test(file)
    ),
    findings,
  });
}

if (import.meta.main) {
  const root = Deno.args[0] ?? Deno.cwd();
  const report = await audit(root.replace(/\/$/, ""));
  console.log(JSON.stringify(report, null, 2));
}
