export interface Cursors {
  mail: string | null;
  calendar: string | null;
}
export const prefix = "passport-sync-v1:";
export const key = (...parts: string[]) => parts.map(encodeURIComponent).join(":");
