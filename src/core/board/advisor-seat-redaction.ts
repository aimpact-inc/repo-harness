import { hasUnredactedSecret, KEY_BEGIN, KEY_END, replaceSecrets } from '../security/secret-patterns';

// A marker walks only its own header, so the search stays linear on a line of any length.
const BEGIN_MARKER = new RegExp(KEY_BEGIN, 'gu');
const END_MARKER = new RegExp(KEY_END, 'gu');

/** The positions of the first and the last marker on one line; -1 when the line has none. */
function markers(line: string, marker: RegExp): { readonly first: number; readonly last: number } {
  let first = -1, last = -1;
  for (const match of line.matchAll(marker)) {
    if (first < 0) first = match.index;
    last = match.index;
  }
  return { first, last };
}

/**
 * One linear pass that marks every line of a private key block: BEGIN through
 * END, BEGIN to the last line when no END follows, and the first line to END
 * when no BEGIN precedes it, because the window or the hc read cut the block.
 * An open block keeps its earliest BEGIN, so a second BEGIN never releases the
 * lines before it.
 */
export function privateKeyLines(lines: readonly string[]): readonly boolean[] {
  const marked = lines.map(() => false);
  const mark = (from: number, to: number) => { for (let at = from; at <= to; at += 1) marked[at] = true; };
  let open: number | null = null;
  lines.forEach((line, at) => {
    const begin = markers(line, BEGIN_MARKER), end = markers(line, END_MARKER);
    if (end.last >= 0) {
      // An END closes the open block; with none open, an END before every BEGIN of its line closes a block that began above the window.
      mark(open ?? (begin.first < 0 || end.first < begin.first ? 0 : at), at);
      open = null;
    }
    // A BEGIN after the last END of its line leaves a block open.
    if (begin.last > end.last) open ??= at;
  });
  if (open !== null) mark(open, lines.length - 1);
  return marked;
}

/** One line outside a key block: the shared token rules, then a secret left over or a line over the limit withholds it. */
export function redactAdvisorLine(line: string, maxChars: number, withheld: string): string {
  if (line.length > maxChars) return withheld;
  const redacted = replaceSecrets(line);
  return redacted.length > maxChars || hasUnredactedSecret(redacted) ? withheld : redacted;
}
