// Слова PDF с координатами через pdfjs-dist. Подключается динамически (не раздувает основной пакет). Данные никуда не уходят.
import type { PdfPage } from './types'

export async function extractPdfPages(data: Uint8Array): Promise<PdfPage[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url).toString()
  }
  const doc = await pdfjs.getDocument({ data: data.slice() }).promise
  const pages: PdfPage[] = []
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await (await doc.getPage(p)).getTextContent()
    pages.push({
      items: tc.items.flatMap((i) => ('str' in i ? [{ str: i.str, x: i.transform[4]!, y: i.transform[5]!, w: i.width }] : [])),
    })
  }
  return pages
}
