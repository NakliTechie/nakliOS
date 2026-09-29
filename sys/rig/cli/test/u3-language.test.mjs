import test from 'node:test';
import assert from 'node:assert/strict';
import { fresh, seed, expect, absent } from './u3-harness.mjs';

// Literal expected bytes authored from the B08 language contract before execution.
const vectors = [
  ['adjacent quotes and quoted empty arguments', String.raw`printf '<%s>\n' a" b"'c' '' ""`, '<a bc>\n<>\n<>\n'],
  ['literal shell operators and escaped spaces', String.raw`printf '<%s>\n' 'x;y|z&k' a\ b \$HOME \*`, '<x;y|z&k>\n<a b>\n<$HOME>\n<*>\n'],
  ['comments and newline separators', 'echo first # ignored ; touch forbidden\necho second', 'first\nsecond\n'],
  ['backslash newline continuation', 'printf \'<%s>\\n\' hel\\\nlo', '<hello>\n'],
  ['hash inside a word stays literal', "printf '%s\\n' a#b '#c'", 'a#b\n#c\n'],
  ['if elif else selects one branch', 'if false; then echo wrong; elif true; then echo selected; else echo wrong2; fi', 'selected\n'],
  ['if follows last condition status', 'if false; true; then echo yes; fi; if true; false; then echo wrong; else echo no; fi', 'yes\nno\n'],
  ['nested branches', 'if true; then if false; then echo wrong; else echo inner; fi; echo outer; fi', 'inner\nouter\n'],
  ['for list keeps quoted fields', 'for x in one "two three" ""; do printf "<%s>\\n" "$x"; done', '<one>\n<two three>\n<>\n'],
  ['while and until progress', 'i=0; while test "$i" -lt 3; do printf "%s" "$i"; i=$((i+1)); done; until test "$i" -eq 5; do printf "%s" "$i"; i=$((i+1)); done', '01234'],
  ['case alternatives and fallback', 'for x in alpha.txt beta.js none; do case "$x" in *.txt|*.md) echo text;; *.js) echo script;; *) echo other;; esac; done', 'text\nscript\nother\n'],
  ['case quoted wildcard is literal', 'case star in "*") echo wrong;; s?ar) echo match;; esac', 'match\n'],
  ['brace group changes current scope', 'x=outer; { x=inner; printf "%s" "$x"; }; printf ":%s" "$x"', 'inner:inner'],
  ['subshell copies variable scope', 'x=outer; (x=inner; printf "%s" "$x"); printf ":%s" "$x"', 'inner:outer'],
  ['functions return explicit status', 'f() { echo body; return 7; echo wrong; }; f; printf "status=%s\\n" "$?"', 'body\nstatus=7\n'],
  ['nested functions restore local variables', 'x=global; inner() { local x=inner; echo "$x:$1"; }; outer() { local x=outer; inner nested; echo "$x:$1"; }; outer argument; echo "$x"', 'inner:nested\nouter:argument\nglobal\n'],
  ['function shift and outer positional restoration', 'inner() { shift; printf "inner:%s:%s\\n" "$#" "$1"; }; outer() { inner x y; printf "outer:%s:%s\\n" "$#" "$1"; }; outer first second', 'inner:1:y\nouter:2:first\n'],
  ['all requested positional spellings', 'f() { printf "%s|%s|%s|%s|%s\\n" "$1" "$9" "${10}" "$#" "$*"; }; f a b c d e f g h i j', 'a|i|j|10|a b c d e f g h i j\n'],
  ['quoted at preserves fields and empty arguments', 'f() { printf "<%s>\\n" "$@"; }; f "one two" "" three', '<one two>\n<>\n<three>\n'],
  ['adjacent quoted at joins the first and final fields', 'f() { printf "<%s>\\n" pre"$@"post; }; f "a b" c', '<prea b>\n<cpost>\n'],
  ['zero positional arguments produce an empty implicit loop', 'f() { for x; do echo wrong; done; printf "%s" "$#"; }; f', '0'],
  ['implicit positional for', 'f() { for x; do printf "[%s]" "$x"; done; }; f "a b" "" c', '[a b][][c]'],
  ['explicit positional for', 'f() { for x in "$@"; do printf "[%s]" "$x"; done; }; f "a b" "" c', '[a b][][c]'],
  ['quoted star uses first IFS character', 'f() { local IFS=:; printf "%s" "$*"; }; f "a b" c', 'a b:c'],
  ['nested break levels', 'for a in 1 2; do for b in x y; do echo "$a$b"; break 2; done; echo wrong; done; echo after', '1x\nafter\n'],
  ['nested continue levels', 'for a in 1 2; do for b in x y; do echo "$a$b"; continue 2; done; echo wrong; done; echo after', '1x\n2x\nafter\n'],
  ['pipeline negation and and-or use actual status', '! false && echo yes; ! true || echo no; false | true && echo last; true | false || echo failed', 'yes\nno\nlast\nfailed\n'],
  ['substitution removes all trailing newlines', String.raw`printf '<%s>\n' "$(printf 'a\nb\n\n')"`, '<a\nb>\n'],
  ['backticks remove trailing newlines', 'printf \'<%s>\\n\' "`printf \'a\\n\\n\'`"', '<a>\n'],
  ['nested command substitution', 'printf "<%s>\\n" "$(printf \'%s\' "$(printf inner)")"', '<inner>\n'],
  ['substitution has copied variables and functions', 'x=outer; f() { printf original; }; printf "%s" "$(x=inner; f() { printf changed; }; f; printf ":%s" "$x")"; printf ":%s:" "$x"; f', 'changed:inner:outer:original'],
  ['unset and null default distinctions', 'empty=; printf "<%s>|<%s>|<%s>|<%s>" "${unset-default}" "${unset:-default}" "${empty-default}" "${empty:-default}"', '<default>|<default>|<>|<default>'],
  ['assignment parameter operators persist', 'empty=; printf "%s|%s|%s|%s" "${a=one}" "${empty=two}" "${empty:=three}" "$a:$empty"', 'one||three|one:three'],
  ['alternative parameter operators distinguish empty', 'empty=; value=yes; printf "%s|%s|%s|%s|%s" "${unset+alt}" "${empty+alt}" "${empty:+alt}" "${value+alt}" "${value:+alt}"', '|alt||alt|alt'],
  ['length and prefix suffix patterns', 'v=abcabc; printf "%s|%s|%s|%s|%s" "${#v}" "${v#a*c}" "${v##a*c}" "${v%a*c}" "${v%%a*c}"', '6|abc||abc|'],
  ['replacement and substring operators', 'v=banana; printf "%s|%s|%s|%s|%s" "${v/a/A}" "${v//a/A}" "${v:1}" "${v:1:3}" "${v: -2}"', 'bAnana|bAnAnA|anana|ana|na'],
  ['unquoted fields split and quoted fields stay', 'v="a b  c"; printf "<%s>\\n" $v "$v"', '<a>\n<b>\n<c>\n<a b  c>\n'],
  ['IFS nonwhite separators preserve interior empty fields', 'IFS=:; v="a::b"; printf "<%s>\\n" $v', '<a>\n<>\n<b>\n'],
  ['empty IFS disables field splitting', 'IFS=; v="a b"; printf "<%s>\\n" $v', '<a b>\n'],
  ['arithmetic precedence and integer division', 'printf "%s|%s|%s|%s" "$((2+3*4))" "$(((2+3)*4))" "$((17/5))" "$((17%5))"', '14|20|3|2'],
  ['arithmetic variable updates and predicate status', 'n=2; ((n+=3)); printf "%s|%s" "$n" "$?"; ((n==9)); printf "|%s" "$?"; ((n==5)) && echo yes', '5|0|1yes\n'],
  ['arithmetic short circuits unused zero divisions', 'printf "%s|%s|%s" "$((0 && 1/0))" "$((1 || 1/0))" "$((1 ? 7 : 1/0))"', '0|1|7'],
];
for (const [name, command, stdout] of vectors) test(name, async () => {
  const ctx = fresh(); await expect(ctx, command, stdout); await absent(ctx, 'forbidden');
});

test('subshell and substitution restore cwd while brace groups retain it', async () => {
  const ctx = fresh(); await seed(ctx, { 'sub/file': 'data' });
  await expect(ctx, '(cd sub; pwd); pwd; printf "%s\\n" "$(cd sub; pwd)"; pwd; { cd sub; }; printf "%s" "$PWD"', '/sub\n/\n/sub\n/\n/sub');
});

test('field splitting precedes globbing and quoted or escaped glob syntax stays literal', async () => {
  const ctx = fresh(); await seed(ctx, { 'a.txt': 'a', 'b.txt': 'b', 'other': 'o' });
  await expect(ctx, String.raw`v='*.txt other'; printf '<%s>\n' $v "$v" \*.txt`, '<a.txt>\n<b.txt>\n<other>\n<*.txt other>\n<*.txt>\n');
});

test('literal heredocs preserve expansions and support leading tab stripping', async () => {
  const ctx = fresh();
  await expect(ctx, "cat <<'EOF'\n$HOME $(touch forbidden)\nEOF", '$HOME $(touch forbidden)\n');
  await expect(ctx, "cat <<-'EOF'\n\tfirst\n\t\tsecond\n\tEOF", 'first\nsecond\n');
  await absent(ctx, 'forbidden');
});

test('redirected while read consumes successive lines and read -r preserves backslashes', async () => {
  const ctx = fresh(); await seed(ctx, { input: 'first\\path\nsecond line\n\nlast\n', fields: 'alpha  beta gamma\n' });
  await expect(ctx, 'while IFS= read -r line; do printf "<%s>\\n" "$line"; done < input', '<first\\path>\n<second line>\n<>\n<last>\n');
  await expect(ctx, 'read -r a b < fields; printf "%s|%s" "$a" "$b"', 'alpha|beta gamma');
});

for (const command of [
  'touch forbidden; if true; then echo missing', 'touch forbidden; for x in a; do echo "$x"',
  'touch forbidden; case x in x) echo x;;', 'touch forbidden; (echo x', 'touch forbidden; { echo x;',
  'touch forbidden; f() { echo x;', 'touch forbidden; echo "unterminated', 'touch forbidden; echo $(echo x',
  'touch forbidden &', 'touch forbidden; echo x & echo y', 'touch forbidden; echo x |',
]) test(`complete parse refuses before effects: ${command}`, async () => {
  const ctx = fresh(); const result = await ctx.run(command); assert.equal(result.code, 2, result.output);
  assert.notEqual(result.stderr, '', 'parse diagnosis is stderr'); await absent(ctx, 'forbidden');
  await expect(ctx, 'echo recovery', 'recovery\n');
});

for (const command of ['echo "$((1/0))"', 'echo "$((1+))"', '((3/0))']) test(`arithmetic refuses malformed work: ${command}`, async () => {
  const ctx = fresh(); const result = await ctx.run(command); assert.equal(result.code, 2, result.output);
  assert.match(String(result.stderr), /arithmetic|division|zero|expression/i); await expect(ctx, 'echo recovery', 'recovery\n');
});

test('parameter errors restore function locals and positionals before later calls', async () => {
  const ctx = fresh();
  await expect(ctx, 'x=global; f() { local x=private; printf "%s" "${missing:?required-value}"; }', '');
  const failure = await ctx.run('f secret'); assert.notEqual(failure.code, 0); assert.match(String(failure.stderr), /required-value/);
  await expect(ctx, 'printf "%s|%s" "$x" "$#"', 'global|0');
  await expect(ctx, 'g() { printf "%s" "$1"; }; g recovery', 'recovery');
});

test('noncolon parameter error accepts an existing empty variable', async () => {
  const ctx = fresh(); await expect(ctx, 'x=; printf "<%s>" "${x?wrong}"', '<>');
  const failure = await ctx.run('printf "%s" "${x:?expected-error}"'); assert.notEqual(failure.code, 0); assert.match(String(failure.stderr), /expected-error/);
});

test('literal runtime argv never becomes shell source through nested wrappers', async () => {
  const ctx = fresh();
  await expect(ctx, String.raw`env timeout 1 printf '%s' 'a; touch forbidden'`, 'a; touch forbidden');
  await expect(ctx, String.raw`printf '%s' 'a; touch forbidden' | xargs -I{} printf '%s' '{}'`, 'a; touch forbidden');
  await absent(ctx, 'forbidden');
});
