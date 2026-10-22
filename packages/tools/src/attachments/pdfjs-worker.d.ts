/** pdf.js ships no types for its worker module; only the handler is used (as a fake worker). */
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown;
}
