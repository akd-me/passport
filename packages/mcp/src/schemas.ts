import { z } from "zod";

/** Resource and prompt arguments; tool schemas live exclusively in @passport/tools. */
export const id = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .describe("Passport record ID (not a provider ID).");
