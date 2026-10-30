// web-tools.mjs — the voice assistant's lookup tools: weather (Open-Meteo), Wikipedia, and a calculator.
// Weather and Wikipedia send only the place name or the topic to a public API, with no key or account; the panel's
// "Web lookups" switch turns both off. Ported from LocalMind's agent tools (MIT), with fetchJson injected so the
// node test runs them on canned replies. The calculator is a small parser, with no eval.

const WMO_WEATHER = { 0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'freezing fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 56: 'light freezing drizzle', 57: 'freezing drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'light freezing rain', 67: 'freezing rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains', 80: 'light rain showers', 81: 'rain showers',
  82: 'violent rain showers', 85: 'light snow showers', 86: 'snow showers', 95: 'thunderstorm',
  96: 'thunderstorm with light hail', 99: 'thunderstorm with heavy hail' };
// Open-Meteo's geocoder knows only current names: "Bombay" finds a village in New York state.
const PLACE_ALIASES = { bombay: 'Mumbai', madras: 'Chennai', calcutta: 'Kolkata', bangalore: 'Bengaluru', poona: 'Pune',
  peking: 'Beijing', canton: 'Guangzhou', saigon: 'Ho Chi Minh City', rangoon: 'Yangon' };

export async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.json();
}

export async function getWeather(args, fetchJsonFn = fetchJson) {
  const raw = String(args?.location ?? '').trim();
  if (!raw) throw new Error('location is required, e.g. "Paris"');
  if (raw.length > 120) throw new Error('location is too long');
  let days = Math.round(Number(args?.days ?? 1));
  days = Number.isFinite(days) ? Math.min(7, Math.max(1, days)) : 1;
  const [head, ...rest] = raw.split(',').map((x) => x.trim()).filter(Boolean);
  const name = PLACE_ALIASES[head.toLowerCase()] || head;
  const qualifier = rest.join(' ').toLowerCase();
  const geo = await fetchJsonFn(`https://geocoding-api.open-meteo.com/v1/search?count=10&language=en&format=json&name=${encodeURIComponent(name)}`);
  let places = Array.isArray(geo?.results) ? geo.results : [];
  if (qualifier) {
    const match = places.filter((p) => [p.country, p.country_code, p.admin1, p.admin2].some((v) => v && (qualifier.includes(String(v).toLowerCase()) || String(v).toLowerCase().includes(qualifier))));
    if (match.length) places = match;
  }
  if (!places.length) throw new Error(`no place called "${raw}" was found`);
  const place = places.reduce((a, b) => ((b.population || 0) > (a.population || 0) ? b : a));
  const f = await fetchJsonFn(`https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}`
    + '&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m'
    + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max'
    + `&timezone=auto&forecast_days=${days}`);
  const c = f?.current || {}, d = f?.daily || {};
  return {
    location: [place.name, place.admin1, place.country].filter(Boolean).join(', '),
    current: { conditions: WMO_WEATHER[c.weather_code] ?? 'unknown', temperature_c: c.temperature_2m, feels_like_c: c.apparent_temperature,
      humidity_pct: c.relative_humidity_2m, wind_kmh: c.wind_speed_10m },
    daily: (d.time || []).map((date, i) => ({ date, conditions: WMO_WEATHER[d.weather_code?.[i]] ?? 'unknown',
      max_c: d.temperature_2m_max?.[i], min_c: d.temperature_2m_min?.[i], rain_chance_pct: d.precipitation_probability_max?.[i] })),
    source: 'Open-Meteo.com (CC BY 4.0)',
  };
}

export async function wikipediaLookup(args, fetchJsonFn = fetchJson) {
  const query = String(args?.query ?? '').trim();
  if (!query) throw new Error('query is required');
  if (query.length > 300) throw new Error('query is too long');
  const j = await fetchJsonFn('https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&origin=*'
    + `&generator=search&gsrlimit=1&gsrsearch=${encodeURIComponent(query)}`
    + '&prop=extracts%7Cinfo&exintro=1&explaintext=1&inprop=url&redirects=1');
  const page = j?.query?.pages?.[0];
  if (!page || page.missing || !page.title) return { found: false, message: `Wikipedia has no article matching "${query}".` };
  // A spoken answer needs the first few sentences, not the whole introduction.
  let summary = String(page.extract || '').replace(/\n+/g, ' ').trim();
  if (summary.length > 700) {
    const cut = summary.slice(0, 700), end = cut.lastIndexOf('. ');
    summary = (end > 200 ? cut.slice(0, end + 1) : cut) + ' …';
  }
  return { found: true, title: page.title, summary, url: page.fullurl, source: 'Wikipedia (CC BY-SA 4.0)' };
}

// Arithmetic with + - * / % ^ and n!, brackets, "x% of y", and a few functions.
function factorial(n) {
  if (!Number.isInteger(n) || n < 0 || n > 170) throw new Error('factorial needs a whole number from 0 to 170');
  let v = 1; for (let i = 2; i <= n; i++) v *= i; return v;
}
const FUNCS = { fact: factorial, factorial, sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil,
  sin: Math.sin, cos: Math.cos, tan: Math.tan, log: Math.log10, ln: Math.log, exp: Math.exp };
const CONSTS = { pi: Math.PI, e: Math.E };
export function calculate(expression) {
  const s = String(expression ?? '').toLowerCase().replace(/[×✕]/g, '*').replace(/÷/g, '/').replace(/(\d),(?=\d{3}\b)/g, '$1')
    .replace(/(\d+(?:\.\d+)?)\s*%\s*of\b/g, '($1/100)*').replace(/(\d+(?:\.\d+)?)\s*%(?!\s*[\d.(])/g, '($1/100)');
  const tokens = s.match(/\d+\.?\d*(?:e[+-]?\d+)?|\.\d+|[a-z]+|[-+*/%^()!]|\S/g) || [];
  let i = 0;
  const peek = () => tokens[i], take = () => tokens[i++];
  const fail = (m) => { throw new Error(m); };
  function primary() {
    const t = take();
    if (t === undefined) fail('the expression ends too early');
    if (t === '(') { const v = sum(); if (take() !== ')') fail('a bracket is not closed'); return v; }
    if (t === '-') return -power();
    if (t === '+') return power();
    if (/^[\d.]/.test(t)) return Number(t);
    if (t in CONSTS) return CONSTS[t];
    if (t in FUNCS) { if (take() !== '(') fail(`${t} needs brackets`); const v = sum(); if (take() !== ')') fail('a bracket is not closed'); return FUNCS[t](v); }
    return fail(`cannot read "${t}"`);
  }
  function postfix() { let v = primary(); while (peek() === '!') { take(); v = factorial(v); } return v; }
  function power() { const b = postfix(); return peek() === '^' ? (take(), b ** power()) : b; }
  function product() {
    let v = power();
    while (['*', '/', '%'].includes(peek())) { const op = take(), r = power(); v = op === '*' ? v * r : op === '/' ? v / r : v % r; }
    return v;
  }
  function sum() {
    let v = product();
    while (['+', '-'].includes(peek())) { const op = take(), r = product(); v = op === '+' ? v + r : v - r; }
    return v;
  }
  if (!tokens.length) fail('empty expression');
  const v = sum();
  if (i < tokens.length) fail(`cannot read "${tokens[i]}"`);
  if (!Number.isFinite(v)) fail('the result is not a finite number');
  return Number(v.toPrecision(12));
}

// webOn() → whether lookups may use the network (the panel's switch).
export function lookupTools({ webOn = () => true, fetchJsonFn = fetchJson } = {}) {
  const web = (fn) => (args) => { if (!webOn()) throw new Error('web lookups are switched off in the assistant panel'); return fn(args, fetchJsonFn); };
  return [
    {
      name: 'get_weather',
      description: 'Get the current weather and a short forecast for a place. Use when the person asks about weather, temperature, rain or wind.',
      parameters: { type: 'object', properties: {
        location: { type: 'string', description: 'City or place name, e.g. "Mumbai" or "Paris, France"' },
        days: { type: 'number', description: 'Days of forecast, 1 to 7 (default 1)', minimum: 1, maximum: 7 },
      }, required: ['location'] },
      run: web(getWeather),
    },
    {
      name: 'wikipedia_lookup',
      description: 'Look up a topic on Wikipedia and return a short summary. Use when the person asks to look something up or wants details about a specific person, place, organisation or event; answer common knowledge directly.',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'Topic to look up, e.g. "Mumbai"' } }, required: ['query'] },
      run: web(wikipediaLookup),
    },
    {
      name: 'calculate',
      description: 'Work out arithmetic, percentages and powers, e.g. "15% of 2400" or "(3 + 4) ^ 2".',
      parameters: { type: 'object', properties: { expression: { type: 'string', description: 'The expression' } }, required: ['expression'] },
      run: ({ expression }) => ({ result: calculate(expression) }),
    },
  ];
}
