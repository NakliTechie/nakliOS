import { ArgError } from '../args.mjs';
import { parseCount } from './u2-common.mjs';

const fail = (text) => { throw new ArgError(`date: ${text}`); };
const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const supported = 'aAbBcCdDeFgGhHIjklmMnNpPqrRsStTuUVwWxXyYzZ%';
const pad = (value, width = 2, char = '0') => {
  const text = String(value);
  return char === '0' && text.startsWith('-') ? '-' + text.slice(1).padStart(Math.max(0, width - 1), char) : text.padStart(width, char);
};
function civilUTC(year, month, day) {
  const date = new Date(0); date.setUTCFullYear(year, month, day); date.setUTCHours(0, 0, 0, 0); return date;
}

export function parseDateInput(text, utc) {
  const epoch = /^@([+-]?(?:[0-9]+(?:\.[0-9]{1,3})?|\.[0-9]{1,3}))$/.exec(text);
  if (epoch) {
    const negative = epoch[1].startsWith('-'), unsigned = epoch[1].replace(/^[+-]/, '');
    const [whole, fractional = ''] = unsigned.split('.'), digits = whole.replace(/^0+/, '') || '0';
    if (digits.length > 13) fail('epoch is outside the supported date range');
    const milliseconds = BigInt(digits) * 1000n + BigInt(fractional.padEnd(3, '0'));
    if (milliseconds > 8640000000000000n) fail('epoch is outside the supported date range');
    return new Date(Number(negative ? -milliseconds : milliseconds));
  }
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})(?:[T ]([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]{1,3}))?)?(Z|[+-][0-9]{2}:?[0-9]{2})?)?$/.exec(text);
  if (!match) fail('expected an ISO calendar date/timestamp or @epoch seconds (millisecond precision)');
  const [, y, m, d, h = '0', min = '0', sec = '0', fraction = '', zone] = match;
  const year = Number(y), month = Number(m) - 1, day = Number(d), hour = Number(h), minute = Number(min), second = Number(sec);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 0 || month > 11 || day < 1 || day > days[month] || hour > 23 || minute > 59 || second > 59) fail('invalid calendar date or time');
  const millis = Number(fraction.padEnd(3, '0'));
  let date;
  if (utc || zone) {
    date = civilUTC(year, month, day); date.setUTCHours(hour, minute, second, millis);
  } else {
    date = new Date(0); date.setFullYear(year, month, day); date.setHours(hour, minute, second, millis);
    if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day || date.getHours() !== hour || date.getMinutes() !== minute) fail('local calendar time does not exist');
  }
  if (zone && zone !== 'Z') {
    const digits = zone.slice(1).replace(':', ''), hours = Number(digits.slice(0, 2)), minutes = Number(digits.slice(2));
    if (hours > 23 || minutes > 59) fail('invalid timezone offset');
    date = new Date(date.getTime() - (zone[0] === '-' ? -1 : 1) * (hours * 60 + minutes) * 60000);
  }
  return date;
}

export async function compileDateFormat(ctx, format) {
  const tokens = [], releases = [ctx.budget.reserveRetained(format.length * 4)];
  try {
    let literal = '';
    const token = (value) => { releases.push(ctx.budget.reserveRetained(96)); tokens.push(value); };
    for (let at = 0; at < format.length; at++) {
      await ctx.budget.checkpoint();
      if (format[at] !== '%') { literal += format[at]; continue; }
      if (literal) { token({ literal }); literal = ''; }
      let flags = '', digits = '', colon = false;
      while (at + 1 < format.length && '-_0^#'.includes(format[at + 1])) flags += format[++at];
      while (at + 1 < format.length && /[0-9]/.test(format[at + 1])) digits += format[++at];
      if (format[at + 1] === ':') { colon = true; at++; }
      const specifier = format[++at];
      if (!specifier || !supported.includes(specifier) || colon && specifier !== 'z') fail('unsupported or incomplete format conversion');
      const width = digits ? parseCount(digits, { command: 'date', label: 'format width', min: 1, max: 1024 }) : undefined;
      token({ flags, width, specifier, colon });
    }
    if (literal) token({ literal });
    return { tokens, release: () => { for (const release of releases) release(); } };
  } catch (error) { for (const release of releases) release(); throw error; }
}

export async function writeDate(ctx, date, compiled, utc) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) fail('clock or reference timestamp is unavailable');
  const get = (name) => date[(utc ? 'getUTC' : 'get') + name]();
  const year = get('FullYear'), month = get('Month'), day = get('Date'), hour = get('Hours'), minute = get('Minutes'), second = get('Seconds'), millis = get('Milliseconds'), weekday = get('Day');
  // Calendar arithmetic stays valid when January falls outside Date's epoch range.
  const leap = (value) => value % 4 === 0 && (value % 100 !== 0 || value % 400 === 0);
  const modulo = (value, divisor) => (value % divisor + divisor) % divisor;
  const ordinal = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334][month]
    + day + (month > 1 && leap(year) ? 1 : 0);
  const januaryWeekday = modulo(weekday - ordinal + 1, 7);
  const weeks = (value, firstDay) => firstDay === 4 || firstDay === 3 && leap(value) ? 53 : 52;
  let isoYear = year, isoWeek = Math.floor((ordinal - (weekday || 7) + 10) / 7);
  if (isoWeek < 1) {
    isoYear--;
    isoWeek = weeks(isoYear, modulo(januaryWeekday - (leap(isoYear) ? 366 : 365), 7));
  } else if (isoWeek > weeks(year, januaryWeekday)) { isoYear++; isoWeek = 1; }
  // Match GNU's century rollover convention, including its BCE %g behavior.
  const shortIso = ((year - 1900) % 100 + isoYear - year) % 100;
  const isoDigits = shortIso >= 0 ? shortIso : isoYear < 0 ? -shortIso : shortIso + 100;
  const offset = utc ? 0 : -date.getTimezoneOffset(), absolute = Math.abs(offset);
  const zoneDigits = (offset < 0 ? '-' : '+') + pad(Math.floor(absolute / 60)) + pad(absolute % 60);
  const zoneName = utc ? 'UTC' : new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(date).find((part) => part.type === 'timeZoneName')?.value ?? 'unknown';
  const calendar = `${year > 9999 ? '+' : ''}${pad(year, 4)}-${pad(month + 1)}-${pad(day)}`, time = `${pad(hour)}:${pad(minute)}:${pad(second)}`;
  const twelve = hour % 12 || 12, ampm = hour < 12 ? 'AM' : 'PM';
  const value = {
    a: weekdays[weekday].slice(0, 3), A: weekdays[weekday], b: months[month].slice(0, 3), B: months[month], h: months[month].slice(0, 3),
    c: `${weekdays[weekday].slice(0, 3)} ${months[month].slice(0, 3)} ${pad(day, 2, ' ')} ${time} ${year}`,
    C: Math.trunc(year / 100), d: day, D: `${pad(month + 1)}/${pad(day)}/${pad(Math.abs(year % 100))}`, e: day,
    F: calendar, g: isoDigits, G: isoYear, H: hour, I: twelve, j: ordinal, k: hour, l: twelve,
    m: month + 1, M: minute, n: '\n', N: pad(millis, 3) + '000000', p: ampm, P: ampm.toLowerCase(), q: Math.floor(month / 3) + 1,
    r: `${pad(twelve)}:${pad(minute)}:${pad(second)} ${ampm}`, R: `${pad(hour)}:${pad(minute)}`, s: Math.floor(+date / 1000),
    S: second, t: '\t', T: time, u: weekday || 7, U: Math.floor((ordinal - 1 + 7 - weekday) / 7), V: isoWeek,
    w: weekday, W: Math.floor((ordinal - 1 + 7 - (weekday + 6) % 7) / 7), x: `${pad(month + 1)}/${pad(day)}/${pad(Math.abs(year % 100))}`,
    X: time, y: Math.abs(year % 100), Y: year, z: zoneDigits, Z: zoneName, '%': '%',
  };
  for (const token of compiled.tokens) {
    await ctx.budget.checkpoint();
    if (token.literal !== undefined) { ctx.output.argument(token.literal); continue; }
    const { specifier: key, width, flags, colon } = token;
    let text = key === 'C' && Object.is(value[key], -0) ? '-0' : String(value[key]);
    if (colon) text = text.slice(0, 3) + ':' + text.slice(3);
    let padding = 'ekl'.includes(key) ? ' ' : '0', disabled = false;
    for (const flag of flags) {
      if (flag === '-') disabled = true;
      if (flag === '_' || flag === '0') { disabled = false; padding = flag === '_' ? ' ' : '0'; }
    }
    const normalWidth = 'GY'.includes(key) ? 4 : key === 'j' ? 3 : 'CdegHIk lmMSUVW y'.replaceAll(' ', '').includes(key) ? 2 : 0;
    if (key === 'N') {
      const precision = width ?? (disabled ? 3 : 9);
      text = text.slice(0, Math.min(9, precision));
      if (disabled && width !== undefined || padding === ' ') text = text.replace(/0+$/, '') || '0';
      if (!disabled) text = text.padEnd(precision, padding);
    } else if (key === 'z') {
      const sign = offset < 0 ? '-' : '+', hours = Math.floor(absolute / 60), minutes = absolute % 60;
      const digits = colon ? String(hours) + ':' + pad(minutes) : String(hours * 100 + minutes);
      const target = width ?? (colon ? 6 : 5);
      text = disabled ? sign + digits : padding === ' ' ? (sign + digits).padStart(target, ' ')
        : sign + digits.padStart(Math.max(0, target - 1), '0');
    }
    else if (!disabled) text = pad(text, width ?? normalWidth, typeof value[key] === 'number' || key === 'F' ? padding : flags.includes('0') ? '0' : ' ');
    if (key !== 'P' && flags.includes('^')) text = text.toUpperCase();
    if (key !== 'P' && flags.includes('#')) text = text === text.toUpperCase() ? text.toLowerCase() : text.toUpperCase();
    ctx.output.argument(text);
  }
  ctx.output.byte(10);
}
