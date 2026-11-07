// The PDF pane. A new PDF replaces the old one only once it has loaded, so a failed build leaves the last good PDF on
// screen, and the reader keeps their page and offset across rebuilds.
import * as pdfjs from '../vendor/pdfjs/pdf.min.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;

const WIDTH_MARGIN = 24;

export function createPdfView(scroller, { onPages = () => {}, onPoint = () => {} } = {}) {
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
    if (run !== generation) return;
    const text = document.createElement('div');
    text.className = 'textLayer';
    text.style.setProperty('--total-scale-factor', scale);
    text.style.setProperty('--scale-round-x', '1px');
    text.style.setProperty('--scale-round-y', '1px');
    await new pdfjs.TextLayer({ textContentSource:page.streamTextContent(), container:text, viewport:page.getViewport({ scale }) }).render();
    if (run === generation) holder.replaceChildren(canvas, text, ...holder.querySelectorAll('.mark'));
  }

  async function layout(place) {
    const run = ++generation;
    watcher?.disconnect();
    // Pages stay on screen until their replacement is drawn, so a rebuild does not flash.
    const old = [...scroller.children], holders = [];
    for (let number = 1; number <= doc.numPages; number += 1) {
      const page = await doc.getPage(number);
      if (run !== generation) return;
      const { width, height } = page.getViewport({ scale:1 });
      const scale = fitScale({ width });
      const holder = old[number - 1] || document.createElement('div');
      holder.className = 'pdf-page';
      holder.dataset.page = number;
      holder.dataset.scale = scale;
      holder.style.width = `${width * scale}px`;
      holder.style.height = `${height * scale}px`;
      holders.push(holder);
    }
    if (old.length !== holders.length || holders.some((holder, index) => old[index] !== holder)) scroller.replaceChildren(...holders);
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

  scroller.addEventListener('dblclick', event => {
    const holder = event.target.closest?.('.pdf-page');
    if (!holder) return;
    const box = holder.getBoundingClientRect(), scale = Number(holder.dataset.scale);
    onPoint({ page:Number(holder.dataset.page), x:(event.clientX - box.left) / scale, y:(event.clientY - box.top) / scale });
  });

  function mark(holder, box, className) {
    const scale = Number(holder.dataset.scale), node = document.createElement('div');
    node.className = `mark ${className}`;
    Object.assign(node.style, { left:`${box.x * scale}px`, top:`${box.y * scale}px`, width:`${box.width * scale}px`, height:`${box.height * scale}px` });
    holder.append(node);
    return node;
  }

  const clearMarks = () => scroller.querySelectorAll('.mark').forEach(node => node.remove());
  const holderOf = page => scroller.querySelector(`.pdf-page[data-page="${page}"]`);

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
    // Marks a box in PDF points and brings it into view.
    reveal(box) {
      const holder = holderOf(box.page);
      if (!holder) return false;
      clearMarks();
      const node = mark(holder, box, 'sync');
      scroller.scrollTop = holder.offsetTop + node.offsetTop - scroller.clientHeight / 3;
      setTimeout(() => node.remove(), 2500);
      return true;
    },
    // Answers every match as { page, x, y, width, height } in PDF points. Text split across items is not matched.
    async find(query) {
      if (!doc || !query) return [];
      const found = [], needle = query.toLowerCase();
      for (let number = 1; number <= doc.numPages; number += 1) {
        const page = await doc.getPage(number);
        const height = page.getViewport({ scale:1 }).height;
        for (const item of (await page.getTextContent()).items) {
          const text = item.str?.toLowerCase() || '', perChar = item.width / Math.max(text.length, 1);
          for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) {
            found.push({ page:number, x:item.transform[4] + perChar * at, y:height - item.transform[5] - item.height, width:perChar * query.length, height:item.height || 10 });
          }
        }
      }
      return found;
    },
    // What the PDF says about itself, for the submission check.
    async inspect() {
      if (!doc) return null;
      const { info, metadata } = await doc.getMetadata();
      const facts = { author:info?.Author || metadata?.get?.('dc:creator')?.toString() || '', creator:info?.Creator || '', links:[], fonts:[] };
      const seen = new Set();
      for (let number = 1; number <= doc.numPages; number += 1) {
        const page = await doc.getPage(number);
        for (const item of await page.getAnnotations()) if (item.url) facts.links.push({ page:number, url:item.url });
        const list = await page.getOperatorList();
        for (let index = 0; index < list.fnArray.length; index += 1) {
          if (list.fnArray[index] !== pdfjs.OPS.setFont) continue;
          const name = list.argsArray[index][0];
          if (seen.has(name)) continue;
          seen.add(name);
          const font = page.commonObjs.has(name) ? page.commonObjs.get(name) : null;
          if (font) facts.fonts.push({ page:number, name:font.name || name, type3:!!font.isType3Font, embedded:!font.missingFile });
        }
      }
      return facts;
    },
    get pages() { return doc?.numPages ?? 0; },
  };
}
