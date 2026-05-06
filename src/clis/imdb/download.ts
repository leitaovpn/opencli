/**
 * IMDb download — download poster and still images for a title.
 *
 * Usage:
 *   opencli imdb download tt0133093
 *   opencli imdb download tt0133093 --type stills --output ./matrix-images
 */

import * as path from 'node:path';
import { cli, Strategy } from '../../registry.js';
import { CliError } from '../../errors.js';
import { httpDownload } from '../../download/index.js';
import { DownloadProgressTracker, formatBytes } from '../../download/progress.js';
import { sanitizeFilename } from '../../download/index.js';

/**
 * Strip resize/crop parameters from IMDB image URLs to request the full-size version.
 *
 * Thumbnail:  ...@._V1_UX128_CR0,0,128,176_AL_.jpg
 * Full-size:  ...@._V1_.jpg
 */
function upscaleUrl(url: string): string {
  const m = url.match(/^(.+?[._]V1_)[^.]+(\.[^.]+)$/i);
  return m ? m[1] + m[2] : url;
}

interface SuggestionImage {
  imageUrl: string;
  height?: number;
  width?: number;
}

interface SuggestionItem {
  id: string;
  l: string;
  i?: SuggestionImage | SuggestionImage[];
}

cli({
  site: 'imdb',
  name: 'download',
  description: 'Download poster and still images from IMDb',
  domain: 'www.imdb.com',
  strategy: Strategy.COOKIE,
  args: [
    { name: 'id', positional: true, required: true, help: 'IMDb ID (e.g. tt0133093)' },
    { name: 'output', default: './imdb-images', help: 'Output directory' },
    { name: 'type', default: 'poster', choices: ['poster', 'stills', 'all'], help: 'Image type to download' },
  ],
  columns: ['index', 'type', 'status', 'size'],
  func: async (page, kwargs) => {
    const imdbId = String(kwargs.id);
    const output = String(kwargs.output);
    const imageType = String(kwargs.type);

    // --- Step 1: get poster via the public suggestion API (reliable, no page scrape needed) ---
    let title = '';
    let posterUrl = '';

    const firstLetter = imdbId.charAt(0).toLowerCase();
    const apiUrl = `https://v2.sg.media-imdb.com/suggestion/${firstLetter}/${imdbId}.json`;
    const apiResp = await fetch(apiUrl);
    if (apiResp.ok) {
      const apiData = (await apiResp.json()) as { d?: SuggestionItem[] };
      const item = apiData?.d?.find((d) => d.id === imdbId);
      if (item) {
        title = item.l;
        const img = Array.isArray(item.i) ? item.i[0] : item.i;
        if (img?.imageUrl) {
          posterUrl = upscaleUrl(img.imageUrl);
        }
      }
    }

    // --- Step 2: scrape still images from the mediaindex page ---
    const stillUrls: string[] = [];
    if (imageType === 'stills' || imageType === 'all') {
      await page.goto(`https://www.imdb.com/title/${imdbId}/mediaindex`);
      await page.wait(4);

      const scraped = await page.evaluate(`
        (() => {
          const urls = [];
          // Media index grid images
          document.querySelectorAll('img').forEach((img) => {
            const src = img.src || img.getAttribute('src') || '';
            if (src && src.includes('media-amazon.com/images') && !urls.includes(src)) {
              urls.push(src);
            }
          });
          return urls;
        })()
      `) as string[];

      for (const url of scraped) {
        const upscaled = upscaleUrl(url);
        if (upscaled !== posterUrl) {
          stillUrls.push(upscaled);
        }
      }
    }

    // --- Step 3: build download list ---
    const images: Array<{ type: string; url: string }> = [];

    if (posterUrl && (imageType === 'poster' || imageType === 'all')) {
      images.push({ type: 'poster', url: posterUrl });
    }

    for (const url of stillUrls) {
      images.push({ type: 'still', url });
    }

    if (images.length === 0) {
      throw new CliError('NOT_FOUND', 'No images found', 'Try a different IMDb ID or --type all');
    }

    // --- Step 4: download ---
    const { mkdirSync } = await import('node:fs');
    const safeDir = sanitizeFilename(title || imdbId);
    const outputDir = path.join(output, safeDir);
    mkdirSync(outputDir, { recursive: true });

    const cookies = (await page.getCookies({ domain: 'imdb.com' }))
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');

    const tracker = new DownloadProgressTracker(images.length, true);
    const results: Array<{ index: number; type: string; status: string; size: string }> = [];

    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      const ext = path.extname(new URL(img.url).pathname).split('?')[0] || '.jpg';
      const filename = `${img.type}_${i + 1}${ext}`;
      const destPath = path.join(outputDir, filename);
      const progressBar = tracker.onFileStart(filename, i);

      try {
        const dlResult = await httpDownload(img.url, destPath, {
          cookies,
          headers: { Referer: 'https://www.imdb.com/' },
          timeout: 30000,
          onProgress: (received, total) => progressBar?.update(received, total),
        });

        progressBar?.complete(dlResult.success, dlResult.success ? formatBytes(dlResult.size) : undefined);
        tracker.onFileComplete(dlResult.success);

        results.push({
          index: i + 1,
          type: img.type,
          status: dlResult.success ? 'success' : 'failed',
          size: dlResult.success ? formatBytes(dlResult.size) : (dlResult.error || 'unknown error'),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        progressBar?.fail(msg);
        tracker.onFileComplete(false);
        results.push({ index: i + 1, type: img.type, status: 'failed', size: msg });
      }
    }

    tracker.finish();
    return results;
  },
});
