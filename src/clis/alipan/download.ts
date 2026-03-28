import * as fs from 'node:fs';
import * as path from 'node:path';
import { formatCookieHeader, httpDownload, sanitizeFilename, ytdlpDownload } from '../../download/index.js';
import { createProgressBar, formatBytes } from '../../download/progress.js';
import { CommandExecutionError } from '../../errors.js';
import { cli, Strategy } from '../../registry.js';
import { getAliPanSizeMismatchError, listAliPanDownloadUrls } from './download-shared.js';
import { alipanPostWithFallback, alipanResolvePath } from './utils.js';

type AliPanFileDetail = {
  category?: string;
  download_url?: string;
  file_id?: string;
  name?: string;
  type?: string;
  url?: string;
  size?: number;
};

type AliPanDownloadUrlResponse = {
  cdn_url?: string;
  download_url?: string;
  file_id?: string;
  url?: string;
  internal_url?: string;
  expiration?: string;
  method?: string;
  size?: number;
};

type AliPanVideoPreviewTask = {
  status?: string;
  template_height?: number;
  template_id?: string;
  url?: string;
};

type AliPanVideoPreviewResponse = {
  video_preview_play_info?: {
    live_transcoding_task_list?: AliPanVideoPreviewTask[];
  };
};

function listVideoPreviewUrls(payload: AliPanVideoPreviewResponse | null | undefined): string[] {
  const taskList = payload?.video_preview_play_info?.live_transcoding_task_list;
  const tasks = Array.isArray(taskList) ? taskList : [];
  const sorted = [...tasks].sort((a, b) => (b.template_height ?? 0) - (a.template_height ?? 0));
  const unique = new Set<string>();
  for (const task of sorted) {
    if (task?.status && task.status !== 'finished') continue;
    const url = task?.url;
    if (typeof url === 'string' && url.trim()) unique.add(url.trim());
  }
  return [...unique];
}

function maskUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '(invalid-url)';
  }
}

function removeDownloadArtifacts(savePath: string): void {
  try {
    if (fs.existsSync(savePath)) fs.unlinkSync(savePath);
  } catch {
    // Best-effort cleanup after failed/incomplete downloads.
  }

  const dir = path.dirname(savePath);
  const baseName = path.basename(savePath, path.extname(savePath));
  try {
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.startsWith(baseName)) continue;
      const target = path.join(dir, entry);
      try {
        if (fs.statSync(target).isFile()) fs.unlinkSync(target);
      } catch {
        // Ignore cleanup races and continue.
      }
    }
  } catch {
    // Ignore missing directories or transient fs errors.
  }
}

cli({
  site: 'alipan',
  name: 'download',
  description: 'Download a file from AliPan to local disk',
  domain: 'www.alipan.com',
  strategy: Strategy.HEADER,
  browser: true,
  navigateBefore: false,
  args: [
    { name: 'file-id', required: false, positional: true, help: 'Target file_id to download' },
    { name: 'path', default: '', help: 'Path to target file (alternative to file-id)' },
    { name: 'output', default: './alipan-downloads', help: 'Output directory' },
    { name: 'name', default: '', help: 'Override local filename' },
    { name: 'overwrite', type: 'boolean', default: false, help: 'Overwrite existing file if present' },
    { name: 'timeout', type: 'int', default: 120000, help: 'Download timeout in milliseconds' },
    { name: 'show-progress', type: 'boolean', default: true, help: 'Show realtime download progress in terminal' },
  ],
  columns: ['status', 'file_id', 'path', 'name', 'size', 'saved_to', 'endpoint'],
  func: async (page, kwargs) => {
    if (!page) throw new CommandExecutionError('Browser page required for alipan download');

    const fileIdArg = String(kwargs['file-id'] ?? '').trim();
    const pathArg = String(kwargs.path ?? '').trim();
    const outputDir = String(kwargs.output ?? './alipan-downloads').trim() || './alipan-downloads';
    const nameArg = String(kwargs.name ?? '').trim();
    const overwrite = Boolean(kwargs.overwrite);
    const timeoutRaw = Number(kwargs.timeout ?? 120000);
    const timeout = Math.max(1000, Number.isFinite(timeoutRaw) ? timeoutRaw : 120000);
    const showProgress = Boolean(kwargs['show-progress']) && process.stderr.isTTY !== false;

    if (!fileIdArg && !pathArg) {
      throw new CommandExecutionError('Provide file-id positional argument or --path');
    }

    await page.goto('https://www.alipan.com/drive/home');
    await page.wait(1);

    const resolved = fileIdArg
      ? null
      : await alipanResolvePath(page, pathArg, 'file');
    const fileId = fileIdArg || resolved!.file_id;

    const detailResult = await alipanPostWithFallback<AliPanFileDetail>(page, [
      {
        url: 'https://api.aliyundrive.com/v2/file/get',
        body: { file_id: fileId },
      },
      {
        url: 'https://api.aliyundrive.com/v3/file/get',
        body: { file_id: fileId },
      },
    ]);
    const detail = detailResult.data || {};
    if (detail.type && detail.type !== 'file') {
      throw new CommandExecutionError(`Target is not a file (type=${detail.type}). Folder download is not supported yet.`);
    }

    const sourceName = nameArg || String(detail.name ?? resolved?.name ?? '').trim() || `${fileId}.bin`;
    const safeName = sanitizeFilename(sourceName) || `alipan_${fileId}.bin`;
    const savePath = path.resolve(outputDir, safeName);

    if (fs.existsSync(savePath)) {
      const existing = fs.statSync(savePath);
      if (existing.isDirectory()) {
        throw new CommandExecutionError(`Download target is a directory: ${savePath}`);
      }
      if (!overwrite) {
        throw new CommandExecutionError(`File already exists: ${savePath}. Re-run with --overwrite true or change --name.`);
      }
      fs.unlinkSync(savePath);
    }

    const urlResult = await alipanPostWithFallback<AliPanDownloadUrlResponse>(page, [
      {
        url: 'https://api.aliyundrive.com/v2/file/get_download_url',
        body: { file_id: fileId, expire_sec: 14400 },
      },
      {
        url: 'https://api.aliyundrive.com/v3/file/get_download_url',
        body: { file_id: fileId, expire_sec: 14400 },
      },
    ]);

    const method = String(urlResult.data?.method ?? 'GET').toUpperCase();
    if (method !== 'GET') {
      throw new CommandExecutionError(`AliPan returned unsupported download method: ${method}`);
    }

    const downloadUrls = listAliPanDownloadUrls(urlResult.data, detail);

    const allCookies = [
      ...(await page.getCookies({ domain: 'alipan.com' })),
      ...(await page.getCookies({ domain: 'aliyundrive.com' })),
      ...(await page.getCookies({ domain: 'api.aliyundrive.com' })),
    ];
    const cookieHeader = formatCookieHeader(allCookies);

    const baseHeaders = {
      Referer: 'https://www.alipan.com/',
      Origin: 'https://www.alipan.com',
    };

    let downloaded: { success: boolean; size: number; error?: string } | null = null;
    let usedEndpoint = urlResult.endpoint;
    const errors: string[] = [];
    const progressBar = showProgress ? createProgressBar(safeName, 0, 1) : null;
    const expectedSize = typeof detail.size === 'number' ? detail.size : undefined;

    if (downloadUrls.length > 0) {
      const attempts: Array<{ url: string; cookies?: string }> = [];
      for (const u of downloadUrls) {
        attempts.push({ url: u });
        if (cookieHeader) attempts.push({ url: u, cookies: cookieHeader });
      }

      for (let i = 0; i < attempts.length; i++) {
        const attempt = attempts[i];
        const uMasked = maskUrl(attempt.url);
        const label = attempts.length > 1 ? `attempt ${i + 1}/${attempts.length}` : undefined;
        const result = await httpDownload(attempt.url, savePath, {
          timeout,
          headers: baseHeaders,
          cookies: attempt.cookies,
          onProgress: (received, total) => {
            progressBar?.update(received, total, label);
          },
        });
        if (result.success) {
          const sizeMismatch = getAliPanSizeMismatchError(expectedSize, result.size);
          if (!sizeMismatch) {
            downloaded = result;
            break;
          }

          removeDownloadArtifacts(savePath);
          errors.push(`${uMasked}${attempt.cookies ? ' (with cookies)' : ''} -> ${sizeMismatch}`);
          continue;
        }
        errors.push(`${uMasked}${attempt.cookies ? ' (with cookies)' : ''} -> ${result.error ?? 'unknown error'}`);
      }
    } else {
      errors.push('Direct download URL is empty');
    }

    // Some AliPan videos intentionally return empty direct URL. Fallback to preview stream.
    if (!downloaded?.success && detail.category === 'video') {
      const previewResult = await alipanPostWithFallback<AliPanVideoPreviewResponse>(page, [
        {
          url: 'https://api.aliyundrive.com/v2/file/get_video_preview_play_info',
          body: {
            file_id: fileId,
            category: 'live_transcoding',
            get_subtitle_info: true,
          },
        },
        {
          url: 'https://api.aliyundrive.com/v2/file/get_video_preview_play_info',
          body: {
            file_id: fileId,
            category: 'original',
          },
        },
      ]);

      const previewUrls = listVideoPreviewUrls(previewResult.data);
      if (previewUrls.length > 0) {
        usedEndpoint = `${previewResult.endpoint} (yt-dlp)`;
        const previewUrl = previewUrls[0];
        const totalPreviewBytes = typeof detail.size === 'number' && detail.size > 0 ? detail.size : 0;
        const ytdlpResult = await ytdlpDownload(previewUrl, savePath, {
          extraArgs: [
            '--add-header', 'Referer: https://www.alipan.com/',
            '--add-header', 'Origin: https://www.alipan.com',
            '--merge-output-format', 'mp4',
          ],
          onProgress: (percent) => {
            if (totalPreviewBytes > 0) {
              const current = Math.min(totalPreviewBytes, Math.round((percent / 100) * totalPreviewBytes));
              progressBar?.update(current, totalPreviewBytes, 'preview stream');
            } else {
              progressBar?.update(percent, 100, 'preview stream');
            }
          },
        });
        if (ytdlpResult.success) {
          const sizeMismatch = getAliPanSizeMismatchError(expectedSize, ytdlpResult.size);
          if (!sizeMismatch) {
            downloaded = ytdlpResult;
          } else {
            removeDownloadArtifacts(savePath);
            errors.push(`Preview stream download failed: ${sizeMismatch}`);
          }
        } else {
          errors.push(`Preview stream download failed: ${ytdlpResult.error ?? 'unknown error'}`);
        }
      } else {
        errors.push('Video preview play URL is empty');
      }
    }

    if (!downloaded?.success) {
      progressBar?.fail('download failed');
      throw new CommandExecutionError(`Download failed after retries: ${errors.join(' | ')}`);
    }

    const bytes = downloaded.size > 0
      ? downloaded.size
      : (typeof detail.size === 'number' ? detail.size : 0);
    const size = bytes > 0 ? formatBytes(bytes) : '-';
    progressBar?.complete(true, size);

    return [{
      status: 'success',
      file_id: detail.file_id ?? fileId,
      path: pathArg || resolved?.path || '',
      name: safeName,
      size,
      saved_to: savePath,
      endpoint: usedEndpoint,
    }];
  },
});
