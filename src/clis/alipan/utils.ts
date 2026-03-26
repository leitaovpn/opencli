import { AuthRequiredError, CommandExecutionError } from '../../errors.js';
import type { IPage } from '../../types.js';

export type AliPanRequest = {
  url: string;
  body: Record<string, unknown>;
  injectDriveId?: boolean;
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

function isErrorResult<T>(value: AliPanEvalResult<T>): value is AliPanEvalError {
  return '__error' in value;
}

/**
 * Run one or more AliPan POST requests in browser context.
 * Automatically injects Authorization header from localStorage token.
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

      if (!accessToken || !driveId) {
        return {
          __error: 'AUTH_REQUIRED',
          message: 'Missing access token or drive id. Please log in to AliPan in Chrome.',
        };
      }

      let lastError = null;
      for (const req of requests) {
        const payload = { ...(req.body || {}) };
        const injectDriveId = req.injectDriveId !== false;
        if (injectDriveId && !payload.drive_id) payload.drive_id = driveId;

        // Small template support for same-drive move requests.
        if (injectDriveId) {
          for (const [key, value] of Object.entries(payload)) {
            if (value === '$drive_id') payload[key] = driveId;
          }
        }

        try {
          const resp = await fetch(req.url, {
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
