/** Log operational metadata only. Never pass credentials, requests, or message bodies. */
export const logger = {
  info: (message: string) => console.info(`[passport] ${message}`),
  warn: (message: string) => console.warn(`[passport] ${message}`),
  error: (message: string) => console.error(`[passport] ${message}`),
};
