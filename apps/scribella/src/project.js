// Projects are folders under `projects/`. Build output and hidden files stay out of the tree, and `.scribella.json`
// holds the settings a project carries with it.
const ROOT = 'projects';
const SETTINGS = '.scribella.json';
const TEXT = /\.(tex|ltx|bib|sty|cls|bst|bbx|cbx|txt|md|csv|tsv)$/i;

export const isText = path => TEXT.test(path);
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

export async function createProject(store, name, templateId = 'article') {
  const clean = safeName(name), template = TEMPLATES[templateId];
  if (!clean) throw new Error('Give the project a name.');
  if (await store.exists(projectFolder(clean))) throw new Error(`A project called ${clean} already exists.`);
  for (const [path, text] of Object.entries(template.files)) await store.write(`${projectFolder(clean)}/${path}`, text);
  await writeSettings(store, clean, { main:template.main, engine:'pdflatex' });
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
