import { CommandExecutionError } from '../../errors.js';

export type QuarkShareReference = {
  shareId: string;
  sharePwd: string;
  initialFileId: string;
  initialType: '' | 'file' | 'folder';
};

function firstNonEmpty(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

export function parseQuarkShareReference(input: string, sharePwdOverride: string = ''): QuarkShareReference {
  const raw = String(input ?? '').trim();
  if (!raw) throw new CommandExecutionError('Share link or pwd_id is required');

  if (!raw.includes('://')) {
    return {
      shareId: raw,
      sharePwd: String(sharePwdOverride ?? '').trim(),
      initialFileId: '',
      initialType: '',
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new CommandExecutionError(`Invalid share link: ${raw}`);
  }

  const segments = parsed.pathname.split('/').filter(Boolean);
  const shareIndex = segments.findIndex(segment => segment === 's' || segment === 'p');
  const shareId = shareIndex >= 0 ? segments[shareIndex + 1] ?? '' : '';
  if (!shareId) {
    throw new CommandExecutionError(`Could not extract pwd_id from share link: ${raw}`);
  }

  let initialFileId = '';
  let initialType: QuarkShareReference['initialType'] = '';
  const folderIndex = segments.findIndex(segment => segment === 'folder');
  if (folderIndex >= 0) {
    initialFileId = segments[folderIndex + 1] ?? '';
    initialType = initialFileId ? 'folder' : '';
  }
  const fileIndex = segments.findIndex(segment => segment === 'file');
  if (!initialFileId && fileIndex >= 0) {
    initialFileId = segments[fileIndex + 1] ?? '';
    initialType = initialFileId ? 'file' : '';
  }

  return {
    shareId,
    sharePwd: firstNonEmpty(
      sharePwdOverride,
      parsed.searchParams.get('pwd'),
      parsed.searchParams.get('passcode'),
      parsed.searchParams.get('password'),
      parsed.searchParams.get('code'),
    ),
    initialFileId,
    initialType,
  };
}

export function normalizeQuarkSharePath(pathValue: string): string {
  const normalized = String(pathValue ?? '').trim();
  if (!normalized || normalized === '/') return '/';
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

