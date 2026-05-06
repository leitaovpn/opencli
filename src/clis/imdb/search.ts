/**
 * IMDb search — query movies, TV shows, and celebrities via the public suggestion API.
 *
 * Usage:
 *   opencli imdb search "The Matrix"
 *   opencli imdb search "Christopher Nolan" --limit 5
 */

import { cli, Strategy } from '../../registry.js';
import { CliError } from '../../errors.js';

interface ImdbSuggestion {
  id: string;
  l: string;
  y?: number;
  q?: string;
  s?: string;
  rank?: number;
}

const TYPE_LABELS: Record<string, string> = {
  'feature': 'Movie',
  'tv_series': 'TV Series',
  'tv_episode': 'TV Episode',
  'tv_mini_series': 'Mini Series',
  'tv_movie': 'TV Movie',
  'tv_short': 'TV Short',
  'short': 'Short',
  'video_game': 'Video Game',
  'actor': 'Actor',
  'actress': 'Actress',
  'name': 'Person',
};

cli({
  site: 'imdb',
  name: 'search',
  description: 'Search IMDb for movies, TV shows, and celebrities',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: 'query', positional: true, required: true, help: 'Search keyword (e.g. "The Matrix")' },
    { name: 'limit', type: 'int', default: 10, help: 'Max results (1-50)' },
  ],
  columns: ['imdb_id', 'title', 'year', 'type', 'stars'],
  func: async (_page, args) => {
    const limit = Math.max(1, Math.min(Number(args.limit), 50));
    const query = String(args.query).trim();
    const firstChar = query.charAt(0).toLowerCase();
    // IMDB routes by first ASCII letter; use '0' for non-ASCII (CJK, emoji, etc.)
    const prefix = /^[a-z]$/.test(firstChar) ? firstChar : '0';
    const url = `https://v2.sg.media-imdb.com/suggestion/${prefix}/${encodeURIComponent(query)}.json`;

    const resp = await fetch(url);
    if (!resp.ok) {
      throw new CliError('API_ERROR', `IMDb API returned HTTP ${resp.status}`);
    }
    const data = (await resp.json()) as { d?: ImdbSuggestion[] };
    const results = data?.d;
    if (!results?.length) {
      throw new CliError('NOT_FOUND', 'No results found', 'Try a different keyword');
    }

    return results.slice(0, limit).map((r) => ({
      imdb_id: r.id,
      title: r.l,
      year: r.y || '-',
      type: TYPE_LABELS[r.q || ''] || r.q || '-',
      stars: r.s || '',
    }));
  },
});
