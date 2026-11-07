// The PDF pane. A new PDF replaces the old one only once it has loaded, so a failed build leaves the last good PDF on
// screen, and the reader keeps their page and offset across rebuilds.
import * as pdfjs from '../vendor/pdfjs/pdf.min.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;

const WIDTH_MARGIN = 24;

export function createPdfView(scroller, { onPages = () => {} } = {}) {
  let doc = null, loading = null, zoom = 1, generation = 0;
  let watcher = null;

  function anchor() {
    const pages = [...scroller.children];
    const page = pages.find(item => item.offsetTop + item.offsetHeight > scroller.scrollTop);
    if (!page) return null;
    return { index:pages.indexOf(page), fraction:(scroller.scrollTop - page.offsetTop) / page.offsetHeight };
  }

  function restore(place) {
    const page = place && scroller.children[Math.min(place.index, scroller.children.length - 1)];
    if (page) scroller.scrollTop = page.offsetTop + place.fraction * page.offsetHeight;
  }

  const fitScale = viewport => ((scroller.clientWidth - WIDTH_MARGIN) / viewport.width) * zoom;

  async function paint(holder, number, run) {
    const page = await doc.getPage(number);
    if (run !== generation) return;
    const scale = fitScale(page.getViewport({ scale:1 }));
    const ratio = window.devicePixelRatio || 1;
    const viewport = page.getViewport({ scale:scale * ratio });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas.style.width = '100%';
    await page.render({ canvas, canvasContext:canvas.getContext('2d'), viewport }).promise;
    if (run === generation) holder.replaceChildren(canvas);
  }

  async function layout(place) {
    const run = ++generation;
    watcher?.disconnect();
    const holders = [];
    for (let number = 1; number <= doc.numPages; number += 1) {
      const page = await doc.getPage(number);
      if (run !== generation) return;
      const { width, height } = page.getViewport({ scale:1 });
      const scale = fitScale({ width });
      const holder = document.createElement('div');
      holder.className = 'pdf-page';
      holder.dataset.page = number;
      holder.style.width = `${width * scale}px`;
      holder.style.height = `${height * scale}px`;
      holders.push(holder);
    }
    scroller.replaceChildren(...holders);
    restore(place);
    // One observer per layout, so a late callback from an old layout cannot claim a page of this one.
    const current = watcher = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        current.unobserve(entry.target);
        paint(entry.target, Number(entry.target.dataset.page), run).catch(error => console.error('PDF page failed', error));
      }
    }, { root:scroller, rootMargin:'600px 0px' });
    holders.forEach(holder => current.observe(holder));
    onPages(doc.numPages);
  }

  let lastWidth = 0, resizing = 0;
  new ResizeObserver(() => {
    if (!doc || scroller.clientWidth === lastWidth) return;
    lastWidth = scroller.clientWidth;
    clearTimeout(resizing);
    resizing = setTimeout(() => layout(anchor()), 200);
  }).observe(scroller);

  return {
    async show(bytes) {
      const task = pdfjs.getDocument({ data:bytes });
      const next = await task.promise;
      const place = anchor(), old = loading;
      doc = next;
      loading = task;
      await layout(place);
      old?.destroy();
    },
    clear() {
      generation += 1;
      watcher?.disconnect();
      loading?.destroy();
      doc = loading = null;
      scroller.replaceChildren();
    },
    zoomBy(step) {
      if (!doc) return zoom;
      zoom = Math.min(4, Math.max(0.4, zoom + step));
      layout(anchor());
      return zoom;
    },
    get pages() { return doc?.numPages ?? 0; },
  };
}
