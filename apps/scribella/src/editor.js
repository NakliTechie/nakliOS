// The source editor: CodeMirror with LaTeX highlighting, the linter and project-aware completion.
import { EditorView, EditorState, StreamLanguage, autocompletion, basicSetup, indentWithTab, keymap, lintGutter, linter, stex } from '../vendor/codemirror.mjs';
import { lintSource } from './lint.js';

const COMMANDS = ['section', 'subsection', 'subsubsection', 'paragraph', 'label', 'ref', 'eqref', 'cite', 'citep', 'citet', 'caption', 'centering', 'includegraphics', 'usepackage', 'textbf', 'textit', 'emph', 'texttt', 'footnote', 'item', 'input', 'include', 'bibliography', 'bibliographystyle', 'newcommand', 'renewcommand', 'frac', 'sqrt', 'sum', 'int', 'mathbb', 'mathbf', 'mathcal', 'mathrm', 'left', 'right', 'url', 'href', 'maketitle', 'tableofcontents', 'appendix'];
const ENVIRONMENTS = ['figure', 'table', 'tabular', 'equation', 'align', 'itemize', 'enumerate', 'abstract', 'center', 'theorem', 'proof', 'document'];

// `project()` answers { labels, bibKeys, hasBib, files, macros }.
function completions(project) {
  return context => {
    const before = context.state.sliceDoc(Math.max(0, context.pos - 200), context.pos);
    const argument = /\\(ref|eqref|autoref|cref|[A-Za-z]*cite[a-zA-Z]*|input|include|includegraphics|begin|end)\*?(?:\[[^\]]*\])*\{(?:[^{}]*,\s*)?([^{},]*)$/.exec(before);
    const info = project();
    if (argument) {
      const [, command, typed] = argument;
      const pick = /cite/.test(command) ? [...info.bibKeys]
        : /ref$/.test(command) ? [...info.labels]
          : /^(begin|end)$/.test(command) ? ENVIRONMENTS
            : [...info.files].filter(file => (command === 'includegraphics' ? /\.(png|jpe?g|pdf|eps)$/i : /\.tex$/i).test(file)).map(file => (command === 'includegraphics' ? file : file.replace(/\.tex$/i, '')));
      return { from:context.pos - typed.length, options:pick.map(label => ({ label })), validFor:/^[^{},]*$/ };
    }
    const word = /\\([A-Za-z@]*)$/.exec(before);
    if (!word) return null;
    return {
      from:context.pos - word[1].length,
      options:[...new Set([...COMMANDS, ...info.macros])].map(label => ({ label, type:'keyword' })),
      validFor:/^[A-Za-z@]*$/,
    };
  };
}

export function createEditor(parent, { onChange, onSave, project, path }) {
  let quiet = false;
  const view = new EditorView({
    parent,
    state:EditorState.create({
      doc:'',
      extensions:[
        basicSetup,
        StreamLanguage.define(stex),
        EditorView.lineWrapping,
        keymap.of([indentWithTab, { key:'Mod-s', preventDefault:true, run:() => { onSave(); return true; } }]),
        lintGutter(),
        linter(current => (/\.(tex|ltx)$/i.test(path()) ? lintSource(current.state.doc.toString(), project(), path()) : []), { delay:400 }),
        autocompletion({ override:[completions(project)] }),
        EditorView.updateListener.of(update => { if (update.docChanged && !quiet) onChange(); }),
      ],
    }),
  });
  return {
    view,
    get text() { return view.state.doc.toString(); },
    load(text) {
      quiet = true;
      view.dispatch({ changes:{ from:0, to:view.state.doc.length, insert:text }, selection:{ anchor:0 } });
      quiet = false;
    },
    goToLine(line, token) {
      const target = view.state.doc.line(Math.min(Math.max(line, 1), view.state.doc.lines));
      const at = token ? target.text.indexOf(token) : -1;
      const anchor = target.from + Math.max(at, 0);
      view.dispatch({ selection:{ anchor, head:at >= 0 ? anchor + token.length : anchor }, effects:EditorView.scrollIntoView(anchor, { y:'center' }) });
      view.focus();
    },
    // Replaces `token` on one line. Answers false when the line no longer holds it.
    replaceOnLine(line, token, replacement) {
      const target = view.state.doc.line(Math.min(Math.max(line, 1), view.state.doc.lines));
      const at = target.text.indexOf(token);
      if (at < 0) return false;
      view.dispatch({ changes:{ from:target.from + at, to:target.from + at + token.length, insert:replacement } });
      return true;
    },
  };
}
