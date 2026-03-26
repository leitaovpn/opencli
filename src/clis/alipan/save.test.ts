import { describe, expect, it } from 'vitest';
import { normalizeAliPanSharePath, parseAliPanShareReference } from './save-shared.js';

describe('parseAliPanShareReference', () => {
  it('parses bare share ids', () => {
    expect(parseAliPanShareReference('abc123')).toEqual({
      shareId: 'abc123',
      sharePwd: '',
      initialFileId: '',
    });
  });

  it('parses share url and password from query string', () => {
    expect(parseAliPanShareReference('https://www.alipan.com/s/abc123?pwd=9x8y')).toEqual({
      shareId: 'abc123',
      sharePwd: '9x8y',
      initialFileId: '',
    });
  });

  it('parses nested folder ids from share urls', () => {
    expect(parseAliPanShareReference('https://www.alipan.com/s/abc123/folder/def456')).toEqual({
      shareId: 'abc123',
      sharePwd: '',
      initialFileId: 'def456',
    });
  });

  it('prefers explicit password overrides', () => {
    expect(parseAliPanShareReference('https://www.alipan.com/s/abc123?pwd=old', 'new')).toEqual({
      shareId: 'abc123',
      sharePwd: 'new',
      initialFileId: '',
    });
  });
});

describe('normalizeAliPanSharePath', () => {
  it('normalizes source paths with leading slash', () => {
    expect(normalizeAliPanSharePath('Movies/demo.mp4')).toBe('/Movies/demo.mp4');
    expect(normalizeAliPanSharePath('/Movies/demo.mp4')).toBe('/Movies/demo.mp4');
    expect(normalizeAliPanSharePath('')).toBe('/');
  });
});
