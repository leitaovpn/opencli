import { CommandExecutionError } from '../../errors.js';
import { cli, Strategy } from '../../registry.js';
import type { IPage } from '../../types.js';
import {
  QUARK_WEB_ORIGIN,
  buildQuarkSort,
  joinQuarkPath,
  normalizeQuarkFileType,
  normalizeQuarkParentFileId,
  normalizeQuarkPath,
  quarkListDirectoryAll,
  quarkResolvePath,
  type QuarkFileItem,
} from './utils.js';

function quoteShellArg(value: string): string {
  return JSON.stringify(value);
}

function formatBytes(bytes: number | undefined): string {
  if (!Number.isFinite(bytes) || (bytes as number) < 0) return '-';
  const value = Number(bytes);
  if (value === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const scaled = value / (1024 ** exponent);
  return `${scaled >= 10 ? scaled.toFixed(0) : scaled.toFixed(1)} ${units[exponent]}`;
}

function buildOps(basePath: string, fileId: string, showCommands: boolean, canBuildPath: boolean): string {
  if (!showCommands) return '-';
  const renameCmd = canBuildPath
    ? `opencli quark rename --path ${quoteShellArg(basePath)} --new-name <new-name>`
    : `opencli quark rename ${fileId} <new-name>`;
  const moveCmd = canBuildPath
    ? `opencli quark move --path ${quoteShellArg(basePath)} --to-path <dest-folder-path>`
    : `opencli quark move ${fileId} <to-parent-file-id>`;
  const deleteCmd = canBuildPath
    ? `opencli quark delete --path ${quoteShellArg(basePath)} --yes true`
    : `opencli quark delete ${fileId} --yes true`;
  const downloadCmd = canBuildPath
    ? `opencli quark download --path ${quoteShellArg(basePath)}`
    : `opencli quark download ${fileId}`;
  return `rename: ${renameCmd} | move: ${moveCmd} | delete: ${deleteCmd} | download: ${downloadCmd} | id: ${fileId}`;
}

cli({
  site: 'quark',
  name: 'list',
  description: 'List files/folders from your Quark drive',
  domain: 'pan.quark.cn',
  strategy: Strategy.HEADER,
  browser: true,
  navigateBefore: false,
  args: [
    { name: 'parent-file-id', default: 'root', help: 'Parent folder file_id (use root for root directory)' },
    { name: 'path', default: '', help: 'Folder path from root, e.g. /Movies/2025 (overrides --parent-file-id)' },
    { name: 'type', default: 'all', choices: ['all', 'file', 'folder'], help: 'Filter type: all, file, folder' },
    { name: 'limit', type: 'int', default: 50, help: 'Maximum rows to return (1-200)' },
    { name: 'order-by', default: 'updated_at', choices: ['updated_at', 'created_at', 'name', 'size'], help: 'Sort field' },
    { name: 'order-direction', default: 'DESC', choices: ['ASC', 'DESC'], help: 'Sort direction' },
    { name: 'show-commands', type: 'boolean', default: false, help: 'Include copyable rename/move/delete snippets in output' },
  ],
  columns: ['name', 'type', 'size', 'updated_at', 'file_id', 'parent_file_id', 'ops'],
  func: async (page: IPage | null, kwargs) => {
    if (!page) throw new CommandExecutionError('Browser page required for quark list');

    const pathArg = String(kwargs.path ?? '').trim();
    const parentFileIdArg = normalizeQuarkParentFileId(String(kwargs['parent-file-id'] ?? 'root'));
    const requestedLimit = Number(kwargs.limit ?? 50);
    const limit = Math.max(1, Math.min(Number.isFinite(requestedLimit) ? requestedLimit : 50, 200));
    const typeFilter = String(kwargs.type ?? 'all');
    const orderBy = String(kwargs['order-by'] ?? 'updated_at');
    const orderDirection = String(kwargs['order-direction'] ?? 'DESC');
    const showCommands = Boolean(kwargs['show-commands']);

    await page.goto(`${QUARK_WEB_ORIGIN}/list#/list/all`);
    await page.wait(1);

    const resolvedFolder = pathArg
      ? await quarkResolvePath(page, pathArg, 'folder')
      : null;
    const parentFileId = resolvedFolder?.file_id ?? parentFileIdArg;
    const basePath = pathArg ? normalizeQuarkPath(pathArg) : '/';
    const canBuildPath = Boolean(pathArg) || parentFileId === '0';

    const items = await quarkListDirectoryAll(page, {
      parentFileId,
      limit,
      sort: buildQuarkSort(orderBy, orderDirection),
    });

    return items
      .filter((item: QuarkFileItem) => {
        if (typeFilter === 'all') return true;
        return normalizeQuarkFileType(item) === typeFilter;
      })
      .slice(0, limit)
      .map((item: QuarkFileItem) => {
        const name = String(item.file_name ?? '');
        const type = normalizeQuarkFileType(item);
        const childPath = joinQuarkPath(basePath, name);
        const fileId = String(item.fid ?? '');

        return {
          name,
          type,
          size: type === 'folder' ? '-' : formatBytes(Number(item.size ?? 0)),
          updated_at: String(item.updated_at ?? ''),
          file_id: fileId,
          parent_file_id: String(item.pdir_fid ?? ''),
          ops: buildOps(childPath, fileId, showCommands, canBuildPath),
        };
      });
  },
});
