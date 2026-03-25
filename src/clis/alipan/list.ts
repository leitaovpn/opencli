import { AuthRequiredError, CommandExecutionError } from '../../errors.js';
import { cli, Strategy } from '../../registry.js';
import type { IPage } from '../../types.js';

type AliPanFileItem = {
  file_id?: string;
  parent_file_id?: string;
  name?: string;
  type?: string;
  category?: string;
  size?: number;
  updated_at?: string;
  created_at?: string;
};

type AliPanListResponse = {
  items?: AliPanFileItem[];
  next_marker?: string;
};

function quoteShellArg(value: string): string {
  return JSON.stringify(value);
}

function normalizeBasePath(pathArg: string): string {
  const normalized = pathArg.trim();
  if (!normalized || normalized === '/') return '/';
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

function joinChildPath(basePath: string, childName: string): string {
  if (basePath === '/') return `/${childName}`;
  return `${basePath.replace(/\/+$/, '')}/${childName}`;
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

cli({
  site: 'alipan',
  name: 'list',
  description: 'List files/folders from your AliPan drive',
  domain: 'www.alipan.com',
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
    if (!page) throw new CommandExecutionError('Browser page required for alipan list');

    const parentFileId = String(kwargs['parent-file-id'] ?? 'root');
    const pathArg = String(kwargs.path ?? '').trim();
    const requestedLimit = Number(kwargs.limit ?? 50);
    const limit = Math.max(1, Math.min(Number.isFinite(requestedLimit) ? requestedLimit : 50, 200));
    const requestLimit = Math.max(limit, 100);
    const typeFilter = String(kwargs.type ?? 'all');
    const orderBy = String(kwargs['order-by'] ?? 'updated_at');
    const orderDirection = String(kwargs['order-direction'] ?? 'DESC');
    const showCommands = Boolean(kwargs['show-commands']);
    const basePath = normalizeBasePath(pathArg);

    await page.goto('https://www.alipan.com/drive/home');
    await page.wait(1);

    const result = await page.evaluate(`
      async () => {
        const apiUrl = 'https://api.aliyundrive.com/adrive/v3/file/list';
        const raw = localStorage.getItem('token') || '';
        let token = {};
        try { token = JSON.parse(raw || '{}'); } catch {}

        const accessToken = token.access_token;
        const tokenType = token.token_type || 'Bearer';
        const driveId = token.default_drive_id || token.default_sbox_drive_id;

        if (!accessToken || !driveId) {
          return {
            __error: 'AUTH_REQUIRED',
            message: 'Missing access token or drive id. Please log in to AliPan in Chrome.',
          };
        }

        async function listFiles(parentFileId, marker) {
          const payload = {
            drive_id: driveId,
            parent_file_id: parentFileId,
            limit: ${requestLimit},
            all: false,
            order_by: ${JSON.stringify(orderBy)},
            order_direction: ${JSON.stringify(orderDirection)},
          };
          if (marker) payload.marker = marker;
          const resp = await fetch(apiUrl, {
            method: 'POST',
            credentials: 'include',
            headers: {
              'content-type': 'application/json',
              'authorization': tokenType + ' ' + accessToken,
            },
            body: JSON.stringify(payload),
          });
          const text = await resp.text();
          let body = null;
          try { body = JSON.parse(text); } catch {}
          if (!resp.ok) {
            return {
              ok: false,
              status: resp.status,
              code: body?.code || null,
              message: body?.message || text.slice(0, 200),
            };
          }
          return { ok: true, body: body || {} };
        }

        let targetParentFileId = ${JSON.stringify(parentFileId)};
        const pathValue = ${JSON.stringify(pathArg)};

        if (pathValue && pathValue !== '/') {
          const segments = pathValue.split('/').map((part) => part.trim()).filter(Boolean);
          let currentParent = 'root';
          for (const segment of segments) {
            let found = null;
            let marker = '';
            do {
              const listed = await listFiles(currentParent, marker);
              if (!listed.ok) {
                return {
                  __error: 'API_ERROR',
                  status: listed.status,
                  code: listed.code,
                  message: listed.message,
                };
              }
              const items = Array.isArray(listed.body?.items) ? listed.body.items : [];
              found = items.find((item) => item && item.name === segment) || null;
              marker = listed.body?.next_marker || '';
            } while (!found && marker);

            if (!found) {
              return {
                __error: 'PATH_NOT_FOUND',
                message: 'Folder not found in path: ' + segment,
              };
            }
            if (found.type !== 'folder') {
              return {
                __error: 'PATH_NOT_FOUND',
                message: 'Path segment is not a folder: ' + segment,
              };
            }
            currentParent = found.file_id;
          }
          targetParentFileId = currentParent;
        }

        const finalList = await listFiles(targetParentFileId, '');
        if (!finalList.ok) {
          return {
            __error: 'API_ERROR',
            status: finalList.status,
            code: finalList.code,
            message: finalList.message,
          };
        }

        return finalList.body || {};
      }
    `) as (AliPanListResponse & { __error?: string; message?: string; code?: string; status?: number });

    if (result?.__error === 'AUTH_REQUIRED') {
      throw new AuthRequiredError('www.alipan.com', result.message ?? 'Not logged in to AliPan');
    }
    if (result?.__error === 'API_ERROR') {
      if (result.status === 401 || result.code === 'AccessTokenInvalid') {
        throw new AuthRequiredError('www.alipan.com', 'AliPan access token is invalid. Please re-login in Chrome.');
      }
      throw new CommandExecutionError(
        `AliPan list failed: HTTP ${result.status ?? '?'} ${result.code ?? ''} ${result.message ?? ''}`.trim(),
      );
    }
    if (result?.__error === 'PATH_NOT_FOUND') {
      throw new CommandExecutionError(result.message ?? `AliPan path not found: ${pathArg}`);
    }

    const items = Array.isArray(result?.items) ? result.items : [];
    const filtered = typeFilter === 'all' ? items : items.filter((item) => item?.type === typeFilter);

    return filtered.slice(0, limit).map((item) => {
      const rawSize = typeof item?.size === 'number' ? item.size : undefined;
      const fileId = item?.file_id ?? '';
      const name = item?.name ?? '';
      const canBuildPath = pathArg.trim() !== '' || parentFileId === 'root';
      const childPath = canBuildPath ? joinChildPath(basePath, name) : '';
      const renameCmd = canBuildPath
        ? `opencli alipan rename --path ${quoteShellArg(childPath)} --new-name <new-name>`
        : `opencli alipan rename ${fileId} <new-name>`;
      const moveCmd = canBuildPath
        ? `opencli alipan move --path ${quoteShellArg(childPath)} --to-path <dest-folder-path>`
        : `opencli alipan move ${fileId} <to-parent-file-id>`;
      const deleteCmd = canBuildPath
        ? `opencli alipan delete --path ${quoteShellArg(childPath)} --yes true`
        : `opencli alipan delete ${fileId} --yes true`;
      const downloadCmd = canBuildPath
        ? `opencli alipan download --path ${quoteShellArg(childPath)}`
        : `opencli alipan download ${fileId}`;

      return {
        name,
        type: item?.type ?? '',
        size: item?.type === 'folder' ? '-' : formatBytes(rawSize),
        updated_at: item?.updated_at ?? '',
        file_id: fileId,
        parent_file_id: item?.parent_file_id ?? '',
        ops: showCommands
          ? `rename: ${renameCmd} | move: ${moveCmd} | delete: ${deleteCmd} | download: ${downloadCmd}`
          : '-',
      };
    });
  },
});
