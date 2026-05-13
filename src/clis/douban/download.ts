/**
 * Douban download — download poster and still images for a movie.
 *
 * Usage:
 *   opencli douban download 1292052
 *   opencli douban download 1292052 --type stills --output ./douban-images
 */

import * as path from 'node:path';
import { cli, Strategy } from '../../registry.js';
import { CliError } from '../../errors.js';
import { httpDownload, sanitizeFilename } from '../../download/index.js';
import { DownloadProgressTracker, formatBytes } from '../../download/progress.js';
import { ensureDoubanReady } from './utils.js';

/**
 * Strip resize parameters from Douban image URLs to request the full-size version.
 *
 * Thumbnail:  .../p1234567890.jpg  (or with query params)
 * Full-size:  .../l1234567890.jpg  (replace p -> l or keep public/img)
 */
function upscaleDoubanUrl(url: string): string {
  return url.replace(/\/([psm])(\d+)\.(jpg|webp|png)/, '/raw$2.$3');
}

cli({
  site: 'douban',
  name: 'download',
  description: '下载豆瓣电影海报和剧照',
  domain: 'movie.douban.com',
  strategy: Strategy.COOKIE,
  args: [
    { name: 'id', positional: true, required: true, help: '豆瓣电影ID (e.g. 1292052)' },
    { name: 'output', default: './douban-images', help: '输出目录' },
    { name: 'type', default: 'poster', choices: ['poster', 'stills', 'all'], help: '下载的图片类型' },
  ],
  columns: ['index', 'type', 'status', 'size'],
  func: async (page, kwargs) => {
    const movieId = String(kwargs.id);
    const output = String(kwargs.output);
    const imageType = String(kwargs.type);

    // --- Step 1: get poster and title from the subject page ---
    await page.goto(`https://movie.douban.com/subject/${movieId}/`);
    await page.wait({ time: 3 });
    await ensureDoubanReady(page);

    const pageInfo = await page.evaluate(`
      (() => {
        const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();

        const titleEl = document.querySelector('#content h1 span[property="v:itemreviewed"]');
        const title = normalize(titleEl?.textContent) || normalize(document.querySelector('#content h1')?.textContent?.replace(/\\([^)]*\\)/, ''));

        const posterImg = document.querySelector('#mainpic img');
        const posterUrl = posterImg?.src || posterImg?.getAttribute('src') || '';

        // Also grab any still previews from the related-pics section
        const stillEls = document.querySelectorAll('#related-pic .cover img, .related-pic-bd li img');
        const stillUrls = Array.from(stillEls).map(el => el.src || el.getAttribute('src')).filter(Boolean);

        return { title, posterUrl, stillUrls };
      })()
    `);

    const title = pageInfo.title || movieId;
    let posterUrl = pageInfo.posterUrl || '';
    const stillUrls: string[] = [];

    // Add pre-scraped stills from subject page
    for (const url of pageInfo.stillUrls) {
      const upscaled = upscaleDoubanUrl(url);
      if (upscaled !== posterUrl) {
        stillUrls.push(upscaled);
      }
    }

    // --- Step 2: scrape still images from the photos page ---
    if (imageType === 'stills' || imageType === 'all') {
      let photoStart = 0;
      let hasMore = true;

      while (hasMore && stillUrls.length < 100) {
        const photoUrl = `https://movie.douban.com/subject/${movieId}/photos?type=S&start=${photoStart}&sortby=like`;
        await page.goto(photoUrl);
        await page.wait({ time: 2 });

        const scraped = await page.evaluate(`
          (() => {
            const urls = [];
            document.querySelectorAll('.cover img, .poster-col img, ul.poster li img').forEach((img) => {
              const src = img.src || img.getAttribute('src') || '';
              if (src && src.includes('doubanio.com') && !urls.includes(src)) {
                urls.push(src);
              }
            });
            return urls;
          })()
        `) as string[];

        if (scraped.length === 0) {
          hasMore = false;
        } else {
          for (const url of scraped) {
            const upscaled = upscaleDoubanUrl(url);
            if (upscaled !== posterUrl && !stillUrls.includes(upscaled)) {
              stillUrls.push(upscaled);
            }
          }
          photoStart += scraped.length;
          if (scraped.length < 20) hasMore = false;
        }
      }
    }

    // --- Step 3: build download list ---
    const images: Array<{ type: string; url: string }> = [];

    if (posterUrl && (imageType === 'poster' || imageType === 'all')) {
      images.push({ type: 'poster', url: upscaleDoubanUrl(posterUrl) });
    }

    for (const url of stillUrls) {
      images.push({ type: 'still', url });
    }

    if (images.length === 0) {
      throw new CliError('NOT_FOUND', 'No images found', 'Try a different Douban movie ID or --type all');
    }

    // --- Step 4: download ---
    const { mkdirSync } = await import('node:fs');
    const safeDir = sanitizeFilename(title);
    const outputDir = path.join(output, safeDir);
    mkdirSync(outputDir, { recursive: true });

    const cookies = (await page.getCookies({ domain: 'douban.com' }))
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
          headers: { Referer: `https://movie.douban.com/subject/${movieId}/` },
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
