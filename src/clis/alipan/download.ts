import * as fs from 'node:fs';
import * as path from 'node:path';
import { formatCookieHeader, httpDownload, sanitizeFilename } from '../../download/index.js';
import { formatBytes } from '../../download/progress.js';
import { CommandExecutionError } from '../../errors.js';
import { cli, Strategy } from '../../registry.js';
import { alipanPostWithFallback, alipanResolvePath } from './utils.js';

type AliPanFileDetail = {
  file_id?: string;
  name?: string;
  type?: string;
  size?: number;
};

type AliPanDownloadUrlResponse = {
  url?: string;
  internal_url?: string;
  expiration?: string;
  method?: string;
};

function listDownloadUrls(payload: AliPanDownloadUrlResponse | null | undefined): string[] {
  const candidates = [payload?.url, payload?.internal_url];
  const unique = new Set<string>();
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      unique.add(candidate.trim());
    }
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

    const downloadUrls = listDownloadUrls(urlResult.data);
    if (downloadUrls.length === 0) {
      throw new CommandExecutionError('AliPan did not return a usable download URL');
    }

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
    const errors: string[] = [];
    for (const u of downloadUrls) {
      const uMasked = maskUrl(u);
      const withHeaders = await httpDownload(u, savePath, {
        timeout,
        headers: baseHeaders,
      });
      if (withHeaders.success) {
        downloaded = withHeaders;
        break;
      }
      errors.push(`${uMasked} -> ${withHeaders.error ?? 'unknown error'}`);

      if (!cookieHeader) continue;
      const withHeadersAndCookies = await httpDownload(u, savePath, {
        timeout,
        headers: baseHeaders,
        cookies: cookieHeader,
      });
      if (withHeadersAndCookies.success) {
        downloaded = withHeadersAndCookies;
        break;
      }
      errors.push(`${uMasked} (with cookies) -> ${withHeadersAndCookies.error ?? 'unknown error'}`);
    }

    if (!downloaded?.success) {
      throw new CommandExecutionError(`Download failed after retries: ${errors.join(' | ')}`);
    }

    const bytes = downloaded.size > 0
      ? downloaded.size
      : (typeof detail.size === 'number' ? detail.size : 0);
    const size = bytes > 0 ? formatBytes(bytes) : '-';

    return [{
      status: 'success',
      file_id: detail.file_id ?? fileId,
      path: pathArg || resolved?.path || '',
      name: safeName,
      size,
      saved_to: savePath,
      endpoint: urlResult.endpoint,
    }];
  },
});
