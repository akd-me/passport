import { readFile } from "node:fs/promises";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version ?? "")) {
  throw new Error("Usage: node scripts/release-notes.mjs <version>");
}
const changelog = await readFile(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const sections = changelog.split(/^## /m).slice(1);
const section = sections.find((value) => value.startsWith(`[${version}]`));
if (!section) {
  throw new Error(`No CHANGELOG.md section for ${version}`);
}
console.log(section.slice(section.indexOf("\n") + 1).trim());
