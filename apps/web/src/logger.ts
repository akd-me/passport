/** Static operational messages only; never pass requests, responses, or error payloads. */
export const logger = {
  warn(message: string): void {
    console.warn(`[passport] ${message}`);
  },
};
