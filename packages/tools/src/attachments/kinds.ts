/**
 * Attachment type detection and limits for `mail_attachment_read` (research 03 §2.6). Declared
 * MIME types are unreliable (`application/octet-stream` is common), so the file name and the
 * first bytes decide too.
 */

/** Extraction routes. `image` and `unsupported` never reach the worker. */
export type AttachmentKind =
  | "text"
  | "pdf"
  | "docx"
  | "sheet"
  | "pptx"
  | "calendar"
  | "message"
  | "image"
  | "unsupported";

/** Images up to this size are returned as image content (2 MiB). */
export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
/** PDF pages extracted per call. */
export const MAX_PAGES = 200;
/** Spreadsheet rows extracted per call, across sheets. */
export const MAX_ROWS = 50_000;
/** Extraction wall-clock limit; the worker is terminated after it. */
export const EXTRACTION_TIMEOUT_MS = 20_000;
/** Image types MCP clients render natively. */
export const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const EXTENSIONS: Record<string, AttachmentKind> = {
  txt: "text",
  text: "text",
  csv: "text",
  tsv: "text",
  json: "text",
  md: "text",
  markdown: "text",
  log: "text",
  xml: "text",
  html: "text",
  htm: "text",
  svg: "text",
  yaml: "text",
  yml: "text",
  pdf: "pdf",
  docx: "docx",
  xlsx: "sheet",
  xlsm: "sheet",
  xls: "sheet",
  ods: "sheet",
  pptx: "pptx",
  ics: "calendar",
  ical: "calendar",
  eml: "message",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
};

const TYPES: Record<string, AttachmentKind> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "sheet",
  "application/vnd.ms-excel": "sheet",
  "application/vnd.ms-excel.sheet.macroenabled.12": "sheet",
  "application/vnd.oasis.opendocument.spreadsheet": "sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "text/calendar": "calendar",
  "application/ics": "calendar",
  "message/rfc822": "message",
  "application/json": "text",
  "application/xml": "text",
  "application/csv": "text",
  "image/svg+xml": "text",
};

const startsWith = (data: Uint8Array, ...bytes: number[]) =>
  bytes.every((byte, index) => data[index] === byte);

/** Image MIME type from magic bytes, or null. */
export function sniffImage(data: Uint8Array): string | null {
  if (startsWith(data, 0x89, 0x50, 0x4e, 0x47)) {
    return "image/png";
  }
  if (startsWith(data, 0xff, 0xd8, 0xff)) {
    return "image/jpeg";
  }
  if (startsWith(data, 0x47, 0x49, 0x46, 0x38)) {
    return "image/gif";
  }
  if (
    startsWith(data, 0x52, 0x49, 0x46, 0x46) &&
    String.fromCharCode(...data.subarray(8, 12)) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

/** Short description of well-known magic bytes (for `UNSUPPORTED_TYPE`), or null. */
export function magicOf(data: Uint8Array): string | null {
  if (startsWith(data, 0x50, 0x4b, 0x03, 0x04)) {
    return "zip";
  }
  if (startsWith(data, 0x25, 0x50, 0x44, 0x46)) {
    return "pdf";
  }
  if (startsWith(data, 0xd0, 0xcf, 0x11, 0xe0)) {
    return "ole2 (legacy Office)";
  }
  if (startsWith(data, 0x1f, 0x8b)) {
    return "gzip";
  }
  if (startsWith(data, 0x37, 0x7a, 0xbc, 0xaf)) {
    return "7z";
  }
  if (startsWith(data, 0x52, 0x61, 0x72, 0x21)) {
    return "rar";
  }
  return sniffImage(data);
}

/** The extraction route: declared type, then extension, then magic bytes. */
export function kindOf(name: string, type: string, data: Uint8Array): AttachmentKind {
  const declared = type.toLowerCase();
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";
  const byType = TYPES[declared];
  if (byType) {
    return byType;
  }
  if (declared.startsWith("image/")) {
    return "image";
  }
  const byExtension = EXTENSIONS[extension];
  if (byExtension) {
    return byExtension;
  }
  if (declared.startsWith("text/")) {
    return "text";
  }
  if (sniffImage(data)) {
    return "image";
  }
  if (startsWith(data, 0x25, 0x50, 0x44, 0x46)) {
    return "pdf";
  }
  return "unsupported";
}
