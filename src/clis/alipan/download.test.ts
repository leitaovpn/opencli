import { describe, expect, it } from 'vitest';
import { getAliPanSizeMismatchError, listAliPanDownloadUrls } from './download-shared.js';

describe('alipan download helpers', () => {
  it('prioritizes cdn and direct download urls before generic fallbacks', () => {
    expect(listAliPanDownloadUrls(
      {
        url: 'https://fallback.example.com/file.bin',
        internal_url: 'https://internal.example.com/file.bin',
        cdn_url: 'https://cdn.example.com/file.bin',
        download_url: 'https://download.example.com/file.bin',
      },
      {
        cdn_url: 'https://cdn.example.com/file.bin',
        download_url: 'https://detail.example.com/file.bin',
      },
    )).toEqual([
      'https://cdn.example.com/file.bin',
      'https://download.example.com/file.bin',
      'https://fallback.example.com/file.bin',
      'https://internal.example.com/file.bin',
      'https://detail.example.com/file.bin',
    ]);
  });

  it('reports size mismatches with both human and raw byte counts', () => {
    expect(getAliPanSizeMismatchError(1024, 768)).toBe(
      'Size mismatch: expected 1.0 KB (1024 bytes), got 768.0 B (768 bytes).',
    );
  });

  it('ignores missing or matching sizes', () => {
    expect(getAliPanSizeMismatchError(undefined, 768)).toBeNull();
    expect(getAliPanSizeMismatchError(1024, 1024)).toBeNull();
  });
});
