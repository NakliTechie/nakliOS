// Checks a paper for what would reveal its authors before a double-blind submission: source first, then the PDF's own
// metadata and link targets. Rules from Lattice, see NOTICE; link checks are added here.
import { blankComments } from './lint.js';

const ACCOUNT = /https?:\/\/(?:www\.)?(?:github\.com|gitlab\.com|huggingface\.co|bitbucket\.org)\/[\w.-]+|https?:\/\/[^\s}]*\/~[\w.-]+/i;
const SELF = /\b(?:our|my)\s+(?:previous|prior|earlier|recent)\s+(?:work|paper|study|study|article)\b|\bin\s+our\s+\d{4}\s+paper\b/i;

export function checkSource(texts) {
  const found = [];
  for (const [file, source] of Object.entries(texts)) {
    if (!/\.(tex|ltx)$/i.test(file)) continue;
    const text = blankComments(source);
    for (const match of text.matchAll(/\\author(?:\[[^\]]*\])?\s*\{/g)) {
      let depth = 1, end = match.index + match[0].length;
      for (; end < text.length && depth; end += 1) depth += text[end] === '{' ? 1 : text[end] === '}' ? -1 : 0;
      const names = text.slice(match.index + match[0].length, end - 1);
      if (names.trim() && !/anonymous|names? withheld/i.test(names)) found.push({ file, line:text.slice(0, match.index).split('\n').length, message:'\\author names someone. Double-blind papers keep this anonymous.' });
    }
    text.split('\n').forEach((line, index) => {
      const add = message => found.push({ file, line:index + 1, message });
      if (/\\usepackage\[[^\]]*\b(final|preprint)\b[^\]]*\]\{(neurips|nips|icml|iclr)/i.test(line) || /\\documentclass\[[^\]]*\baccepted\b/.test(line)) add('The template option shows author names.');
      if (/\\(?:section|paragraph)\*?\{Acknowledge?ments?\}|\\begin\{ack\}|\\acknowledgments?\b/i.test(line)) add('Acknowledgements can identify you. Most double-blind venues want them out.');
      if (/\\thanks\{/.test(line)) add('\\thanks can identify you.');
      if (ACCOUNT.test(line)) add('This link points to an account page.');
      if (/\\(?:affiliation|institute|affil)\b/.test(line)) add('An affiliation can identify you.');
      if (/[\w.+-]+@[\w-]+\.[\w.-]+/.test(line)) add('An email address can identify you.');
      if (SELF.test(line)) add('This phrase reveals that the cited work is yours.');
    });
  }
  return found;
}

// `facts` comes from the PDF view: { author, creator, links:[{ page, url }], fonts:[{ page, name, type3, embedded }] }.
export function checkPdf(facts) {
  const found = [];
  if (facts.author) found.push({ message:`The PDF metadata names an author: ${facts.author}.` });
  for (const { page, url } of facts.links) if (ACCOUNT.test(url)) found.push({ page, message:`A link goes to an account page: ${url}` });
  for (const font of facts.fonts) {
    if (font.type3) found.push({ page:font.page, message:`Type 3 font ${font.name}. Many venues refuse these.` });
    else if (!font.embedded) found.push({ page:font.page, message:`Font ${font.name} is not embedded.` });
  }
  return found;
}
