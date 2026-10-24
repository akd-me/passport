import type { ActionRecord } from "@passport/types";
import { request } from "../api";

export const renderApi = {
  preview: (html: string, signal?: AbortSignal) =>
    request<{ html: string; height: number }>("/render/preview", {
      method: "POST",
      body: JSON.stringify({ html }),
      signal,
    }),
  saveDraft: (id: string, textBody: string) =>
    request<ActionRecord>(`/actions/${encodeURIComponent(id)}/draft`, {
      method: "PATCH",
      body: JSON.stringify({ textBody }),
    }),
};
