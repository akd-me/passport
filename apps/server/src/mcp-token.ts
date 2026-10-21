import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Shared by the HTTP listener and client installer; never prints the token. */
export async function loadMcpToken(
  dataDir: string,
  options: { create?: boolean } = {},
): Promise<string> {
  const validate = (token: string): string => {
    if (!token || /\s/.test(token))
      throw new Error("MCP token must be nonempty and contain no whitespace.");
    return token;
  };
  if (process.env.PASSPORT_MCP_TOKEN !== undefined) return validate(process.env.PASSPORT_MCP_TOKEN);
  const path = join(dataDir, "mcp-token");
  try {
    return validate((await readFile(path, "utf8")).trim());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (options.create === false) return "<generated-on-install>";
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("hex");
  try {
    await writeFile(path, `${token}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return validate((await readFile(path, "utf8")).trim());
  }
  return token;
}
