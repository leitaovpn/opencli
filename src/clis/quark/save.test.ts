import { describe, expect, it } from 'vitest';
import { normalizeQuarkSharePath, parseQuarkShareReference } from './save-shared.js';

describe('parseQuarkShareReference', () => {
  it('parses bare share ids', () => {
    expect(parseQuarkShareReference('abc123')).toEqual({
      shareId: 'abc123',
      sharePwd: '',
      initialFileId: '',
      initialType: '',
    });
  });

  it('parses share url and password from query string', () => {
    expect(parseQuarkShareReference('https://pan.quark.cn/s/abc123?pwd=9x8y')).toEqual({
      shareId: 'abc123',
      sharePwd: '9x8y',
      initialFileId: '',
      initialType: '',
    });
  });

  it('parses nested folder ids from share urls', () => {
    expect(parseQuarkShareReference('https://pan.quark.cn/s/abc123/folder/def456')).toEqual({
      shareId: 'abc123',
      sharePwd: '',
      initialFileId: 'def456',
      initialType: 'folder',
    });
  });

  it('prefers explicit password overrides', () => {
    expect(parseQuarkShareReference('https://pan.quark.cn/s/abc123?pwd=old', 'new')).toEqual({
      shareId: 'abc123',
      sharePwd: 'new',
      initialFileId: '',
      initialType: '',
    });
  });
});

describe('normalizeQuarkSharePath', () => {
  it('normalizes source paths with leading slash', () => {
    expect(normalizeQuarkSharePath('Movies/demo.mp4')).toBe('/Movies/demo.mp4');
    expect(normalizeQuarkSharePath('/Movies/demo.mp4')).toBe('/Movies/demo.mp4');
    expect(normalizeQuarkSharePath('')).toBe('/');
  });
});

