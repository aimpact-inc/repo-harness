/** The context of one assistant entry: every input token that the model read for it. */
export function entryContext(line: string): number | null {
  let entry: unknown;
  try { entry = JSON.parse(line); } catch { return null; }
  if (typeof entry !== 'object' || entry === null) return null;
  const { type, isSidechain, message } = entry as {
    type?: unknown;
    isSidechain?: unknown;
    message?: { role?: unknown; stopReason?: unknown; usage?: Record<string, unknown> };
  };
  const usage = message?.usage;
  if (typeof usage !== 'object' || usage === null) return null;
  if (type === 'assistant' && isSidechain !== true) {
    const counts = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].map(key => usage[key] ?? 0);
    return counts.every(count => Number.isSafeInteger(count)) ? (counts as number[]).reduce((sum, count) => sum + count, 0) : null;
  }
  if (type === 'message' && message?.role === 'assistant' && message.stopReason !== 'aborted' && message.stopReason !== 'error') {
    const keys = ['input', 'cacheRead', 'cacheWrite'] as const;
    if (!keys.every(key => Number.isSafeInteger(usage[key]))) return null;
    return keys.reduce((sum, key) => sum + (usage[key] as number), 0);
  }
  return null;
}
