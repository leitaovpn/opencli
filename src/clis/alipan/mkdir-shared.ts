export function splitAliPanMkdirPath(pathValue: string): string[] {
  return String(pathValue ?? '')
    .split('/')
    .map(segment => segment.trim())
    .filter(Boolean);
}

export function normalizeAliPanMkdirPath(pathValue: string): string {
  const segments = splitAliPanMkdirPath(pathValue);
  return segments.length === 0 ? '/' : `/${segments.join('/')}`;
}

export function dirnameAliPanMkdirPath(pathValue: string): string {
  const segments = splitAliPanMkdirPath(pathValue);
  if (segments.length <= 1) return '/';
  return `/${segments.slice(0, -1).join('/')}`;
}

export function basenameAliPanMkdirPath(pathValue: string): string {
  const segments = splitAliPanMkdirPath(pathValue);
  return segments[segments.length - 1] ?? '';
}
