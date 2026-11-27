/** Validates the internal structure and references of this Agent Skill. */

const root = new URL("../", import.meta.url);
const required = [
  "SKILL.md",
  "references/01-foundations.md",
  "references/02-releases.md",
  "references/12-verification.md",
  "scripts/audit.ts",
  "evals/cases.json",
  "agents/openai.yaml",
];

for (const relative of required) {
  await Deno.stat(new URL(relative, root));
}

const skill = await Deno.readTextFile(new URL("SKILL.md", root));
if (!skill.startsWith("---\nname: deno-software\n")) {
  throw new Error("SKILL.md frontmatter is missing or malformed");
}

const name = skill.match(/^name:\s*(.+)$/m)?.[1]?.trim();
if (name !== "deno-software") {
  throw new Error("SKILL.md name must match the deno-software directory");
}

for (
  const match of skill.matchAll(
    /`((?:references|scripts|templates|examples|evals)\/[^`]+)`/g,
  )
) {
  const path = match[1];
  try {
    await Deno.stat(new URL(path, root));
  } catch (cause) {
    throw new Error(`Missing referenced path: ${path}`, { cause });
  }
}

for (const match of skill.matchAll(/\[[^\]]+\]\(([^)#]+)(?:#[^)]+)?\)/g)) {
  const path = match[1];
  if (/^https?:/.test(path)) continue;
  try {
    await Deno.stat(new URL(path, root));
  } catch (cause) {
    throw new Error(`Missing Markdown-linked path: ${path}`, { cause });
  }
}

const description = skill.match(/^description:\s*(.+)$/m)?.[1]?.trim();
if (!description || description.length > 1024) {
  throw new Error("SKILL.md description must contain 1 to 1024 characters");
}

console.log("deno-software skill structure is valid");
