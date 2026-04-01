import { CliError } from '../../errors.js';
import { cli, Strategy } from '../../registry.js';

const BASE_URL = 'https://so.slowread.net';

const PROVIDER_LABELS: Record<string, string> = {
  quark: '夸克网盘',
  ali: '阿里云盘',
  baidu: '百度网盘',
  xunlei: '迅雷云盘',
  uc: 'UC网盘',
  '123pan': '123云盘',
};

function clampLimit(limit: number): number {
  return Math.max(1, Math.min(Number(limit) || 20, 50));
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (_match, entity: string) => {
    if (entity[0] === '#') {
      const isHex = entity[1]?.toLowerCase() === 'x';
      const code = Number.parseInt(entity.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    }

    const named: Record<string, string> = {
      amp: '&',
      apos: '\'',
      gt: '>',
      lt: '<',
      nbsp: ' ',
      quot: '"',
    };

    return named[entity] ?? '';
  });
}

function stripTags(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeProvider(value: string): string {
  const key = value.trim().toLowerCase();
  return PROVIDER_LABELS[key] ?? value.trim();
}

function parseSearchResults(html: string, limit: number): Array<Record<string, string | number>> {
  if (/class="no-results"/.test(html)) return [];

  const results: Array<Record<string, string | number>> = [];
  const resultCardRegex = /<div class="result-card">([\s\S]*?)<\/div>/g;

  let match: RegExpExecArray | null;
  while ((match = resultCardRegex.exec(html)) && results.length < limit) {
    const block = match[1];
    const url = decodeHtmlEntities(block.match(/<a[^>]*href="([^"]+)"/)?.[1] ?? '').trim();
    const title = stripTags(block.match(/<h3>([\s\S]*?)<\/h3>/)?.[1] ?? '');
    const providerKey = decodeHtmlEntities(block.match(/<img[^>]*alt="([^"]+)"/)?.[1] ?? '');

    if (!title || !url) continue;

    results.push({
      rank: results.length + 1,
      provider: normalizeProvider(providerKey),
      title,
      url,
    });
  }

  return results;
}

cli({
  site: 'slowread',
  name: 'search',
  description: 'Search pan resources on 简洁搜索',
  domain: 'so.slowread.net',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: 'query', positional: true, required: true, help: 'Search keyword' },
    { name: 'type', default: 'all', choices: ['all', 'quark', 'ali', 'baidu', 'xunlei', 'uc', '123pan'], help: 'Pan provider filter' },
    { name: 'limit', type: 'int', default: 20, help: 'Max results (1-50)' },
  ],
  columns: ['rank', 'provider', 'title', 'url'],
  func: async (_page, args) => {
    const query = String(args.query ?? '').trim();
    const type = String(args.type ?? 'all').trim().toLowerCase();
    const panType = type === 'all' ? '' : type;
    const limit = clampLimit(args.limit);

    const response = await fetch(`${BASE_URL}/search`, {
      method: 'POST',
      headers: {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'content-type': 'application/x-www-form-urlencoded',
        origin: BASE_URL,
        referer: `${BASE_URL}/`,
        'user-agent': 'Mozilla/5.0 (compatible; opencli/1.0; +https://github.com/jackwener/opencli)',
      },
      body: new URLSearchParams({
        query,
        pan_type: panType,
      }),
    });

    if (!response.ok) {
      throw new CliError(
        'NETWORK_ERROR',
        `Slowread search failed with HTTP ${response.status}`,
        'Try again later',
      );
    }

    const html = await response.text();
    const results = parseSearchResults(html, limit);
    if (results.length === 0) {
      const providerHint = panType ? ` in ${normalizeProvider(panType)}` : '';
      throw new CliError(
        'NOT_FOUND',
        `No results found${providerHint}`,
        'Try a different keyword or provider',
      );
    }

    return results;
  },
});
