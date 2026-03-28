import { formatBytes } from '../../download/progress.js';

type AliPanDownloadUrlPayload = {
  cdn_url?: string;
  download_url?: string;
  internal_url?: string;
  url?: string;
};

function pushUnique(result: string[], seen: Set<string>, candidate?: string): void {
  if (typeof candidate !== 'string') return;
  const normalized = candidate.trim();
  if (!normalized || seen.has(normalized)) return;
  seen.add(normalized);
  result.push(normalized);
}

export function listAliPanDownloadUrls(
  ...payloads: Array<AliPanDownloadUrlPayload | null | undefined>
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  for (const payload of payloads) {
    pushUnique(result, seen, payload?.cdn_url);
    pushUnique(result, seen, payload?.download_url);
    pushUnique(result, seen, payload?.url);
    pushUnique(result, seen, payload?.internal_url);
  }

  return result;
}

export function getAliPanSizeMismatchError(expectedSize: number | undefined, actualSize: number): string | null {
  if (!Number.isFinite(expectedSize) || !expectedSize || expectedSize <= 0) return null;
  if (!Number.isFinite(actualSize) || actualSize <= 0) return `Downloaded file is empty (expected ${formatBytes(expectedSize)}).`;
  if (actualSize === expectedSize) return null;

  return `Size mismatch: expected ${formatBytes(expectedSize)} (${expectedSize} bytes), got ${formatBytes(actualSize)} (${actualSize} bytes).`;
}
