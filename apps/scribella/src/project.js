// Projects are folders under `projects/`. Build output and hidden files stay out of the tree, and `.scribella.json`
// holds the settings a project carries with it.
const ROOT = 'projects';
const SETTINGS = '.scribella.json';
const TEXT = /\.(tex|ltx|bib|sty|cls|bst|bbx|cbx|txt|md|csv|tsv)$/i;

export const isText = path => TEXT.test(path);
export const isImage = path => /\.(png|jpe?g|pdf|eps)$/i.test(path);
export const projectFolder = name => `${ROOT}/${name}`;
export const safeName = name => name.trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/^\.+/, '').slice(0, 80);

export const TEMPLATES = {
  article:{ label:'Article with references', main:'main.tex', files:{
    'main.tex':`\\documentclass[11pt]{article}
\\usepackage{amsmath}
\\usepackage{graphicx}
\\usepackage{hyperref}

\\title{Your title}
\\author{Your name}
\\date{\\today}

\\begin{document}
\\maketitle

\\begin{abstract}
One paragraph that says what you did and what you found.
\\end{abstract}

\\section{Introduction}
\\label{sec:intro}
Start writing here. Cite a paper like this~\\cite{knuth1984}, and refer to Section~\\ref{sec:intro}.

\\bibliographystyle{plain}
\\bibliography{references}
\\end{document}
`,
    'references.bib':`@book{knuth1984,
  title = {The {\\TeX}book},
  author = {Knuth, Donald E.},
  publisher = {Addison-Wesley},
  year = {1984}
}
`,
  } },
  blank:{ label:'Blank document', main:'main.tex', files:{
    'main.tex':`\\documentclass{article}

\\begin{document}

\\end{document}
`,
  } },
};

export async function listProjects(store) {
  if (!await store.exists(ROOT)) return [];
  return (await store.list(ROOT)).filter(entry => entry.endsWith('/')).map(entry => entry.slice(0, -1).split('/').pop()).sort();
}

// Venue templates ship as files beside the page; `load` reads one as bytes.
export async function loadVenues(load = path => fetch(path).then(reply => { if (!reply.ok) throw new Error(`Could not load ${path}`); return reply; })) {
  const list = await (await load('./templates/index.json')).json();
  return Object.fromEntries(Object.entries(list).map(([id, venue]) => [id, { ...venue, async read() {
    return Object.fromEntries(await Promise.all(venue.files.map(async file => [file, new Uint8Array(await (await load(`./templates/${id}/${file}`)).arrayBuffer())])));
  } }]));
}

export async function createProject(store, name, templateId = 'article', venues = {}) {
  const clean = safeName(name), template = TEMPLATES[templateId] || venues[templateId];
  if (!clean) throw new Error('Give the project a name.');
  if (!template) throw new Error(`There is no template ${templateId}.`);
  if (await store.exists(projectFolder(clean))) throw new Error(`A project called ${clean} already exists.`);
  const files = template.read ? await template.read() : template.files;
  for (const [path, data] of Object.entries(files)) await store.write(`${projectFolder(clean)}/${path}`, data);
  await writeSettings(store, clean, { main:template.main, engine:template.engine || 'pdflatex' });
  return clean;
}

export async function listFiles(store, name) {
  const root = projectFolder(name), pending = [root], files = [];
  while (pending.length) {
    for (const entry of await store.list(pending.pop())) {
      const path = entry.replace(/\/$/, ''), relative = path.slice(root.length + 1);
      if (relative.split('/').some(part => part.startsWith('.'))) continue;
      if (entry.endsWith('/')) pending.push(path);
      else files.push(relative);
    }
  }
  return files.sort();
}

export function findMain(files, texts) {
  const roots = files.filter(file => /\.(tex|ltx)$/i.test(file) && /\\documentclass/.test(texts[file] || ''));
  return roots.find(file => /(^|\/)main\.tex$/.test(file)) || roots[0] || files.find(file => /\.tex$/i.test(file)) || null;
}

export async function readSettings(store, name) {
  const path = `${projectFolder(name)}/${SETTINGS}`;
  if (!await store.exists(path)) return {};
  try { return JSON.parse(await store.read(path)); } catch (_) { return {}; }
}

export const writeSettings = (store, name, settings) => store.write(`${projectFolder(name)}/${SETTINGS}`, JSON.stringify(settings, null, 2));

// The name a person gives a file: relative, with no hidden parts and no way out of the project.
export function cleanFilePath(path) {
  const clean = path.trim().replace(/^\/+/, '');
  if (!clean || clean.split('/').some(part => part === '..' || part.startsWith('.') || !part)) throw new Error('A file name cannot be empty, start with a dot, or contain "..".');
  return clean;
}
