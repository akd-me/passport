import { frameUntrusted } from "./frame.js";

/** Deterministic daily evidence is data; the rendering instructions stay outside its frame. */
export function digestRenderPrompt(markdown: string): string {
  return `Create exactly one render summarising the day from the evidence below. Use a clear title, headings, compact lists and a table where comparisons help. Include completed work, pending decisions, matters and trust changes. Call only render; do not change mail or repeat the digest as plain prose. Keep HTML under 64 KiB with no styles or external loads.\n${frameUntrusted("daily digest evidence", markdown.slice(0, 40000))}`;
}
