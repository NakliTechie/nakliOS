// App-shell layer 4 task battery (docs/specs/app-shell-001.md section 10.9), run by scripts/agent-battery.mjs.
// Each check runs in the app's frame on d = doc.describe (plus cmd(name, input) for more reads) and judges the
// document itself, never the model's summary. Fixtures (/fixtures/voice.wav, /fixtures/clip.mp4) are served by the
// test NakliOS root.

// Shared helpers, prepended to every check.
const H = `
const J = JSON.stringify(d).toLowerCase();
const has = (...w) => w.every(x => J.includes(String(x).toLowerCase()));
const count = (re) => (J.match(re) || []).length;
const ok = (pass, why) => ({ pass: !!pass, why });
`;
const check = (body) => H + body;
// Reckon: the text of every sheet's first 40 rows x 12 columns (range.read), added to J.
const cells = `for (const sh of (d.sheets || [])) { const r = await cmd('range.read', { ref: sh.name + '!A1:L40' }).catch(() => null); if (r) J += ' ' + JSON.stringify(r).toLowerCase(); }`;
const rcheck = (body) => H.replace('const J', 'let J') + cells + body;
// Import a fixture into the open app as a person would drop it in.
const media = (url, name) => `const b = await (await W.fetch(${JSON.stringify(url)})).blob(); await W.__montella.importFiles([new W.File([b], ${JSON.stringify(name)}, { type: b.type })]);`;
const load = (url, name) => `const b = await (await W.fetch(${JSON.stringify(url)})).blob(); await shell.openFile(new W.File([b], ${JSON.stringify(name)}, { type: b.type }));`;

const slides = `const S = d.slides || []; const els = S.flatMap(s => s.elements || []);`;
const shapes = `const P = (d.pages || []).flatMap(p => p.shapes || []); const kinds = P.map(s => String(s.kind || s.type || '').toLowerCase());`;
const blocks = `const B = d.blocks || []; const types = B.map(b => String(b.type || '').toLowerCase());`;
const clips = `const T = d.tracks || []; const C = T.flatMap(t => (t.clips || []).map(c => ({ ...c, track: t.id, tkind: t.kind })));`;

export const TASKS = [
  // ---- Pellucia (slides)
  { id: 'p1', app: 'pellucia', request: 'Make a 5-slide deck about solar power for a school assembly: a title slide, then four content slides, each with a relevant icon.',
    check: check(`${slides} const icons = els.filter(e => e.kind === 'icon').length; return ok(S.length >= 5 && icons >= 3 && has('solar'), S.length + ' slides, ' + icons + ' icons');`) },
  { id: 'p2', app: 'pellucia', request: 'Add a slide comparing petrol cars and electric cars in two columns, with three points each.',
    check: check(`${slides} return ok(S.length >= 2 && has('electric') && has('petrol'), S.length + ' slides; layouts ' + S.map(s => s.layout).join(','));`) },
  { id: 'p3', app: 'pellucia', request: 'Make a 3-slide deck about healthy breakfasts and switch it to a dark theme.',
    check: check(`${slides} return ok(S.length >= 3 && has('breakfast') && d.theme && d.theme !== 'paper', S.length + ' slides, theme ' + d.theme);`) },
  { id: 'p4', app: 'pellucia', request: 'Add a slide with a table listing four planets and their distance from the Sun.',
    check: check(`${slides} const t = els.filter(e => e.kind === 'table').length; return ok(t >= 1 && (has('mars') || has('earth') || has('venus')), t + ' tables');`) },
  { id: 'p5', app: 'pellucia', request: 'Make the title slide say "Quarterly Review" with the subtitle "Q3 2026", and add speaker notes thanking the team.',
    check: check(`return ok(has('quarterly review') && has('q3 2026') && has('thank'), 'title, subtitle and notes text');`) },
  { id: 'p6', app: 'pellucia', request: 'Make a 4-slide pitch for a neighbourhood coffee shop and give every slide a fade transition.',
    check: check(`${slides} const fades = count(/fade/g); return ok(S.length >= 4 && has('coffee') && fades >= 3, S.length + ' slides, ' + fades + ' fade mentions');`) },
  { id: 'p7', app: 'pellucia', request: 'On one new slide, place icons for sun, wind and water side by side with a one-word caption under each.',
    check: check(`${slides} const best = Math.max(0, ...S.map(s => (s.elements || []).filter(e => e.kind === 'icon').length)); return ok(best >= 3 && has('wind'), best + ' icons on the busiest slide');`) },
  { id: 'p8', app: 'pellucia', request: 'Build a 6-slide lesson about the water cycle: evaporation, condensation, precipitation and collection, with a summary slide at the end.',
    check: check(`${slides} return ok(S.length >= 6 && has('evaporation') && has('precipitation'), S.length + ' slides');`) },

  // ---- Reckon (spreadsheet)
  { id: 'r1', app: 'reckon', request: 'Build a monthly household budget: categories Rent, Food, Transport, Utilities and Fun in column A with a header, amounts in column B, and a Total row that uses a SUM formula.',
    check: rcheck(`return ok(has('rent') && has('utilities') && /sum\\(/.test(J), 'budget rows and SUM');`) },
  { id: 'r2', app: 'reckon', request: 'Make a sales table for January to June with made-up numbers for two products, and add a column chart of it.',
    check: rcheck(`return ok((has('jan') && has('jun')) && has('chart'), 'months and chart');`) },
  { id: 'r3', app: 'reckon', request: 'Create a 10 by 10 multiplication table with headers 1 to 10 across the top and down the side.',
    check: rcheck(`return ok(/\\b100\\b/.test(J) && /\\b81\\b/.test(J), '100 and 81 present');`) },
  { id: 'r4', app: 'reckon', request: 'Make column A 220 pixels wide and the header row 32 pixels tall, then put "Name", "Email", "Phone" as bold headers in A1:C1.',
    check: rcheck(`const used = (st.used || []).join(' '); return ok(has('name') && has('email') && /cols\\.width|rows\\.height|script\\.run/.test(used), 'used ' + used);`) },
  { id: 'r5', app: 'reckon', request: 'Enter ten exam scores in column A, then compute their average, minimum and maximum in column C with labels in column B.',
    check: rcheck(`return ok(/average\\(/.test(J) && /min\\(/.test(J) && /max\\(/.test(J), 'AVERAGE, MIN and MAX');`) },
  { id: 'r6', app: 'reckon', request: 'Create a loan table: principal 500000, annual rate 9%, 5 years, and the monthly payment using PMT.',
    check: rcheck(`return ok(/pmt\\(/.test(J) && has('500000'), 'PMT formula');`) },
  { id: 'r7', app: 'reckon', request: 'Make a to-do list with columns Task, Owner, Due and Done for six tasks, and format Due as dates.',
    check: rcheck(`return ok(has('task') && has('owner') && has('due'), 'to-do headers');`) },
  { id: 'r8', app: 'reckon', request: 'Add a second sheet called Summary that shows the total of the numbers on the first sheet.',
    setup: `await cmd('script.run', { steps: [{ command: 'range.write', input: { ref: 'Sheet1!A1', values: [[10], [20], [30], [40]] } }] }).catch(() => {});`,
    check: rcheck(`return ok(has('summary') && /sum\\(/.test(J), 'Summary sheet with SUM');`) },

  // ---- Draft (documents)
  { id: 'd1', app: 'draft', request: 'Write a formal letter to my landlord asking them to fix a leaking kitchen tap: date, greeting, three short paragraphs and a sign-off.',
    check: check(`${blocks} return ok(has('tap') && types.filter(t => t === 'paragraph').length >= 4, B.length + ' blocks');`) },
  { id: 'd2', app: 'draft', request: 'Write a one-page report on renewable energy with a title, three headings and a bulleted list under one of them.',
    check: check(`${blocks} const hs = types.filter(t => t.includes('heading')).length; return ok(hs >= 3 && types.some(t => t.includes('list')), hs + ' headings; types ' + [...new Set(types)].join(','));`) },
  { id: 'd3', app: 'draft', request: 'Draft meeting notes for a project kickoff with a table of action items with columns Owner, Task and Due date.',
    check: check(`${blocks} return ok(types.some(t => t.includes('table')) && has('owner'), 'types ' + [...new Set(types)].join(','));`) },
  { id: 'd4', app: 'draft', request: 'Write a short story of about 300 words about a lost cat finding its way home, with a centered title.',
    check: check(`return ok(has('cat') && (d.words || 0) >= 200 && (has('center') || has('centre')), (d.words || 0) + ' words');`) },
  { id: 'd5', app: 'draft', request: 'Write a pancake recipe with a bulleted ingredients list and numbered steps.',
    check: check(`${blocks} return ok(has('flour') && types.filter(t => t.includes('list')).length >= 2, 'types ' + [...new Set(types)].join(','));`) },
  { id: 'd6', app: 'draft', request: 'Write a cover letter for a junior data analyst job at a retail company.',
    check: check(`return ok(has('data') && has('analyst') && (d.words || 0) >= 150, (d.words || 0) + ' words');`) },
  { id: 'd7', app: 'draft', request: 'Write three sections titled Sleep, Diet and Exercise with a paragraph each, and insert a table of contents at the top.',
    check: check(`${blocks} return ok(has('sleep') && has('exercise') && (has('contents') || types.some(t => t.includes('toc') || t.includes('contents'))), 'types ' + [...new Set(types)].join(','));`) },
  { id: 'd8', app: 'draft', request: 'Write an FAQ for a small library with five questions as headings and an answer paragraph under each.',
    check: check(`${blocks} const hs = types.filter(t => t.includes('heading')).length; return ok(hs >= 5 && has('library'), hs + ' headings');`) },

  // ---- Chartella (whiteboard and diagrams)
  { id: 'c1', app: 'chartella', request: 'Draw a flowchart for making tea: boil water, add tea bag, steep 3 minutes, a decision "milk?", add milk, serve. Connect the steps with arrows.',
    check: check(`${shapes} const arrows = kinds.filter(k => k.includes('arrow') || k.includes('line') || k.includes('connector')).length; return ok(P.length - arrows >= 5 && arrows >= 4 && has('boil'), P.length + ' shapes, ' + arrows + ' arrows');`) },
  { id: 'c2', app: 'chartella', request: 'Make a mind map about planning a holiday with at least five branches.',
    check: check(`${shapes} return ok(P.length >= 6 && has('holiday'), P.length + ' shapes');`) },
  { id: 'c3', app: 'chartella', request: 'Draw an org chart: a CEO, three managers under the CEO, and two staff under each manager, connected by lines.',
    check: check(`${shapes} return ok(P.length >= 10 && has('ceo'), P.length + ' shapes');`) },
  { id: 'c4', app: 'chartella', request: 'Sketch a wireframe for a website home page: header with logo and menu, a hero banner, three feature cards and a footer.',
    check: check(`${shapes} return ok(P.length >= 10 && (has('hero') || has('banner') || has('headline') || has('get started')) && (has('footer') || has('copyright') || has('©')), P.length + ' shapes');`) },
  { id: 'c5', app: 'chartella', request: 'Put four sticky notes in a row as a project timeline: Plan, Build, Test, Launch, with arrows between them.',
    check: check(`${shapes} return ok(has('plan') && has('launch') && P.length >= 7, P.length + ' shapes; kinds ' + [...new Set(kinds)].join(','));`) },
  { id: 'c6', app: 'chartella', request: 'Draw a web architecture diagram: Browser, CDN, API server and Database, connected left to right with arrows.',
    check: check(`${shapes} return ok(has('cdn') && has('database') && P.length >= 7, P.length + ' shapes');`) },
  { id: 'c7', app: 'chartella', request: 'Make a 2 by 2 priority matrix with the quadrants Do first, Schedule, Delegate and Eliminate, and axis labels Urgent and Important.',
    check: check(`${shapes} return ok(has('delegate') && has('eliminate') && has('urgent'), P.length + ' shapes');`) },
  { id: 'c8', app: 'chartella', request: 'Draw a Venn diagram with two overlapping circles for Cats and Dogs and two traits in each part.',
    check: check(`${shapes} const circles = kinds.filter(k => k.includes('ellipse') || k.includes('circle')).length; return ok(circles >= 2 && has('cats') && has('dogs'), circles + ' circles, ' + P.length + ' shapes');`) },

  // ---- Sonella (audio)
  { id: 's1', app: 'sonella', request: 'Generate a 5-second 440 Hz tone, then fade it in over the first second and out over the last second.',
    check: check(`return ok(Math.abs((d.seconds || 0) - 5) < 0.2, (d.seconds || 0) + ' s');`) },
  { id: 's2', app: 'sonella', request: 'Generate a 10-second tone and trim it down to the first 4 seconds.',
    check: check(`return ok(Math.abs((d.seconds || 0) - 4) < 0.2, (d.seconds || 0) + ' s');`) },
  { id: 's3', app: 'sonella', setup: load('/fixtures/voice.wav', 'voice.wav'), request: 'Remove the long silences from this recording.',
    check: check(`return ok((d.seconds || 99) < 7.3, (d.seconds || 0) + ' s (source 7.8 s)');`) },
  { id: 's4', app: 'sonella', setup: load('/fixtures/voice.wav', 'voice.wav'), request: 'Normalize this recording to -1 dB and add a half-second fade out at the end.',
    check: check(`return ok(has('normal') || has('fade') || has('-1'), J.slice(0, 200));`) },
  { id: 's5', app: 'sonella', request: 'Make two tracks: a 3-second 220 Hz tone on one and a 3-second 330 Hz tone on the other.',
    check: check(`const tracks = (d.tracks || []).length; return ok(tracks >= 2, tracks + ' tracks');`) },
  { id: 's6', app: 'sonella', request: 'Make a 2-second beep, then 1 second of silence, then another 2-second beep, all on one track.',
    check: check(`const dur = d.seconds || 0; return ok(dur >= 4.8 && dur <= 5.3, dur + ' s');`) },
  { id: 's7', app: 'sonella', setup: load('/fixtures/voice.wav', 'voice.wav'), request: 'Add a label called "intro" at the start and a label called "outro" at 7 seconds.',
    check: check(`return ok(has('intro') && has('outro'), 'labels');`) },
  { id: 's8', app: 'sonella', request: 'Generate 3 seconds of white noise and reduce its volume by 12 dB.',
    check: check(`return ok(has('noise') || /\\b3(\\.0)?\\b/.test(J), J.slice(0, 200));`) },

  // ---- Montella (video)
  { id: 'm1', app: 'montella', request: 'Make a 10-second intro: a title "My Trip" with a subtitle "Summer 2026".',
    check: check(`${clips} return ok(has('my trip') && has('summer 2026') && (d.duration || 0) >= 8, C.length + ' clips, ' + d.duration + ' s');`) },
  { id: 'm2', app: 'montella', request: 'Add three title cards in a row, 3 seconds each: "Day 1", "Day 2", "Day 3".',
    check: check(`${clips} return ok(has('day 1') && has('day 3') && (d.duration || 0) >= 8, C.length + ' clips, ' + d.duration + ' s');`) },
  { id: 'm3', app: 'montella', request: 'Set the project to vertical 9:16 and add a big centered title "Watch this".',
    check: check(`return ok(has('9:16') && has('watch this'), d.aspect);`) },
  { id: 'm4', app: 'montella', setup: media('/fixtures/clip.mp4', 'clip.mp4'), request: 'Put this clip on the timeline, cut out the part from 4 to 7 seconds, and add a title "Highlights" at the start.',
    check: check(`${clips} const v = C.filter(c => c.tkind === 'video'); return ok(v.length >= 2 && has('highlights') && (d.duration || 99) <= 10, v.length + ' video clips, ' + d.duration + ' s');`) },
  { id: 'm5', app: 'montella', setup: media('/fixtures/clip.mp4', 'clip.mp4'), request: 'Put this clip on the timeline, trim it to the first 6 seconds and add a lower-third with the name "Asha Rao" from 1 to 4 seconds.',
    check: check(`return ok(has('asha rao') && (d.duration || 99) <= 6.5, d.duration + ' s');`) },
  { id: 'm6', app: 'montella', request: 'Make a 5-second countdown from 5 to 1, one number per second.',
    check: check(`${clips} return ok(has('"5"') || (has('5') && has('1') && C.length >= 5), C.length + ' clips');`) },
  { id: 'm7', app: 'montella', setup: media('/fixtures/clip.mp4', 'clip.mp4'), request: 'Put this clip on the timeline and add markers at 2, 5 and 9 seconds.',
    check: check(`return ok((d.markers || []).length >= 3, (d.markers || []).length + ' markers');`) },
  { id: 'm8', app: 'montella', setup: media('/fixtures/clip.mp4', 'clip.mp4'), request: 'Put this clip on the timeline, split it at 6 seconds and move the second half before the first.',
    check: check(`${clips} const v = C.filter(c => c.tkind === 'video'); return ok(v.length >= 2, v.length + ' video clips');`) },

  // ---- Across apps
  { id: 'x1', app: 'pellucia', request: 'Take the monthly sales figures from the open Reckon workbook and add a slide with a chart of them.',
    prep: [{ app: 'reckon', js: `await cmd('script.run', { steps: [{ command: 'range.write', input: { ref: 'Sheet1!A1', values: [['Month', 'Sales'], ['Jan', 120], ['Feb', 150], ['Mar', 170], ['Apr', 210]] } }] })` }],
    check: check(`${slides} const charts = els.filter(e => e.kind === 'chart').length; return ok(charts >= 1 && (has('210') || has('apr')), charts + ' charts');`) },
  { id: 'x2', app: 'draft', request: 'Write a short paragraph summarising the sales figures in the open Reckon workbook, including the best month.',
    prep: [{ app: 'reckon', js: `await cmd('script.run', { steps: [{ command: 'range.write', input: { ref: 'Sheet1!A1', values: [['Month', 'Sales'], ['Jan', 120], ['Feb', 150], ['Mar', 170], ['Apr', 210]] } }] })` }],
    check: check(`return ok(has('apr') && has('210'), 'mentions April and 210');`) },
  { id: 'x3', app: 'reckon', request: 'Put the slide titles of the open Pellucia deck into column A, one per row.',
    prep: [{ app: 'pellucia', js: `await cmd('script.run', { steps: [{ command: 'slide.add', input: { title: 'Alpha plan' } }, { command: 'slide.add', input: { title: 'Beta results' } }, { command: 'slide.add', input: { title: 'Gamma next' } }] })` }],
    check: rcheck(`return ok(has('alpha plan') && has('gamma next'), 'titles copied');`) },
];
