// Deliberately accepts only safe metadata, never records, bodies, or credentials.
export const logger = {
  error(message: string, metadata: { eventType: string }): void {
    console.error(`[passport/store] ${message}`, metadata);
  },
};
