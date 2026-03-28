import { describe, expect, it, vi } from 'vitest';
import type { IPage } from '../../types.js';
import { AuthRequiredError } from '../../errors.js';
import { collectQuarkCookieHeader, formatQuarkTimestamp, quarkRequestWithFallback } from './utils.js';

function makePage(overrides: Partial<IPage> = {}): IPage {
  return {
    goto: vi.fn(),
    evaluate: vi.fn(),
    getCookies: vi.fn().mockResolvedValue([]),
    snapshot: vi.fn(),
    click: vi.fn(),
    typeText: vi.fn(),
    pressKey: vi.fn(),
    scrollTo: vi.fn(),
    getFormState: vi.fn(),
    wait: vi.fn(),
    tabs: vi.fn(),
    closeTab: vi.fn(),
    newTab: vi.fn(),
    selectTab: vi.fn(),
    networkRequests: vi.fn(),
    consoleMessages: vi.fn(),
    scroll: vi.fn(),
    autoScroll: vi.fn(),
    installInterceptor: vi.fn(),
    getInterceptedRequests: vi.fn(),
    screenshot: vi.fn(),
    ...overrides,
  } as unknown as IPage;
}

describe('formatQuarkTimestamp', () => {
  it('formats millisecond timestamps as ISO 8601 UTC', () => {
    const ts = new Date('2026-03-25T12:14:23Z').getTime();
    expect(formatQuarkTimestamp(ts)).toBe(new Date(ts).toISOString());
  });

  it('formats second timestamps as ISO 8601 UTC', () => {
    const ts = Math.floor(new Date('2026-03-25T12:14:23Z').getTime() / 1000);
    expect(formatQuarkTimestamp(ts)).toBe(new Date(ts * 1000).toISOString());
  });

  it('normalizes readable datetime strings to ISO 8601 UTC', () => {
    expect(formatQuarkTimestamp('2026-03-28T12:00:00.000Z')).toBe('2026-03-28T12:00:00.000Z');
  });

  it('returns empty string for nullish values', () => {
    expect(formatQuarkTimestamp(null)).toBe('');
    expect(formatQuarkTimestamp(undefined)).toBe('');
    expect(formatQuarkTimestamp('')).toBe('');
  });
});

describe('collectQuarkCookieHeader', () => {
  it('dedupes cookies collected from multiple Quark domains', async () => {
    const page = makePage({
      getCookies: vi.fn()
        .mockResolvedValueOnce([
          { name: 'sid', value: 'root', domain: 'pan.quark.cn', path: '/' },
        ])
        .mockResolvedValueOnce([
          { name: 'sid', value: 'drive', domain: 'pan.quark.cn', path: '/' },
          { name: '__uid', value: '123', domain: 'drive-pc.quark.cn', path: '/' },
        ])
        .mockResolvedValueOnce([
          { name: 'q_session', value: 'abc', domain: '.quark.cn', path: '/' },
        ]),
    });

    await expect(collectQuarkCookieHeader(page)).resolves.toBe('sid=root; __uid=123; q_session=abc');
  });

  it('throws a login-required error when no cookies are available', async () => {
    const page = makePage();
    await expect(collectQuarkCookieHeader(page)).rejects.toBeInstanceOf(AuthRequiredError);
  });
});

describe('quarkRequestWithFallback', () => {
  it('uses in-browser fetch results without reading cookies first', async () => {
    const page = makePage({
      evaluate: vi.fn().mockResolvedValue({
        ok: true,
        data: { list: [{ fid: '123' }] },
        raw: { data: { list: [{ fid: '123' }] } },
        metadata: { trace: 'ok' },
        endpoint: 'https://drive-pc.quark.cn/1/clouddrive/file/sort?pr=ucpro',
        status: 200,
      }),
    });

    const result = await quarkRequestWithFallback(page, [
      {
        url: 'https://drive-pc.quark.cn/1/clouddrive/file/sort',
        method: 'GET',
      },
    ]);

    expect(result).toEqual({
      data: { list: [{ fid: '123' }] },
      raw: { data: { list: [{ fid: '123' }] } },
      metadata: { trace: 'ok' },
      endpoint: 'https://drive-pc.quark.cn/1/clouddrive/file/sort?pr=ucpro',
      status: 200,
    });
    expect(page.evaluate).toHaveBeenCalledTimes(1);
    expect(page.getCookies).not.toHaveBeenCalled();
  });

  it('maps browser auth failures back to AuthRequiredError', async () => {
    const page = makePage({
      evaluate: vi.fn().mockResolvedValue({
        __error: 'AUTH_REQUIRED',
        status: 401,
        message: 'Please login',
        endpoint: 'https://drive-pc.quark.cn/1/clouddrive/file/sort',
      }),
    });

    await expect(quarkRequestWithFallback(page, [
      {
        url: 'https://drive-pc.quark.cn/1/clouddrive/file/sort',
        method: 'GET',
      },
    ])).rejects.toBeInstanceOf(AuthRequiredError);
  });
});
