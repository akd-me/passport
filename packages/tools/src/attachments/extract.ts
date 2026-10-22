import { parseMessage } from "./eml.js";
import type { AttachmentKind } from "./kinds.js";
import {
  ExtractionError,
  extractDocx,
  extractPdf,
  extractPptx,
  extractSheet,
  type Range,
} from "./office.js";
import { calendarText, decodeText, parseCalendar, textOf } from "./text.js";

/** One extraction request, posted to the worker (structured-cloned, never transferred). */
export interface ExtractJob {
  kind: Exclude<AttachmentKind, "image" | "unsupported">;
  name: string;
  type: string;
  data: Uint8Array;
  pages?: Range;
  rows?: Range;
  sheet?: string;
}

/** Extracted text plus kind-specific details (page counts, sheets, event fields, headers). */
export interface Extracted {
  text: string;
  details: Record<string, unknown>;
}

export type WorkerReply =
  | { ok: true; value: Extracted }
  | { ok: false; code: string; message: string };

/** Error codes the worker may report verbatim; anything else becomes `EXTRACTION_FAILED`. */
export const EXTRACTION_CODES = new Set([
  "UNSUPPORTED_TYPE",
  "EXTRACTION_FAILED",
  "SHEET_NOT_FOUND",
]);

/** Runs the extractor for `job.kind`. Pure apart from lazy library loading. */
export async function extract(job: ExtractJob): Promise<Extracted> {
  switch (job.kind) {
    case "text":
      return { text: textOf(job.data, job.name, job.type), details: {} };
    case "calendar": {
      const calendar = parseCalendar(decodeText(job.data));
      return { text: calendarText(calendar), details: { calendar } };
    }
    case "message": {
      const { message, text } = parseMessage(job.data);
      return { text, details: { message } };
    }
    case "pdf": {
      const { text, ...details } = await extractPdf(job.data, job.pages);
      return { text, details };
    }
    case "docx":
      return { text: (await extractDocx(job.data)).text, details: {} };
    case "sheet": {
      const { text, ...details } = await extractSheet(job.data, job.sheet, job.rows);
      return { text, details };
    }
    case "pptx": {
      const { text, slides } = await extractPptx(job.data);
      return { text, details: { slides } };
    }
  }
}

/** The worker's reply for a finished extraction; library errors never leak their messages. */
export async function replyFor(job: ExtractJob): Promise<WorkerReply> {
  try {
    return { ok: true, value: await extract(job) };
  } catch (error) {
    if (error instanceof ExtractionError && EXTRACTION_CODES.has(error.code)) {
      return { ok: false, code: error.code, message: error.message };
    }
    return { ok: false, code: "EXTRACTION_FAILED", message: "The attachment could not be parsed." };
  }
}
