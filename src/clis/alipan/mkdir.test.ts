import { describe, expect, it } from 'vitest';
import {
  basenameAliPanMkdirPath,
  dirnameAliPanMkdirPath,
  normalizeAliPanMkdirPath,
  splitAliPanMkdirPath,
} from './mkdir-shared.js';

describe('alipan mkdir path helpers', () => {
  it('normalizes folder paths to rooted slash-separated paths', () => {
    expect(normalizeAliPanMkdirPath('Movies/2026')).toBe('/Movies/2026');
    expect(normalizeAliPanMkdirPath('/Movies/2026')).toBe('/Movies/2026');
    expect(normalizeAliPanMkdirPath(' /Movies//2026/ Sci-Fi ')).toBe('/Movies/2026/Sci-Fi');
  });

  it('splits normalized folder paths into clean path segments', () => {
    expect(splitAliPanMkdirPath('/Movies/2026/Sci-Fi')).toEqual(['Movies', '2026', 'Sci-Fi']);
    expect(splitAliPanMkdirPath('')).toEqual([]);
  });

  it('derives parent and basename components for mkdir targets', () => {
    expect(dirnameAliPanMkdirPath('/Movies/2026/Sci-Fi')).toBe('/Movies/2026');
    expect(dirnameAliPanMkdirPath('/Movies')).toBe('/');
    expect(basenameAliPanMkdirPath('/Movies/2026/Sci-Fi')).toBe('Sci-Fi');
    expect(basenameAliPanMkdirPath('/Movies')).toBe('Movies');
  });
});
