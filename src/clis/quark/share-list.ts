import { CommandExecutionError } from '../../errors.js';
import { cli, Strategy } from '../../registry.js';
import {
  QUARK_WEB_ORIGIN,
  getQuarkShareToken,
  listAllShareChildren,
  normalizeQuarkFileType,
} from './utils.js';
import { normalizeQuarkSharePath, parseQuarkShareReference } from './save-shared.js';

function formatBytes(bytes: number | undefined): string {
  if (!Number.isFinite(bytes) || (bytes as number) < 0) return '-';
  const value = Number(bytes);
  if (value === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const scaled = value / (1024 ** exponent);
  return `${scaled >= 10 ? scaled.toFixed(0) : scaled.toFixed(1)} ${units[exponent]}`;
}

async function resolveShareListPath(
  page: Parameters<typeof getQuarkShareToken>[0],
  options: {
    shareId: string;
    stoken: string;
    path: string;
  },
): Promise<string> {
  const normalizedPath = normalizeQuarkSharePath(options.path);
  if (normalizedPath === '/') return '0';
  const segments = normalizedPath.split('/').map(s => s.trim()).filter(Boolean);
  let parentFid = '0';
  for (const segment of segments) {
    const children = await listAllShareChildren(page, {
      shareId: options.shareId,
      stoken: options.stoken,
      parentFid,
    });
    const found = children.find(item => String(item.file_name ?? '') === segment);
    if (!found?.fid) {
      throw new CommandExecutionError(`Share path not found: ${normalizedPath}`);
    }
    parentFid = String(found.fid);
  }
  return parentFid;
}

cli({
  site: 'quark',
  name: 'share-list',
  description: 'List files/folders inside a Quark share link',
  domain: 'pan.quark.cn',
  strategy: Strategy.HEADER,
  browser: true,
  navigateBefore: false,
  args: [
    { name: 'share', required: true, positional: true, help: 'Quark share URL or pwd_id' },
    { name: 'share-pwd', default: '', help: 'Share password / extraction code' },
    { name: 'path', default: '', help: 'Path inside share to list, e.g. /电影 (root if empty)' },
  ],
  columns: ['name', 'type', 'size', 'fid'],
  func: async (page, kwargs) => {
    if (!page) throw new CommandExecutionError('Browser page required for quark share-list');

    const shareInput = String(kwargs.share ?? '').trim();
    const sharePwdArg = String(kwargs['share-pwd'] ?? '').trim();
    const pathArg = String(kwargs.path ?? '').trim();

    const shareRef = parseQuarkShareReference(shareInput, sharePwdArg);

    await page.goto(`${QUARK_WEB_ORIGIN}/list#/list/all`);
    await page.wait(1);

    const shareToken = await getQuarkShareToken(page, shareRef.shareId, shareRef.sharePwd);

    const parentFid = pathArg
      ? await resolveShareListPath(page, { shareId: shareRef.shareId, stoken: shareToken, path: pathArg })
      : '0';

    const items = await listAllShareChildren(page, {
      shareId: shareRef.shareId,
      stoken: shareToken,
      parentFid,
    });

    return items
      .filter(item => item.fid)
      .map(item => ({
        name: String(item.file_name ?? ''),
        type: normalizeQuarkFileType(item),
        size: normalizeQuarkFileType(item) === 'folder' ? '-' : formatBytes(Number(item.size ?? 0)),
        fid: String(item.fid ?? ''),
      }));
  },
});
