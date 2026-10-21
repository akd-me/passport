import type { ActionParams, ActionRequest, ActionType } from "@passport/types";
export const now = () => new Date().toISOString();
export const params = <T extends ActionType>(r: ActionRequest, _type: T) =>
  r.params as ActionParams[T];
