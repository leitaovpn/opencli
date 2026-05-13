/**
 * Douban detail — get detailed information about a movie.
 *
 * Usage:
 *   opencli douban detail 1292052
 *   opencli douban detail 1291546
 */

import { cli, Strategy } from '../../registry.js';
import { CliError } from '../../errors.js';
import { ensureDoubanReady } from './utils.js';

interface MovieDetail {
  id: string;
  title: string;
  year: string;
  rating: string;
  runtime: string;
  genres: string;
  plot: string;
  directors: string;
  cast: string;
  region: string;
  releaseDate: string;
}

cli({
  site: 'douban',
  name: 'detail',
  description: '获取豆瓣电影详细信息',
  domain: 'movie.douban.com',
  strategy: Strategy.COOKIE,
  args: [
    { name: 'id', positional: true, required: true, help: '豆瓣电影ID (e.g. 1292052)' },
  ],
  columns: ['field', 'value'],
  func: async (page, kwargs) => {
    const movieId = String(kwargs.id);

    await page.goto(`https://movie.douban.com/subject/${movieId}/`);
    await page.wait({ time: 3 });
    await ensureDoubanReady(page);

    const data = await page.evaluate(`
      (() => {
        const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();

        // --- Title ---
        const titleEl = document.querySelector('#content h1 span[property="v:itemreviewed"]');
        const title = normalize(titleEl?.textContent) || normalize(document.querySelector('#content h1')?.textContent?.replace(/\\([^)]*\\)/, ''));

        // --- Year ---
        const yearEl = document.querySelector('#content h1 .year');
        const year = (yearEl?.textContent?.match(/\\d{4}/) || [''])[0];

        // --- Rating ---
        const ratingEl = document.querySelector('strong.ll.rating_num');
        const rating = normalize(ratingEl?.textContent);

        // --- Runtime ---
        const runtimeEl = document.querySelector('span[property="v:runtime"]');
        const runtime = normalize(runtimeEl?.textContent) || normalize(runtimeEl?.getAttribute('content'));

        // --- Genres ---
        const genreEls = document.querySelectorAll('span[property="v:genre"]');
        const genres = Array.from(genreEls).map(el => normalize(el.textContent)).filter(Boolean).join(', ');

        // --- Directors ---
        const directorEls = document.querySelectorAll('a[rel="v:directedBy"]');
        const directors = Array.from(directorEls).map(el => normalize(el.textContent)).filter(Boolean).join(', ');

        // --- Cast ---
        const castEls = document.querySelectorAll('a[rel="v:starring"]');
        const cast = Array.from(castEls).map(el => normalize(el.textContent)).filter(Boolean).slice(0, 10).join(', ');

        // --- Plot ---
        const summaryEl = document.querySelector('span[property="v:summary"]');
        let plot = normalize(summaryEl?.textContent);
        if (!plot) {
          const introEl = document.querySelector('#link-report .intro');
          plot = normalize(introEl?.textContent);
        }
        if (!plot) {
          const metaDesc = document.querySelector('meta[name="description"]');
          plot = metaDesc?.getAttribute('content') || '';
        }

        // --- Region / Release Date ---
        const infoEl = document.querySelector('#info');
        const infoText = infoEl?.textContent || '';
        const regionMatch = infoText.match(/制片国家\\/地区:[\\s]*([^\\n]+)/);
        const region = regionMatch ? regionMatch[1].trim() : '';

        const releaseEls = document.querySelectorAll('span[property="v:initialReleaseDate"]');
        const releaseDate = Array.from(releaseEls).map(el => normalize(el.textContent) || normalize(el.getAttribute('content'))).filter(Boolean).join(' / ');

        return { title, year, rating, runtime, genres, directors, cast, plot, region, releaseDate };
      })()
    `) as MovieDetail;

    if (!data.title) {
      throw new CliError('NOT_FOUND', 'Could not extract movie details', 'Check the Douban movie ID and try again');
    }

    const fields: Array<{ field: string; value: string }> = [
      { field: 'Douban ID', value: movieId },
      { field: 'Title', value: data.title },
      { field: 'Year', value: data.year || '-' },
      { field: 'Rating', value: data.rating ? `${data.rating}/10` : '-' },
      { field: 'Runtime', value: data.runtime || '-' },
      { field: 'Genres', value: data.genres || '-' },
      { field: 'Region', value: data.region || '-' },
    ];

    if (data.releaseDate) fields.push({ field: 'Release Date', value: data.releaseDate });
    if (data.directors) fields.push({ field: 'Directors', value: data.directors });
    if (data.cast) fields.push({ field: 'Cast', value: data.cast });
    if (data.plot) fields.push({ field: 'Plot', value: data.plot });

    return fields;
  },
});
