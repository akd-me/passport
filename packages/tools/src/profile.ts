import { getEffectiveProfile } from "@passport/types";
import type { Context } from "./context.js";
import { writeResult } from "./presentation.js";
import { register } from "./register.js";
import { schema as z } from "./schema.js";
import * as s from "./schemas.js";

/** Replace a knowledge section, preserving every other section and standing instruction. */
function section(markdown: string, heading: string, body: string): string {
  const match = new RegExp(`^## ${heading}[ \\t]*\\r?$`, "im").exec(markdown);
  const replacement = `## ${heading}\n${body}\n\n`;
  if (!match) {
    return `${markdown.trimEnd()}\n\n${replacement}`;
  }
  const start = match.index + match[0].length;
  const next = /^#{1,2}[ \t]+/m.exec(markdown.slice(start));
  return (
    markdown.slice(0, match.index) +
    replacement +
    markdown.slice(next ? start + next.index : markdown.length)
  );
}

export function learnedProfile(
  markdown: string,
  voice: string,
  signature: string,
  vips: string[],
): string {
  let next = section(markdown, "Voice", voice);
  // Signature already lives inside Identity in the default template. Preserve its other lines.
  if (/^Signature:[^\r\n]*$/m.test(next)) {
    next = next.replace(/^Signature:[^\r\n]*$/m, () => `Signature: ${signature}`);
  } else {
    next = section(next, "Signature", signature);
  }
  return section(
    next,
    "VIPs",
    vips.length ? vips.map((vip) => `- ${vip}`).join("\n") : "- No VIPs inferred from this sample.",
  );
}

export function registerProfile(ctx: Context): void {
  const line = z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .regex(/^[^\r\n]+$/, "Use a single line.");
  register(
    ctx,
    "profile_update",
    "Propose Voice, Signature and VIP entries for USER.md as one reversible profile_update action. Always asks the person; never writes a pending proposal. Preserve standing rules and other sections.",
    {
      accountId: s.id.optional(),
      voice: line,
      signature: line,
      vips: z.array(line).max(20),
      reason: s.reason,
    },
    true,
    async ({ accountId, voice, signature, vips, reason }, call) => {
      const markdown = learnedProfile(
        await getEffectiveProfile(call.store),
        voice,
        signature,
        vips,
      );
      return writeResult(
        await call.submit(
          "profile_update",
          (await call.account(accountId)).id,
          { markdown },
          reason,
        ),
      );
    },
  );
}
