import { CommandExecutionError } from '../../errors.js';
import { cli, Strategy } from '../../registry.js';
import {
  alipanGetShareToken,
  alipanListAllShareChildren,
} from './utils.js';
import { normalizeAliPanSharePath, parseAliPanShareReference } from './save-shared.js';

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
  page: Parameters<typeof alipanGetShareToken>[0],
  options: {
    shareId: string;
    shareToken: string;
    path: string;
  },
): Promise<string> {
  const normalizedPath = normalizeAliPanSharePath(options.path);
  if (normalizedPath === '/') return 'root';
  const segments = normalizedPath.split('/').map(s => s.trim()).filter(Boolean);
  let parentFileId = 'root';
  for (const segment of segments) {
    const children = await alipanListAllShareChildren(page, {
      shareId: options.shareId,
      shareToken: options.shareToken,
      parentFileId,
    });
    const found = children.find(item => String(item.name ?? '') === segment);
    if (!found?.file_id) {
      throw new CommandExecutionError(`Share path not found: ${normalizedPath}`);
    }
    parentFileId = found.file_id;
  }
  return parentFileId;
}

cli({
  site: 'alipan',
  name: 'share-list',
  description: 'List files/folders inside an AliPan share link',
  domain: 'www.alipan.com',
  strategy: Strategy.HEADER,
  browser: true,
  navigateBefore: false,
  args: [
    { name: 'share', required: true, positional: true, help: 'AliPan share URL or share_id' },
    { name: 'share-pwd', default: '', help: 'Share password / extraction code' },
    { name: 'path', default: '', help: 'Path inside share to list, e.g. /电影 (root if empty)' },
  ],
  columns: ['name', 'type', 'size', 'file_id'],
  func: async (page, kwargs) => {
    if (!page) throw new CommandExecutionError('Browser page required for alipan share-list');

    const shareInput = String(kwargs.share ?? '').trim();
    const sharePwdArg = String(kwargs['share-pwd'] ?? '').trim();
    const pathArg = String(kwargs.path ?? '').trim();

    const shareRef = parseAliPanShareReference(shareInput, sharePwdArg);

    await page.goto('https://www.alipan.com/drive/home');
    await page.wait(1);

    const shareToken = await alipanGetShareToken(page, shareRef.shareId, shareRef.sharePwd);

    const parentFileId = pathArg
      ? await resolveShareListPath(page, { shareId: shareRef.shareId, shareToken, path: pathArg })
      : 'root';

    const items = await alipanListAllShareChildren(page, {
      shareId: shareRef.shareId,
      shareToken,
      parentFileId,
    });

    return items
      .filter(item => item.file_id)
      .map(item => ({
        name: String(item.name ?? ''),
        type: String(item.type ?? 'folder'),
        size: String(item.type ?? '') === 'folder' ? '-' : formatBytes(Number(item.size ?? 0)),
        file_id: String(item.file_id ?? ''),
      }));
  },
});
