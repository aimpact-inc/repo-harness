/**
 * The one parse boundary for the text of a file (I1, #3164). `JSON.parse` and
 * `Bun.TOML.parse` can quote text of their input in the error message, such as
 * an unquoted token, so a syntax failure becomes a FileSyntaxError with a fixed
 * message that names the file only. The caller reads the file before it calls
 * this boundary, so a filesystem error keeps its own message.
 *
 * FileSyntaxError stays a SyntaxError: callers that branch on a syntax failure
 * keep their behavior.
 */
export type FileSyntax = 'JSON' | 'TOML';

export class FileSyntaxError extends SyntaxError {
  /** The fixed text without the path, for a message that already names the file. */
  readonly detail: string;

  constructor(readonly path: string | null, readonly syntax: FileSyntax) {
    const detail = `the file is not valid ${syntax}`;
    super(path === null ? detail : `${path}: ${detail}`);
    this.name = 'FileSyntaxError';
    this.detail = detail;
  }
}

export function parseJsonText(text: string, path: string | null): unknown {
  try { return JSON.parse(text) as unknown; } catch { throw new FileSyntaxError(path, 'JSON'); }
}

export function parseTomlText(text: string, path: string | null): Record<string, unknown> {
  try { return Bun.TOML.parse(text) as Record<string, unknown>; } catch { throw new FileSyntaxError(path, 'TOML'); }
}
