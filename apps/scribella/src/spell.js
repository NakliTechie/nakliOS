// Spelling and grammar through Harper, on prose only: LaTeX is blanked out with spaces, so offsets stay true. Its 20 MB
// engine loads from Hugging Face the first time the person turns this on.
import { protectedSpans } from './protected.js';

const ENGINE = 'https://huggingface.co/datasets/naklitechie/naklios-tex/resolve/8c9dd320fe0e8a5ddce588199071da5b09456cb3/harper/3.0.0/harper_wasm_bg.wasm';
let linter = null;

export function maskLatex(text) {
  let out = '', at = 0;
  for (const span of protectedSpans(text)) {
    out += text.slice(at, span.from) + text.slice(span.from, span.to).replace(/[^\n]/g, ' ');
    at = span.to;
  }
  return out + text.slice(at);
}

async function engine() {
  if (!linter) {
    const { LocalLinter, createBinaryModuleFromUrl } = await import('../vendor/harper/index.js');
    linter = new LocalLinter({ binary:createBinaryModuleFromUrl(ENGINE, 'full') });
    await linter.setup();
  }
  return linter;
}

export async function checkSpelling(text) {
  const lints = await (await engine()).lint(maskLatex(text), { language:'plaintext' });
  return lints.map(lint => {
    const { start, end } = lint.span();
    return { from:start, to:end, message:lint.message(), suggestions:lint.suggestions().map(item => item.get_replacement_text()).filter(Boolean).slice(0, 3) };
  });
}
