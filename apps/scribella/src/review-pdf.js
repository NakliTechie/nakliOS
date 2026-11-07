// Puts notes on the compiled PDF as real PDF annotations, so a co-author sees them in any reader.
import { PDFDocument, PDFHexString, PDFName } from '../vendor/pdf-lib/pdf-lib.esm.js';

const SIZE = 18;

// `notes` is a list of { page, x, y, text } in PDF points from the top left.
export async function annotatePdf(bytes, notes) {
  const pdf = await PDFDocument.load(bytes);
  for (const note of notes) {
    const page = pdf.getPage(note.page - 1), { height } = page.getSize(), bottom = height - note.y;
    const annotation = pdf.context.obj({
      Type:'Annot', Subtype:'Text', Rect:[note.x, bottom - SIZE, note.x + SIZE, bottom], C:[1, 0.8, 0.1], Name:'Comment', F:4,
      Contents:PDFHexString.fromText(note.text), T:PDFHexString.fromText('Scribella'),
    });
    page.node.addAnnot(pdf.context.register(annotation));
  }
  return pdf.save();
}

export const annotationCount = async bytes => (await PDFDocument.load(bytes)).getPages().reduce((total, page) => total + (page.node.lookup(PDFName.of('Annots'))?.size?.() ?? 0), 0);
