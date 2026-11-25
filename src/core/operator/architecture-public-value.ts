import { SECRET_TOKEN_PATTERNS, containsSecret } from '../security/secret-patterns';

const PRIVATE_PATH = /(?<![A-Za-z0-9])(?:\/(?:Users|home|private|tmp|Volumes|var)\/|[A-Za-z]:[\\/])[^\s"'<>]+/g;

// Redact public text before the whitelist decoder. Never change a prompt digest.
export function publicValue(value: unknown, root: string): unknown {
  if (typeof value === 'string') {
    let text = value.replaceAll(root, '[redacted]').replace(new RegExp(PRIVATE_PATH.source, PRIVATE_PATH.flags), '[redacted]');
    for (const { pattern } of SECRET_TOKEN_PATTERNS) text = text.replace(new RegExp(pattern.source, pattern.flags), '[redacted]');
    return containsSecret(text) ? '[redacted]' : text;
  }
  if (Array.isArray(value)) return value.map(item => publicValue(item, root));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, publicValue(item, root)]));
  return value;
}
