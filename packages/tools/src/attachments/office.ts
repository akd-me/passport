import { MAX_PAGES, MAX_ROWS } from "./kinds.js";

/**
 * Document extractors run inside the extraction worker (research 03 §2.6). Libraries are pure
 * JS/WASM (CONTRACT: no native modules) and loaded lazily, so a CSV never pays for pdf.js.
 */

/** A 1-based inclusive range parsed from `"3"`, `"2-5"` or `"7-"`. */
export interface Range {
  from: number;
  to: number | null;
}

/** Failure the tool reports with a fixed message (never library text, which may quote content). */
export class ExtractionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ExtractionError";
  }
}

/** Unzipped sizes above this are treated as zip bombs (200 MiB). */
const MAX_UNZIPPED = 200 * 1024 * 1024;

export interface PdfResult {
  text: string;
  pages: { from: number; to: number; total: number };
  scanned: boolean;
  scannedPages: number[];
  pageLimit?: number;
}

/** Text layer of the selected pages, `--- page N ---` separated. No OCR in v1. */
export async function extractPdf(data: Uint8Array, range: Range | undefined): Promise<PdfResult> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // Main-thread "fake worker": pdf.js would otherwise import its worker file by relative URL,
  // which breaks once bundled. The extraction worker already isolates it.
  const worker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;
  const task = pdfjs.getDocument({
    data,
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
  });
  let doc: Awaited<typeof task.promise>;
  try {
    doc = await task.promise;
  } catch (error) {
    await task.destroy();
    if ((error as { name?: string }).name === "PasswordException") {
      throw new ExtractionError("UNSUPPORTED_TYPE", "The PDF is password-protected.");
    }
    throw new ExtractionError("EXTRACTION_FAILED", "The PDF could not be parsed.");
  }
  try {
    const total = doc.numPages;
    const from = Math.min(range?.from ?? 1, total);
    const wanted = Math.min(range?.to ?? total, total);
    const to = Math.min(wanted, from + MAX_PAGES - 1);
    const blocks: string[] = [];
    const scannedPages: number[] = [];
    for (let number = from; number <= to && total > 0; number++) {
      const page = await doc.getPage(number);
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items) {
        if ("str" in item) {
          text += item.str + (item.hasEOL ? "\n" : "");
        }
      }
      text = text.replace(/[ \t]+\n/g, "\n").trim();
      if (!text) {
        scannedPages.push(number);
      }
      blocks.push(
        `--- page ${number} ---\n${text || "[no text layer: scanned or image-only page]"}`,
      );
      page.cleanup();
    }
    return {
      text: blocks.join("\n\n"),
      pages: { from: total ? from : 0, to: total ? to : 0, total },
      scanned: scannedPages.length > 0,
      scannedPages,
      ...(to < wanted ? { pageLimit: MAX_PAGES } : {}),
    };
  } finally {
    await task.destroy();
  }
}

/** Raw text of a .docx (paragraphs separated by blank lines). */
export async function extractDocx(data: Uint8Array): Promise<{ text: string }> {
  const mammoth = (await import("mammoth")).default;
  try {
    const result = await mammoth.extractRawText({ buffer: Buffer.from(data) });
    return { text: result.value.replace(/\n{3,}/g, "\n\n").trim() };
  } catch {
    // mammoth messages can quote document content; report a fixed reason.
    throw new ExtractionError("EXTRACTION_FAILED", "The .docx file could not be parsed.");
  }
}

export interface SheetResult {
  text: string;
  sheets: Array<{ name: string; rows: number }>;
  sheet?: string;
  rows: { from: number; to: number; total: number };
  rowLimit?: number;
}

/** CSV per sheet (`# Sheet: name` headed), or one sheet when `sheet` is given; rows windowed. */
export async function extractSheet(
  data: Uint8Array,
  sheet: string | undefined,
  range: Range | undefined,
): Promise<SheetResult> {
  const XLSX = await import("xlsx");
  const from = range?.from ?? 1;
  const last = range?.to ?? Number.POSITIVE_INFINITY;
  let book: ReturnType<typeof XLSX.read>;
  try {
    book = XLSX.read(data, {
      type: "array",
      dense: true,
      sheetRows: Math.min(last, from + MAX_ROWS - 1),
      cellFormula: false,
      cellHTML: false,
      cellStyles: false,
      bookVBA: false,
    });
  } catch {
    throw new ExtractionError("EXTRACTION_FAILED", "The spreadsheet could not be parsed.");
  }
  const rowsOf = (name: string) => {
    const ws = book.Sheets[name];
    const ref = ws?.["!fullref"] ?? ws?.["!ref"];
    const range = ref ? XLSX.utils.decode_range(ref) : null;
    return range ? range.e.r - range.s.r + 1 : 0;
  };
  const sheets = book.SheetNames.map((name) => ({ name, rows: rowsOf(name) }));
  const chosen = sheet === undefined ? book.SheetNames : book.SheetNames.filter((n) => n === sheet);
  if (sheet !== undefined && !chosen.length) {
    const folded = book.SheetNames.find((n) => n.toLowerCase() === sheet.toLowerCase());
    if (!folded) {
      throw new ExtractionError("SHEET_NOT_FOUND", "No sheet with that name.");
    }
    chosen.push(folded);
  }
  let budget = MAX_ROWS;
  let shownTo = 0;
  let total = 0;
  let limited = false;
  const blocks: string[] = [];
  for (const name of chosen) {
    const ws = book.Sheets[name];
    const lines = ws
      ? XLSX.utils.sheet_to_csv(ws, { blankrows: true, strip: true }).split("\n")
      : [];
    const rowCount = rowsOf(name);
    total = Math.max(total, rowCount);
    const wanted = Math.max(0, Math.min(rowCount, last) - (from - 1));
    const take = Math.min(wanted, budget, Math.max(0, lines.length - (from - 1)));
    limited ||= take < wanted;
    budget -= take;
    shownTo = Math.max(shownTo, from - 1 + take);
    const body = lines.slice(from - 1, from - 1 + take).join("\n");
    blocks.push(sheet === undefined ? `# Sheet: ${name}\n${body}` : body);
  }
  return {
    text: blocks.join("\n\n"),
    sheets,
    ...(sheet !== undefined ? { sheet: chosen[0] as string } : {}),
    rows: { from, to: shownTo, total },
    ...(limited ? { rowLimit: MAX_ROWS } : {}),
  };
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const xmlText = (value: string) =>
  value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
    if (entity[0] === "#") {
      const code =
        entity[1]?.toLowerCase() === "x"
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[entity.toLowerCase()] ?? "";
  });

/** Text of DrawingML paragraphs (`<a:p>` … `<a:t>text</a:t>`). */
function drawingText(xml: string): string {
  return xml
    .split(/<\/a:p>/)
    .map((paragraph) =>
      [...paragraph.matchAll(/<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>/g)]
        .map((match) => xmlText(match[1] ?? ""))
        .join(""),
    )
    .filter((line) => line.trim())
    .join("\n");
}

/** Slide text (and speaker notes) of a .pptx, `--- slide N ---` separated. */
export async function extractPptx(data: Uint8Array): Promise<{ text: string; slides: number }> {
  const { unzipSync, strFromU8 } = await import("fflate");
  let unzipped = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(data, {
      filter: (file) => {
        if (
          !/^ppt\/(?:slides\/(?:_rels\/)?slide|notesSlides\/notesSlide)\d+\.xml(?:\.rels)?$/.test(
            file.name,
          )
        ) {
          return false;
        }
        unzipped += file.originalSize;
        if (unzipped > MAX_UNZIPPED) {
          throw new ExtractionError("EXTRACTION_FAILED", "The presentation is too large.");
        }
        return true;
      },
    });
  } catch (error) {
    if (error instanceof ExtractionError) {
      throw error;
    }
    throw new ExtractionError("EXTRACTION_FAILED", "The .pptx file could not be parsed.");
  }
  const number = (name: string) => Number(/(\d+)\.xml$/.exec(name)?.[1] ?? 0);
  const slides = Object.keys(files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => number(a) - number(b));
  const blocks = slides.map((name) => {
    const n = number(name);
    const body = drawingText(strFromU8(files[name] as Uint8Array));
    // Speaker notes are linked from the slide's relationships, not matched by number.
    const rels = files[`ppt/slides/_rels/slide${n}.xml.rels`];
    const target = rels && /Target="\.\.\/notesSlides\/(notesSlide\d+\.xml)"/.exec(strFromU8(rels));
    const notesFile = target ? files[`ppt/notesSlides/${target[1]}`] : undefined;
    const notes = notesFile ? drawingText(strFromU8(notesFile)) : "";
    return [`--- slide ${n} ---`, body, ...(notes ? [`Notes: ${notes}`] : [])]
      .filter(Boolean)
      .join("\n");
  });
  return { text: blocks.join("\n\n"), slides: slides.length };
}
