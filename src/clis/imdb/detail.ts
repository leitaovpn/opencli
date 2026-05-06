/**
 * IMDb detail — get detailed information about a title (movie, TV series, episode).
 *
 * Usage:
 *   opencli imdb detail tt1190634
 *   opencli imdb detail tt0133093
 */

import { cli, Strategy } from '../../registry.js';
import { CliError } from '../../errors.js';

interface TitleDetail {
  imdb_id: string;
  title: string;
  year: string;
  type: string;
  rating: string;
  runtime: string;
  genres: string;
  plot: string;
  directors: string;
  cast: string;
}

cli({
  site: 'imdb',
  name: 'detail',
  description: 'Get detailed information about an IMDb title',
  domain: 'www.imdb.com',
  strategy: Strategy.COOKIE,
  args: [
    { name: 'id', positional: true, required: true, help: 'IMDb ID (e.g. tt1190634)' },
  ],
  columns: ['field', 'value'],
  func: async (page, kwargs) => {
    const imdbId = String(kwargs.id);

    await page.goto(`https://www.imdb.com/title/${imdbId}/`);
    await page.wait(4);

    const data = await page.evaluate(`
      (() => {
        var r = {
          title: '', year: '', type: '', rating: '', runtime: '',
          genres: '', plot: '', directors: '', cast: ''
        };

        // --- Title ---
        var h1 = document.querySelector('[data-testid="hero__pageTitle"] h1, h1');
        r.title = h1 ? h1.textContent.trim() : '';

        // --- Year / type from title block ---
        var titleBlock = document.querySelector('[data-testid="hero__pageTitle"]');
        if (titleBlock) titleBlock = titleBlock.parentElement;
        if (titleBlock) {
          titleBlock.querySelectorAll('li').forEach(function(li) {
            var t = li.textContent.trim();
            if (/^\\d{4}/.test(t) && !r.year) r.year = t;
            else if (/TV|Movie|Episode|Series|Mini|Feature|Short|Documentary/i.test(t) && !r.type) r.type = t;
          });
        }
        if (!r.year) {
          var ym = r.title.match(/\\((\\d{4})(?:[–\\-]\\d{0,4})?\\)/);
          if (ym) r.year = ym[1];
        }
        // Fallback: infer type from og:type meta or year range
        if (!r.type) {
          var ogType = document.querySelector('meta[property="og:type"]');
          if (ogType) {
            var ot = (ogType.getAttribute('content') || '').replace('video.', '');
            if (ot === 'movie') r.type = 'Movie';
            else if (ot === 'tv_show') r.type = 'TV Series';
            else if (ot === 'episode') r.type = 'TV Episode';
          }
          if (!r.type && r.year && r.year.indexOf('–') !== -1) r.type = 'TV Series';
          if (!r.type) r.type = 'Movie';
        }

        // --- Rating ---
        var ratingEl = document.querySelector(
          '[data-testid="hero-rating-bar__aggregate-rating__score"] span:first-child'
        );
        if (ratingEl) r.rating = ratingEl.textContent.trim();

        // --- Runtime ---
        var metaLis = document.querySelectorAll(
          '[data-testid="hero__pageTitle"] ~ div li, .ipc-inline-list__item'
        );
        metaLis.forEach(function(el) {
          var t = el.textContent.trim();
          if (/(\\d+h\\s*)?\\d+m(in)?/i.test(t) && !r.runtime) r.runtime = t;
        });

        // --- Genres ---
        var genres = [];
        document.querySelectorAll('.ipc-chip__text').forEach(function(el) {
          var t = el.textContent.trim();
          if (t && genres.indexOf(t) === -1 && t.length < 30 && t !== 'Back to top') {
            genres.push(t);
          }
        });
        r.genres = genres.join(', ');

        // --- Plot ---
        var plotEl = document.querySelector(
          '[data-testid="plot"], [data-testid="plot-xl"]'
        );
        if (plotEl) {
          var raw = plotEl.textContent.trim();
          // Deduplicate repeated text (IMDB nests the plot in multiple spans)
          var len = raw.length;
          if (len > 60 && raw.substring(0, len / 3) === raw.substring(len / 3, len * 2 / 3)) {
            raw = raw.substring(0, len / 3);
          } else if (len > 40 && raw.substring(0, len / 2) === raw.substring(len / 2)) {
            raw = raw.substring(0, len / 2);
          }
          r.plot = raw;
        }
        if (!r.plot) {
          var storyline = document.querySelector('[data-testid="storyline-plot-summary"]');
          if (storyline) r.plot = storyline.textContent.trim();
        }
        if (!r.plot) {
          var metaDesc = document.querySelector('meta[name="description"]');
          if (metaDesc) r.plot = metaDesc.getAttribute('content') || '';
        }

        // --- Directors ---
        var directors = [];
        // Principal credit section: e.g. "Director: Name1, Name2 | Stars: Name3, ..."
        var creditBlock = document.querySelector('[data-testid="title-pc-principal-credit"]');
        if (creditBlock) {
          var creditText = creditBlock.textContent || '';
          // Only take name links that appear before the "Stars:" marker
          var starsIdx = creditText.search(/Stars?:/i);
          creditBlock.querySelectorAll('a[href*="/name/nm"]').forEach(function(a) {
            var name = a.textContent.trim();
            // Estimate position of this name in the text
            var nameIdx = creditText.indexOf(name);
            if (nameIdx !== -1) {
              // Accept only names that appear before the Stars section
              if (starsIdx === -1 || nameIdx < starsIdx) {
                if (name && directors.indexOf(name) === -1) {
                  directors.push(name);
                }
              }
            }
          });
        }
        if (directors.length === 0) {
          document.querySelectorAll('[data-testid="title-pc-principal-credit"] a[href*="/name/nm"]').forEach(function(a) {
            var name = a.textContent.trim();
            if (name && directors.indexOf(name) === -1) directors.push(name);
          });
          if (directors.length > 3) directors.length = 2;
        }
        r.directors = directors.join(', ');

        // --- Cast ---
        var cast = [];
        // Primary: find cast items and extract just the actor name from the child link
        document.querySelectorAll('[data-testid="title-cast-item"]').forEach(function(item) {
          var link = item.querySelector('a[href*="/name/nm"]');
          if (link) {
            var name = link.textContent.trim();
            if (name && name.length < 50 && cast.indexOf(name) === -1) {
              cast.push(name);
            }
          }
        });
        // Fallback: broader search for actor links, excluding directors/creators
        if (cast.length === 0) {
          document.querySelectorAll('a[href*="/name/nm"]').forEach(function(a) {
            var name = a.textContent.trim();
            if (name && name.length > 1 && name.length < 40
                && directors.indexOf(name) === -1
                && cast.indexOf(name) === -1) {
              cast.push(name);
            }
          });
          cast = cast.slice(0, 10);
        }
        r.cast = cast.join(', ');

        return r;
      })()
    `) as TitleDetail;

    if (!data.title) {
      throw new CliError('NOT_FOUND', 'Could not extract title details', 'Check the IMDb ID and try again');
    }

    // Format as key-value rows for vertical display
    const fields: Array<{ field: string; value: string }> = [
      { field: 'IMDb ID', value: imdbId },
      { field: 'Title', value: data.title },
      { field: 'Year', value: data.year || '-' },
      { field: 'Type', value: data.type || '-' },
      { field: 'Rating', value: data.rating ? `${data.rating}/10` : '-' },
      { field: 'Runtime', value: data.runtime || '-' },
      { field: 'Genres', value: data.genres || '-' },
    ];

    if (data.directors) fields.push({ field: 'Directors', value: data.directors });
    if (data.cast) fields.push({ field: 'Cast', value: data.cast });
    if (data.plot) fields.push({ field: 'Plot', value: data.plot });

    return fields;
  },
});
