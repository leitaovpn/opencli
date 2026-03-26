import { CommandExecutionError } from '../../errors.js';

export type AliPanShareReference = {
  shareId: string;
  sharePwd: string;
  initialFileId: string;
};

function firstNonEmpty(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

export function parseAliPanShareReference(input: string, sharePwdOverride: string = ''): AliPanShareReference {
  const raw = String(input ?? '').trim();
  if (!raw) throw new CommandExecutionError('Share link or share_id is required');

  if (!raw.includes('://')) {
    return {
      shareId: raw,
      sharePwd: String(sharePwdOverride ?? '').trim(),
      initialFileId: '',
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new CommandExecutionError(`Invalid share link: ${raw}`);
  }

  const segments = parsed.pathname.split('/').filter(Boolean);
  const shareIndex = segments.findIndex(segment => segment === 's');
  const shareId = shareIndex >= 0 ? segments[shareIndex + 1] ?? '' : '';

  if (!shareId) {
    throw new CommandExecutionError(`Could not extract share_id from link: ${raw}`);
  }

  let initialFileId = '';
  const folderIndex = segments.findIndex(segment => segment === 'folder');
  if (folderIndex >= 0) initialFileId = segments[folderIndex + 1] ?? '';
  const fileIndex = segments.findIndex(segment => segment === 'file');
  if (!initialFileId && fileIndex >= 0) initialFileId = segments[fileIndex + 1] ?? '';

  return {
    shareId,
    sharePwd: firstNonEmpty(
      sharePwdOverride,
      parsed.searchParams.get('pwd'),
      parsed.searchParams.get('password'),
      parsed.searchParams.get('share_pwd'),
      parsed.searchParams.get('passcode'),
      parsed.searchParams.get('code'),
    ),
    initialFileId,
  };
}

export function normalizeAliPanSharePath(pathValue: string): string {
  const normalized = String(pathValue ?? '').trim();
  if (!normalized || normalized === '/') return '/';
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}
