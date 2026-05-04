import { AuthRequiredError, CommandExecutionError } from '../../errors.js';
import type { IPage } from '../../types.js';

export type AliPanRequest = {
  url: string;
  body: unknown;
  method?: string;
  headers?: Record<string, string>;
  injectDriveId?: boolean;
  injectAuthToken?: boolean;
  injectShareToken?: boolean;
  shareToken?: string;
};

export type AliPanResolvedNode = {
  path: string;
  name: string;
  type: string;
  file_id: string;
  parent_file_id: string;
  size: number;
  updated_at: string;
  created_at: string;
};

export type AliPanFileItem = {
  file_id?: string;
  parent_file_id?: string;
  name?: string;
  type?: string;
  size?: number;
  updated_at?: string;
  created_at?: string;
};

type AliPanEvalSuccess<T> = {
  ok: true;
  data: T;
  endpoint: string;
  status: number;
};

type AliPanEvalError = {
  __error: 'AUTH_REQUIRED' | 'API_ERROR';
  status?: number;
  code?: string | null;
  message?: string;
  endpoint?: string;
};

type AliPanEvalResult<T> = AliPanEvalSuccess<T> | AliPanEvalError;

type AliPanListResponse = {
  items?: AliPanFileItem[];
  next_marker?: string;
};

type AliPanCreateFolderResponse = {
  file_id?: string;
  parent_file_id?: string;
  name?: string;
  type?: string;
  size?: number;
  updated_at?: string;
  created_at?: string;
};

function isErrorResult<T>(value: AliPanEvalResult<T>): value is AliPanEvalError {
  return '__error' in value;
}

/**
 * Run one or more AliPan HTTP requests in browser context.
 * Automatically injects auth / drive / share headers when requested.
 * Falls back to the next endpoint when a request fails.
 */
export async function alipanPostWithFallback<T>(
  page: IPage | null,
  requests: AliPanRequest[],
): Promise<{ data: T; endpoint: string; status: number }> {
  if (!page) throw new CommandExecutionError('Browser page required for AliPan command');
  if (!Array.isArray(requests) || requests.length === 0) {
    throw new CommandExecutionError('AliPan request list is empty');
  }

  const result = await page.evaluate(`
    async () => {
      const requests = ${JSON.stringify(requests)};
      const raw = localStorage.getItem('token') || '';
      let token = {};
      try { token = JSON.parse(raw || '{}'); } catch {}

      const accessToken = token.access_token;
      const tokenType = token.token_type || 'Bearer';
      const driveId = token.default_drive_id || token.default_sbox_drive_id;

      const requiresAuthToken = requests.some((req) => req.injectAuthToken !== false);
      const requiresDriveId = requests.some((req) => req.injectDriveId !== false);

      if ((requiresAuthToken && !accessToken) || (requiresDriveId && !driveId)) {
        return {
          __error: 'AUTH_REQUIRED',
          message: 'Missing access token or drive id. Please log in to AliPan in Chrome.',
        };
      }

      let lastError = null;
      for (const req of requests) {
        const payload = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
          ? { ...(req.body || {}) }
          : req.body;
        const injectAuthToken = req.injectAuthToken !== false;
        const injectDriveId = req.injectDriveId !== false;
        const injectShareToken = req.injectShareToken === true;
        const shareToken = req.shareToken || '';

        if ((injectAuthToken && !accessToken) || (injectDriveId && !driveId) || (injectShareToken && !shareToken)) {
          return {
            __error: 'AUTH_REQUIRED',
            message: injectShareToken && !shareToken
              ? 'Missing share token. Please refresh the share link and try again.'
              : 'Missing access token or drive id. Please log in to AliPan in Chrome.',
          };
        }

        if (injectDriveId && payload && typeof payload === 'object' && !Array.isArray(payload) && !payload.drive_id) {
          payload.drive_id = driveId;
        }

        // Small template support for same-drive move requests.
        if (injectDriveId && payload && typeof payload === 'object' && !Array.isArray(payload)) {
          for (const [key, value] of Object.entries(payload)) {
            if (value === '$drive_id') payload[key] = driveId;
          }
        }

        try {
          const method = String(req.method || 'POST').toUpperCase();
          const headers = {
            ...(req.headers || {}),
            'content-type': (req.headers && (req.headers['content-type'] || req.headers['Content-Type'])) || 'application/json',
          };
          if (injectAuthToken) {
            headers.authorization = tokenType + ' ' + accessToken;
          }
          if (injectShareToken) {
            headers['x-share-token'] = shareToken;
          }

          const resp = await fetch(req.url, {
            method,
            credentials: 'include',
            headers,
            body: method === 'GET' ? undefined : JSON.stringify(payload ?? {}),
          });

          const text = await resp.text();
          let body = null;
          try { body = text ? JSON.parse(text) : null; } catch {}

          if (resp.ok) {
            return {
              ok: true,
              data: body || {},
              endpoint: req.url,
              status: resp.status,
            };
          }

          lastError = {
            __error: 'API_ERROR',
            status: resp.status,
            code: body?.code || null,
            message: body?.message || text.slice(0, 200),
            endpoint: req.url,
          };
        } catch (error) {
          lastError = {
            __error: 'API_ERROR',
            status: 0,
            code: 'FetchFailed',
            message: String(error),
            endpoint: req.url,
          };
        }
      }

      return lastError || {
        __error: 'API_ERROR',
        status: 0,
        code: 'Unknown',
        message: 'No AliPan endpoint succeeded',
      };
    }
  `) as AliPanEvalResult<T>;

  if (isErrorResult(result)) {
    if (result.__error === 'AUTH_REQUIRED' || result.status === 401 || result.code === 'AccessTokenInvalid') {
      throw new AuthRequiredError('www.alipan.com', result.message ?? 'AliPan access token is invalid. Please re-login in Chrome.');
    }
    throw new CommandExecutionError(
      `AliPan API failed: HTTP ${result.status ?? '?'} ${result.code ?? ''} ${result.message ?? ''}`.trim(),
    );
  }

  return {
    data: result.data,
    endpoint: result.endpoint,
    status: result.status,
  };
}

type AliPanResolveEvalError = {
  __error: 'AUTH_REQUIRED' | 'API_ERROR' | 'PATH_NOT_FOUND' | 'TYPE_MISMATCH';
  status?: number;
  code?: string | null;
  message?: string;
};

function isResolveError(value: AliPanResolvedNode | AliPanResolveEvalError): value is AliPanResolveEvalError {
  return '__error' in value;
}

function mapAliPanItemToResolvedNode(item: AliPanFileItem, resolvedPath: string): AliPanResolvedNode {
  return {
    path: resolvedPath,
    name: String(item.name ?? ''),
    type: String(item.type ?? ''),
    file_id: String(item.file_id ?? ''),
    parent_file_id: String(item.parent_file_id ?? ''),
    size: Number(item.size ?? 0),
    updated_at: String(item.updated_at ?? ''),
    created_at: String(item.created_at ?? ''),
  };
}

export async function alipanListAll(
  page: IPage | null,
  options: {
    parentFileId: string;
    orderBy?: 'updated_at' | 'created_at' | 'name' | 'size';
    orderDirection?: 'ASC' | 'DESC';
    limit?: number;
  },
): Promise<AliPanFileItem[]> {
  const parentFileId = String(options.parentFileId ?? 'root').trim() || 'root';
  const orderBy = options.orderBy ?? 'name';
  const orderDirection = options.orderDirection ?? 'ASC';
  const limit = Number.isFinite(options.limit) ? Math.max(1, Number(options.limit)) : Number.POSITIVE_INFINITY;
  const items: AliPanFileItem[] = [];
  let marker = '';

  while (items.length < limit) {
    const pageSize = limit === Number.POSITIVE_INFINITY
      ? 200
      : Math.max(1, Math.min(200, limit - items.length));

    const result = await alipanPostWithFallback<AliPanListResponse>(page, [
      {
        url: 'https://api.aliyundrive.com/adrive/v3/file/list',
        body: {
          parent_file_id: parentFileId,
          limit: pageSize,
          all: false,
          order_by: orderBy,
          order_direction: orderDirection,
          marker,
        },
      },
    ]);

    const pageItems = Array.isArray(result.data?.items) ? result.data.items : [];
    items.push(...pageItems);
    marker = String(result.data?.next_marker ?? '').trim();
    if (!marker) break;
  }

  return items.slice(0, limit);
}

export async function alipanFindChildByName(
  page: IPage | null,
  parentFileId: string,
  childName: string,
): Promise<AliPanFileItem | null> {
  const normalizedChildName = String(childName ?? '').trim();
  if (!normalizedChildName) return null;

  const items = await alipanListAll(page, {
    parentFileId,
    orderBy: 'name',
    orderDirection: 'ASC',
  });

  return items.find(item => String(item.name ?? '') === normalizedChildName) ?? null;
}

export async function alipanCreateFolder(
  page: IPage | null,
  options: {
    parentFileId: string;
    folderName: string;
    resolvedPath?: string;
  },
): Promise<AliPanResolvedNode & { endpoint: string }> {
  const parentFileId = String(options.parentFileId ?? 'root').trim() || 'root';
  const folderName = String(options.folderName ?? '').trim();
  if (!folderName) throw new CommandExecutionError('Missing AliPan folder name');

  const result = await alipanPostWithFallback<AliPanCreateFolderResponse>(page, [
    {
      url: 'https://api.aliyundrive.com/adrive/v2/file/createWithFolders',
      body: {
        parent_file_id: parentFileId,
        name: folderName,
        type: 'folder',
        check_name_mode: 'refuse',
      },
    },
  ]);

  const createdItem: AliPanFileItem = {
    file_id: result.data?.file_id,
    parent_file_id: result.data?.parent_file_id ?? parentFileId,
    name: result.data?.name ?? folderName,
    type: result.data?.type ?? 'folder',
    size: result.data?.size ?? 0,
    updated_at: result.data?.updated_at ?? '',
    created_at: result.data?.created_at ?? '',
  };

  let resolvedItem = createdItem;
  if (!resolvedItem.file_id) {
    const found = await alipanFindChildByName(page, parentFileId, folderName);
    if (!found?.file_id) {
      throw new CommandExecutionError(`AliPan mkdir created "${folderName}" but it could not be resolved afterwards`);
    }
    resolvedItem = found;
  }

  if (String(resolvedItem.type ?? 'folder') !== 'folder') {
    throw new CommandExecutionError(`AliPan mkdir returned a non-folder target for "${folderName}"`);
  }

  return {
    ...mapAliPanItemToResolvedNode(resolvedItem, options.resolvedPath ?? ''),
    endpoint: result.endpoint,
  };
}

/**
 * Resolve an AliPan path into a concrete file/folder node.
 */
export async function alipanResolvePath(
  page: IPage | null,
  pathValue: string,
  expectedType: 'all' | 'file' | 'folder' = 'all',
): Promise<AliPanResolvedNode> {
  if (!page) throw new CommandExecutionError('Browser page required for AliPan command');
  const normalizedPath = String(pathValue ?? '').trim();
  if (!normalizedPath) throw new CommandExecutionError('Path is required');

  const result = await page.evaluate(`
    async () => {
      const pathValue = ${JSON.stringify(normalizedPath)};
      const expectedType = ${JSON.stringify(expectedType)};
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
          limit: 200,
          all: false,
          order_by: 'name',
          order_direction: 'ASC',
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

      if (pathValue === '/' || pathValue === 'root') {
        if (expectedType === 'file') {
          return {
            __error: 'TYPE_MISMATCH',
            message: 'Path resolved but type mismatch. Expected file, got folder',
          };
        }
        return {
          path: '/',
          name: '/',
          type: 'folder',
          file_id: 'root',
          parent_file_id: '',
          size: 0,
          updated_at: '',
          created_at: '',
        };
      }

      const segments = pathValue.split('/').map((segment) => segment.trim()).filter(Boolean);
      if (segments.length === 0) {
        return {
          __error: 'PATH_NOT_FOUND',
          message: 'Invalid path',
        };
      }

      let current = {
        file_id: 'root',
        parent_file_id: '',
        name: '/',
        type: 'folder',
      };

      for (const segment of segments) {
        let found = null;
        let marker = '';
        do {
          const listed = await listFiles(current.file_id, marker);
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
            message: 'Path not found: ' + segment,
          };
        }

        current = found;
      }

      if (expectedType !== 'all' && current.type !== expectedType) {
        return {
          __error: 'TYPE_MISMATCH',
          message: 'Path resolved but type mismatch. Expected ' + expectedType + ', got ' + current.type,
        };
      }

      return {
        path: pathValue.startsWith('/') ? pathValue : '/' + pathValue,
        name: current.name || '',
        type: current.type || '',
        file_id: current.file_id || '',
        parent_file_id: current.parent_file_id || '',
        size: typeof current.size === 'number' ? current.size : 0,
        updated_at: current.updated_at || '',
        created_at: current.created_at || '',
      };
    }
  `) as AliPanResolvedNode | AliPanResolveEvalError;

  if (isResolveError(result)) {
    if (result.__error === 'AUTH_REQUIRED' || result.status === 401 || result.code === 'AccessTokenInvalid') {
      throw new AuthRequiredError('www.alipan.com', result.message ?? 'AliPan access token is invalid. Please re-login in Chrome.');
    }
    if (result.__error === 'API_ERROR') {
      throw new CommandExecutionError(
        `AliPan resolve failed: HTTP ${result.status ?? '?'} ${result.code ?? ''} ${result.message ?? ''}`.trim(),
      );
    }
    throw new CommandExecutionError(result.message ?? `AliPan path resolve failed: ${normalizedPath}`);
  }

  return result;
}

/* ── Share API ──────────────────────────────────────────────────── */

export type AliPanShareTokenResponse = {
  share_token?: string;
};

export type AliPanShareListItem = {
  file_id?: string;
  name?: string;
  type?: string;
  size?: number;
  parent_file_id?: string;
};

export type AliPanShareListResponse = {
  items?: AliPanShareListItem[];
  next_marker?: string;
};

export async function alipanGetShareToken(
  page: Parameters<typeof alipanPostWithFallback>[0],
  shareId: string,
  sharePwd: string,
): Promise<string> {
  const result = await alipanPostWithFallback<AliPanShareTokenResponse>(page, [
    {
      url: 'https://api.aliyundrive.com/v2/share_link/get_share_token',
      body: {
        share_id: shareId,
        share_pwd: sharePwd,
      },
      injectDriveId: false,
    },
  ]);

  const shareToken = String(result.data?.share_token ?? '').trim();
  if (!shareToken) {
    throw new CommandExecutionError('AliPan share token response missing share_token');
  }
  return shareToken;
}

export async function alipanListShareChildren(
  page: Parameters<typeof alipanPostWithFallback>[0],
  options: {
    shareId: string;
    shareToken: string;
    parentFileId: string;
    marker?: string;
  },
): Promise<AliPanShareListResponse> {
  const result = await alipanPostWithFallback<AliPanShareListResponse>(page, [
    {
      url: 'https://api.aliyundrive.com/adrive/v2/file/list_by_share',
      body: {
        share_id: options.shareId,
        parent_file_id: options.parentFileId,
        limit: 200,
        order_by: 'name',
        order_direction: 'ASC',
        marker: options.marker ?? '',
      },
      injectDriveId: false,
      injectAuthToken: false,
      injectShareToken: true,
      shareToken: options.shareToken,
    },
  ]);

  return result.data || {};
}

export async function alipanListAllShareChildren(
  page: Parameters<typeof alipanPostWithFallback>[0],
  options: {
    shareId: string;
    shareToken: string;
    parentFileId: string;
  },
): Promise<AliPanShareListItem[]> {
  const items: AliPanShareListItem[] = [];
  let marker = '';

  do {
    const listed = await alipanListShareChildren(page, { ...options, marker });
    items.push(...(Array.isArray(listed.items) ? listed.items : []));
    marker = String(listed.next_marker ?? '').trim();
  } while (marker);

  return items;
}
