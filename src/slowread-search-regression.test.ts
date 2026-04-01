import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getRegistry } from './registry.js';
import './clis/slowread/search.js';

const SEARCH_HTML = `
  <section class="results-section">
    <div class="results-container">
      <div class="result-card">
        <img src="https://so.slowread.net/static/img/quark.jpg" alt="quark" class="result-icon">
        <a href="https://pan.quark.cn/s/4ad0e4ddd740" target="_blank" class="result-link" rel="noreferrer"><h3>三体 (2023)</h3></a>
      </div>
      <div class="result-card">
        <img src="https://so.slowread.net/static/img/ali.jpg" alt="ali" class="result-icon">
        <a href="https://www.aliyundrive.com/s/DqxYmcVn5Dy" target="_blank" class="result-link" rel="noreferrer"><h3>三体 剧版</h3></a>
      </div>
    </div>
  </section>
`;

const NO_RESULTS_HTML = `
  <section class="results-section">
    <p class="no-results">没有找到相关结果，请尝试其他近似关键词。</p>
  </section>
`;

describe('slowread/search regression', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('posts form params and maps result cards', async () => {
    const command = getRegistry().get('slowread/search');
    expect(command?.func).toBeTypeOf('function');

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(SEARCH_HTML),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await command!.func!(null as any, {
      query: '三体',
      type: 'quark',
      limit: 1,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://so.slowread.net/search');

    const init = fetchMock.mock.calls[0][1] as any;
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'https://so.slowread.net',
      referer: 'https://so.slowread.net/',
    });
    expect(init.body.get('query')).toBe('三体');
    expect(init.body.get('pan_type')).toBe('quark');

    expect(result).toEqual([
      {
        rank: 1,
        provider: '夸克网盘',
        title: '三体 (2023)',
        url: 'https://pan.quark.cn/s/4ad0e4ddd740',
      },
    ]);
  });

  it('throws a not found error when the page shows no results', async () => {
    const command = getRegistry().get('slowread/search');
    expect(command?.func).toBeTypeOf('function');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(NO_RESULTS_HTML),
    }));

    await expect(command!.func!(null as any, {
      query: 'unlikely-keyword',
      type: 'all',
      limit: 5,
    })).rejects.toThrow('No results found');
  });
});
