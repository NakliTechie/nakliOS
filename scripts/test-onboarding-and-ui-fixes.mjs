import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// Regression lever for the 2026-08-22 walkthrough: the three quick-win fixes
// (Editor Ask-answer visibility, stray-HTML-in-<style>, Spotlight ArrowUp) and
// the welcome-splash → first-run coach-mark tour swap. Static assertions over
// the shipped source, matching the repo's other scripts/test-*.mjs.

const host = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const editor = readFileSync(new URL('../apps/editor/index.html', import.meta.url), 'utf8');

// ── Syntax gate: every inline host script still parses ──
for (const [i, m] of [...host.matchAll(/<script>([\s\S]*?)<\/script>/g)].entries()) {
  assert.doesNotThrow(() => new Function(m[1]), `inline host script ${i + 1} parses`);
}
const editorScripts = [...editor.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
  .filter((match) => !/\bsrc\s*=/.test(match[1]));
assert.ok(editorScripts.length > 0, 'Editor exposes an inline application script to the syntax gate');
for (const [i, match] of editorScripts.entries()) {
  if (/\btype\s*=\s*["']module["']/.test(match[1])) {
    const parsed = spawnSync(process.execPath, ['--check', '--input-type=module'], {
      input: match[2], encoding: 'utf8',
    });
    assert.equal(parsed.status, 0, `inline Editor module ${i + 1} parses: ${parsed.stderr}`);
  } else {
    assert.doesNotThrow(() => new Function(match[2]), `inline Editor script ${i + 1} parses`);
  }
}

// ── H-3: Spotlight keyboard nav works in both directions ──
assert.match(host, /e\.key === 'ArrowDown'.*active\+\+/, 'Spotlight handles ArrowDown');
assert.match(
  host,
  /e\.key === 'ArrowUp'.*active = Math\.max\(0, active - 1\)/,
  'Spotlight handles ArrowUp (H-3 regression restored)',
);

// ── First-run tour replaces the welcome splash ──
assert.match(host, /const TOUR_KEY = 'nakliOS\.tour\.v1'/, 'tour has its own completion key');
assert.match(host, /const TOUR_STEPS = \[/, 'tour steps are defined');
assert.match(host, /function startTour\(/, 'startTour exists');
assert.match(host, /function finishTour\(/, 'finishTour persists completion');
assert.match(host, /function maybeStartFirstRunTour\(/, 'first-run trigger exists');
assert.match(host, /class="nw-tour-card" role="dialog" aria-modal="true"/, 'tour card is an accessible dialog');
assert.match(host, /id="replay-tour"/, 'Settings exposes a replay control');
assert.match(
  host,
  /#replay-tour'\)\?\.addEventListener\('click'[\s\S]*?startTour\(\{ force:true \}\)/,
  'replay control re-launches the tour',
);
assert.match(host, /maybeStartFirstRunTour\(\);/, 'first-run tour is wired into boot');

// The old welcome modal and its key are fully removed (no dead paths).
assert.doesNotMatch(host, /openWelcome/, 'welcome modal function removed');
assert.doesNotMatch(host, /nw-welcome/, 'welcome modal markup/styles removed');
assert.doesNotMatch(host, /WELCOME_KEY/, 'welcome key removed');

// ── C-1: Editor Ask-answer is revealed via the .open class, not the hidden attr ──
assert.match(editor, /\.ask-answer\.open\{display:block\}/, 'Ask answer reveal rule exists');
assert.match(editor, /out\.classList\.add\('open'\)/, 'projectAsk opens the answer panel');
assert.match(editor, /\$\('ask-answer'\)\.classList\.remove\('open'\)/, 'close/toggle hides the answer panel');
assert.match(editor, /id="ask-answer" role="status" aria-live="polite"/, 'answer panel is a live region');
assert.doesNotMatch(editor, /\$\('ask-answer'\)\.hidden\s*=/, 'answer no longer driven by the hidden attribute');

// ── H-2: no stray HTML wedged inside the editor <style> block ──
const styleBlock = editor.match(/<style>([\s\S]*?)<\/style>/)[1];
assert.ok(!styleBlock.includes('<button'), 'no stray <button> inside editor <style>');
assert.match(styleBlock, /footer\{display:flex/, 'editor footer rule is intact');

console.log('test-onboarding-and-ui-fixes: all assertions passed');
