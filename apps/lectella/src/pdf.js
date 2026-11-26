// Text from a PDF, with pdf.js (Mozilla, Apache-2.0) vendored in vendor/pdfjs-6.2.108 and loaded on the first PDF.
// Text layer only: a scanned PDF with no text layer is refused with a message, because there is no OCR yet.

const BASE = new URL('../vendor/pdfjs-6.2.108/', import.meta.url);

/** @type {Promise<any> | null} */
let lib = null;
const load = () =>
  (lib ??= import(new URL('pdf.min.mjs', BASE).href).then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', BASE).href;
    return pdfjs;
  }));

/**
 * Extract the text of every page, pages separated by a blank line, lines kept where the PDF ends them.
 * @param {Uint8Array} bytes
 * @param {{ onPage?: (n: number, total: number) => void }} [opts]
 * @returns {Promise<{ text: string, pages: number, title: string }>}
 */
export async function pdfText(bytes, { onPage } = {}) {
  const pdfjs = await load();
  // pdf.js takes ownership of the buffer it is given, so it gets a copy and the caller keeps the original.
  const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, disableFontFace: true });
  try {
    const doc = await task.promise;
    const pages = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      let line = '';
      const lines = [];
      for (const item of content.items) {
        if (!('str' in item)) continue;
        line += item.str;
        if (item.hasEOL) {
          lines.push(line);
          line = '';
        } else if (item.str && !line.endsWith(' ')) line += ' ';
      }
      if (line.trim()) lines.push(line);
      pages.push(lines.map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n').trim());
      page.cleanup();
      onPage?.(p, doc.numPages);
    }
    const text = pages.filter(Boolean).join('\n\n');
    if (!text.trim()) throw new Error('This PDF has no text layer (it looks scanned). nResearch cannot read scanned pages yet.');
    const meta = await doc.getMetadata().catch(() => null);
    const title = String(meta?.info?.Title ?? '').trim();
    return { text, pages: doc.numPages, title };
  } finally {
    await task.destroy();
  }
}
