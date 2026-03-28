import * as fs from 'node:fs';
import * as path from 'node:path';
import { httpDownload, sanitizeFilename } from '../../download/index.js';
import { createProgressBar } from '../../download/progress.js';
import { CommandExecutionError, getErrorMessage } from '../../errors.js';
import { cli, Strategy } from '../../registry.js';
import {
  QUARK_DRIVE_ORIGIN,
  QUARK_WEB_ORIGIN,
  collectQuarkCookieHeader,
  quarkGetFileInfo,
  quarkRequestWithFallback,
  quarkResolvePath,
} from './utils.js';

type QuarkDownloadItem = {
  fid?: string;
  pdir_fid?: string;
  file_name?: string;
  download_url?: string;
  size?: number;
  format_type?: string;
};

type QuarkDownloadTaskCreateResponse = {
  task_id?: string;
};

type QuarkDownloadTaskPollResponse = {
  status?: number;
  task_id?: string;
  download_url?: string;
};

function maskUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '(invalid-url)';
  }
}

async function requestDirectDownloadInfo(
  page: Parameters<typeof quarkRequestWithFallback>[0],
  fileId: string,
): Promise<{ item: QuarkDownloadItem | null; endpoint: string }> {
  const result = await quarkRequestWithFallback<QuarkDownloadItem[]>(page, [
    {
      url: `${QUARK_DRIVE_ORIGIN}/1/clouddrive/file/download`,
      body: {
        fids: [fileId],
      },
    },
  ]);

  const list = Array.isArray(result.data) ? result.data : [];
  return {
    item: list[0] ?? null,
    endpoint: result.endpoint,
  };
}

async function requestTaskDownloadUrl(
  page: Parameters<typeof quarkRequestWithFallback>[0],
  fileId: string,
): Promise<{ downloadUrl: string; endpoint: string }> {
  const created = await quarkRequestWithFallback<QuarkDownloadTaskCreateResponse>(page, [
    {
      url: `${QUARK_DRIVE_ORIGIN}/1/clouddrive/download/list`,
      body: {
        include_fids: [fileId],
      },
    },
  ]);

  const taskId = String(created.data?.task_id ?? '').trim();
  const pollIntervalMs = Math.max(200, Number(created.metadata?.tq_gap ?? 200));
  if (!taskId) {
    throw new CommandExecutionError('Quark download task response missing task_id');
  }

  for (let retryIndex = 0; retryIndex < 60; retryIndex += 1) {
    if (retryIndex > 0) {
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }

    const polled = await quarkRequestWithFallback<QuarkDownloadTaskPollResponse>(page, [
      {
        url: `${QUARK_DRIVE_ORIGIN}/1/clouddrive/download/list`,
        method: 'GET',
        params: {
          task_id: taskId,
          retry_index: retryIndex,
        },
      },
    ]);

    const status = Number(polled.data?.status ?? -1);
    if (status === 2) {
      const downloadUrl = String(polled.data?.download_url ?? '').trim();
      if (!downloadUrl) throw new CommandExecutionError('Quark download task finished without download_url');
      return {
        downloadUrl,
        endpoint: polled.endpoint,
      };
    }
    if (status === 3) {
      throw new CommandExecutionError('Quark download task failed');
    }
  }

  throw new CommandExecutionError('Quark download task polling timed out');
}

cli({
  site: 'quark',
  name: 'download',
  description: 'Download a file from Quark to local disk',
  domain: 'pan.quark.cn',
  strategy: Strategy.HEADER,
  browser: true,
  navigateBefore: false,
  args: [
    { name: 'file-id', required: false, positional: true, help: 'Target file_id to download' },
    { name: 'path', default: '', help: 'Path to target file (alternative to file-id)' },
    { name: 'output', default: './quark-downloads', help: 'Output directory' },
    { name: 'name', default: '', help: 'Override local filename' },
    { name: 'overwrite', type: 'boolean', default: false, help: 'Overwrite existing file if present' },
    { name: 'timeout', type: 'int', default: 120000, help: 'Download timeout in milliseconds' },
    { name: 'show-progress', type: 'boolean', default: true, help: 'Show realtime download progress in terminal' },
  ],
  columns: ['status', 'file_id', 'path', 'name', 'size', 'saved_to', 'endpoint'],
  func: async (page, kwargs) => {
    if (!page) throw new CommandExecutionError('Browser page required for quark download');

    const fileIdArg = String(kwargs['file-id'] ?? '').trim();
    const pathArg = String(kwargs.path ?? '').trim();
    const outputDir = String(kwargs.output ?? './quark-downloads').trim() || './quark-downloads';
    const nameArg = String(kwargs.name ?? '').trim();
    const overwrite = Boolean(kwargs.overwrite);
    const timeoutRaw = Number(kwargs.timeout ?? 120000);
    const timeout = Math.max(1000, Number.isFinite(timeoutRaw) ? timeoutRaw : 120000);
    const showProgress = Boolean(kwargs['show-progress']) && process.stderr.isTTY !== false;

    if (!fileIdArg && !pathArg) {
      throw new CommandExecutionError('Provide file-id positional argument or --path');
    }

    await page.goto(`${QUARK_WEB_ORIGIN}/list#/list/all`);
    await page.wait(1);

    const resolved = fileIdArg
      ? null
      : await quarkResolvePath(page, pathArg, 'file');
    const fileId = fileIdArg || resolved!.file_id;

    const detail = await quarkGetFileInfo(page, fileId);
    if ((detail.file_type ?? 1) === 0 || detail.dir === true) {
      throw new CommandExecutionError('Quark folder download is not supported yet. Please pass a file path/file_id.');
    }

    const sourceName = nameArg || String(detail.file_name ?? resolved?.name ?? '').trim() || `${fileId}.bin`;
    const safeName = sanitizeFilename(sourceName) || `quark_${fileId}.bin`;
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

    const directInfo = await requestDirectDownloadInfo(page, fileId);
    const directUrl = String(directInfo.item?.download_url ?? '').trim();
    const downloadUrlResult = directUrl
      ? { downloadUrl: directUrl, endpoint: directInfo.endpoint }
      : await requestTaskDownloadUrl(page, fileId);

    let cookieHeader = '';
    let cookieWarning = '';
    try {
      cookieHeader = await collectQuarkCookieHeader(page);
    } catch (error) {
      cookieWarning = getErrorMessage(error);
    }

    const progressBar = showProgress ? createProgressBar(safeName, 0, 1) : null;
    const attempts = [
      { label: 'signed-url', cookies: '' },
      ...(cookieHeader ? [{ label: 'signed-url+cookies', cookies: cookieHeader }] : []),
    ];

    let downloadResult: Awaited<ReturnType<typeof httpDownload>> | null = null;
    const downloadErrors: string[] = [];
    for (const attempt of attempts) {
      const result = await httpDownload(downloadUrlResult.downloadUrl, savePath, {
        cookies: attempt.cookies || undefined,
        timeout,
        headers: {
          Referer: `${QUARK_WEB_ORIGIN}/`,
          Origin: QUARK_WEB_ORIGIN,
        },
        onProgress: (received, total) => {
          progressBar?.update(received, total);
        },
      });
      if (result.success) {
        downloadResult = result;
        break;
      }
      downloadErrors.push(`${attempt.label}: ${result.error ?? 'unknown error'}`);
    }

    if (!downloadResult?.success) {
      const masked = maskUrl(downloadUrlResult.downloadUrl);
      const suffix = cookieWarning ? ` | cookie fallback unavailable: ${cookieWarning}` : '';
      throw new CommandExecutionError(`Quark download failed: ${masked} -> ${downloadErrors.join(' | ') || 'unknown error'}${suffix}`);
    }

    progressBar?.complete(true);

    return [{
      status: 'success',
      file_id: fileId,
      path: pathArg || '',
      name: safeName,
      size: Number(detail.size ?? downloadResult.size ?? 0),
      saved_to: savePath,
      endpoint: downloadUrlResult.endpoint,
    }];
  },
});
