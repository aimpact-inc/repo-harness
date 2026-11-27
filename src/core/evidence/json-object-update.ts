import { isRecord } from './is-record';

// User-authored JSON files rewrite only the members whose value changes,
// so the user's indentation, key order, numeric spelling (e.g. 0.00), and line endings stay.
// The input already passed JSON.parse, so the scanner assumes valid JSON.
interface JsonMember {
  readonly key: string;
  readonly start: number;
  readonly keyEnd: number;
  readonly valueStart: number;
  readonly valueEnd: number;
}

function skipJsonSpace(text: string, index: number): number {
  while (/\s/.test(text[index] ?? '')) index++;
  return index;
}

function jsonStringEnd(text: string, quote: number): number {
  let index = quote + 1;
  while (text[index] !== '"') index += text[index] === '\\' ? 2 : 1;
  return index + 1;
}

function jsonValueEnd(text: string, start: number): number {
  if (text[start] === '"') return jsonStringEnd(text, start);
  if (text[start] !== '{' && text[start] !== '[') return start + /^[^\s,\]}]*/.exec(text.slice(start))![0].length;
  let depth = 0;
  for (let index = start; ; index++) {
    if (text[index] === '"') index = jsonStringEnd(text, index) - 1;
    else if (text[index] === '{' || text[index] === '[') depth++;
    else if ((text[index] === '}' || text[index] === ']') && --depth === 0) return index + 1;
  }
}

function jsonMembers(text: string, open: number): { readonly members: JsonMember[]; readonly close: number } {
  const members: JsonMember[] = [];
  let index = open + 1;
  for (;;) {
    const start = index;
    const keyStart = skipJsonSpace(text, index);
    if (text[keyStart] === '}') return { members, close: keyStart };
    const keyEnd = jsonStringEnd(text, keyStart);
    const valueStart = skipJsonSpace(text, skipJsonSpace(text, keyEnd) + 1);
    const valueEnd = jsonValueEnd(text, valueStart);
    members.push({ key: JSON.parse(text.slice(keyStart, keyEnd)) as string, start, keyEnd, valueStart, valueEnd });
    index = skipJsonSpace(text, valueEnd);
    if (text[index] === ',') index++;
  }
}

function lineIndent(space: string): string {
  return space.slice(space.lastIndexOf('\n') + 1);
}

function topLevelIndentUnit(text: string): string {
  const first = jsonMembers(text, text.indexOf('{')).members[0];
  return first ? lineIndent(text.slice(first.start, skipJsonSpace(text, first.start))) : '  ';
}

/**
 * Return the object at `open` with the members of `next`. A kept member keeps
 * its bytes; a changed nested object is edited in place; a new member copies
 * the spacing of the last member.
 */
function editJsonObject(text: string, open: number, next: Record<string, unknown>, indent: string, unit: string): string {
  const { members, close } = jsonMembers(text, open);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const last = members.at(-1);
  const space = last ? text.slice(last.start, skipJsonSpace(text, last.start)) : unit ? `${eol}${indent}${unit}` : '';
  const separator = last ? text.slice(last.keyEnd, last.valueStart) : ': ';
  const render = (value: unknown, memberIndent: string): string => JSON.stringify(value, null, unit).replaceAll('\n', `${eol}${memberIndent}`);
  const parts: string[] = [];
  for (const member of members) {
    if (!Object.hasOwn(next, member.key)) continue;
    const value = next[member.key];
    const source = text.slice(member.valueStart, member.valueEnd);
    const memberSpace = text.slice(member.start, skipJsonSpace(text, member.start));
    const rendered = JSON.stringify(JSON.parse(source)) === JSON.stringify(value) ? source
      : text[member.valueStart] === '{' && isRecord(value) ? editJsonObject(text, member.valueStart, value, lineIndent(memberSpace), unit)
      : render(value, lineIndent(memberSpace));
    const afterValue = skipJsonSpace(text, member.valueEnd);
    const beforeComma = text[afterValue] === ',' ? text.slice(member.valueEnd, afterValue) : '';
    parts.push(`${memberSpace}${text.slice(skipJsonSpace(text, member.start), member.valueStart)}${rendered}${beforeComma}`);
  }
  const present = new Set(members.map((member) => member.key));
  for (const [key, value] of Object.entries(next)) {
    if (!present.has(key)) parts.push(`${space}${JSON.stringify(key)}${separator}${render(value, lineIndent(space))}`);
  }
  // An object whose members all left renders as `{}`.
  if (last && parts.length === 0) return '{}';
  const trailing = last ? text.slice(last.valueEnd, close) : parts.length > 0 && unit ? `${eol}${indent}` : text.slice(open + 1, close);
  return `{${parts.join(',')}${trailing}}`;
}

/** The caller has parsed raw as a JSON object. Keep unchanged members' bytes. */
export function renderJsonObjectUpdate(raw: string, next: Record<string, unknown>): string {
  const open = raw.indexOf('{');
  return `${raw.slice(0, open)}${editJsonObject(raw, open, next, '', topLevelIndentUnit(raw))}${raw.slice(jsonValueEnd(raw, open))}`;
}
