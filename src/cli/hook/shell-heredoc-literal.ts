const HEREDOC_HEAD = /"\$\(cat <<\s?'([A-Za-z_][A-Za-z0-9_]*)'\n/y;

/**
 * The `"$(cat <<'D' ... D\n)"` span at `at`, or null. The body has no `$`, backtick, `\`, `"` or delimiter line, so the shell
 * prints it as text, and the lexer reads it as one quoted literal word (a commit or PR body written this way stays one argument).
 */
export function heredocLiteral(text: string, at: number): { end: number; body: string } | null {
  HEREDOC_HEAD.lastIndex = at;
  const head = HEREDOC_HEAD.exec(text);
  if (!head) return null;
  const close = `\n${head[1]}\n)"`;
  const start = HEREDOC_HEAD.lastIndex;
  const end = text.indexOf(close, start - 1);
  if (end < 0) return null;
  const body = text.slice(start, end);
  if (/[$`\\"]/.test(body) || body.split('\n').includes(head[1]!)) return null;
  return { end: end + close.length, body };
}
