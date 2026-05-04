import { formatCookieHeader } from '../../download/index.js';
import { AuthRequiredError, CommandExecutionError } from '../../errors.js';
import type { BrowserCookie, IPage } from '../../types.js';

export const QUARK_WEB_ORIGIN = 'https://pan.quark.cn';
export const QUARK_DRIVE_ORIGIN = 'https://drive-pc.quark.cn';

const QUARK_DEFAULT_QUERY = {
  pr: 'ucpro',
  fr: 'pc',
  uc_param_str: 'dsdnfrpfbivesscpgimibtbmnijblauputogpintnwktprchmt',
} as const;

const QUARK_ROOT_FID = '0';
const QUARK_PAGE_SIZE = 100;
const QUARK_FILE_TYPE_DIR = 0;

export type QuarkRequest = {
  url: string;
  method?: string;
  params?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  injectDefaultParams?: boolean;
};

export type QuarkFileItem = {
  fid?: string;
  pdir_fid?: string;
  file_name?: string;
  file_type?: number;
  dir?: boolean;
  size?: number;
  updated_at?: string;
  created_at?: string;
  format_type?: string;
  category?: string;
  share_fid_token?: string;
};

export type QuarkResolvedNode = {
  path: string;
  name: string;
  type: string;
  file_id: string;
  parent_file_id: string;
  size: number;
  updated_at: string;
  created_at: string;
  format_type: string;
};

type QuarkRequestResult<T> = {
  data: T;
  raw: unknown;
  metadata: Record<string, unknown>;
  endpoint: string;
  status: number;
};

type QuarkEvalSuccess<T> = {
  ok: true;
  data: T;
  raw: unknown;
  metadata: Record<string, unknown>;
  endpoint: string;
  status: number;
};

type QuarkEvalError = {
  __error: 'AUTH_REQUIRED' | 'API_ERROR';
  status?: number;
  endpoint?: string;
  message?: string;
  body?: unknown;
};

type QuarkEvalResult<T> = QuarkEvalSuccess<T> | QuarkEvalError;

type QuarkListResponse = {
  list?: QuarkFileItem[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toQueryValue(value: string | number | boolean | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? '1' : '0';
  return String(value);
}

function buildUrl(rawUrl: string, params: QuarkRequest['params'], injectDefaultParams: boolean): string {
  const base = rawUrl.startsWith('http')
    ? rawUrl
    : rawUrl.startsWith('/desktop/')
      ? `${QUARK_WEB_ORIGIN}${rawUrl}`
      : `${QUARK_DRIVE_ORIGIN}${rawUrl}`;

  const url = new URL(base);
  if (injectDefaultParams && url.hostname === 'drive-pc.quark.cn') {
    for (const [key, value] of Object.entries(QUARK_DEFAULT_QUERY)) {
      if (!url.searchParams.has(key)) url.searchParams.set(key, value);
    }
  }
  for (const [key, value] of Object.entries(params ?? {})) {
    const normalized = toQueryValue(value);
    if (normalized === null) continue;
    url.searchParams.set(key, normalized);
  }
  return url.toString();
}

function dedupeCookies(cookies: BrowserCookie[]): BrowserCookie[] {
  const seen = new Set<string>();
  const result: BrowserCookie[] = [];
  for (const cookie of cookies) {
    const key = `${cookie.domain}\t${cookie.path ?? '/'}\t${cookie.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(cookie);
  }
  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function normalizeQuarkParentFileId(value: string): string {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized === 'root') return QUARK_ROOT_FID;
  return normalized;
}

export function normalizeQuarkPath(pathValue: string): string {
  const normalized = String(pathValue ?? '').trim();
  if (!normalized || normalized === '/') return '/';
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

export function joinQuarkPath(basePath: string, childName: string): string {
  const normalizedBase = normalizeQuarkPath(basePath);
  if (normalizedBase === '/') return `/${childName}`;
  return `${normalizedBase.replace(/\/+$/, '')}/${childName}`;
}

export function normalizeQuarkFileType(item: QuarkFileItem | null | undefined): 'file' | 'folder' {
  if ((item?.file_type ?? -1) === QUARK_FILE_TYPE_DIR || item?.dir === true) return 'folder';
  return 'file';
}

export function formatQuarkTimestamp(value: unknown): string {
  if (value == null || value === '') return '';
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) {
    const parsed = new Date(value.trim());
    return Number.isNaN(parsed.getTime()) ? value.trim() : parsed.toISOString();
  }

  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return String(value);

  const millis = num > 1e12 ? num : num * 1000;
  const date = new Date(millis);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString();
}

function mapFileToResolvedNode(item: QuarkFileItem, resolvedPath: string): QuarkResolvedNode {
  return {
    path: resolvedPath,
    name: String(item.file_name ?? ''),
    type: normalizeQuarkFileType(item),
    file_id: String(item.fid ?? ''),
    parent_file_id: String(item.pdir_fid ?? ''),
    size: Number(item.size ?? 0),
    updated_at: formatQuarkTimestamp(item.updated_at),
    created_at: formatQuarkTimestamp(item.created_at),
    format_type: String(item.format_type ?? ''),
  };
}

export async function collectQuarkCookieHeader(page: IPage | null): Promise<string> {
  if (!page) throw new CommandExecutionError('Browser page required for Quark command');
  const cookies = dedupeCookies([
    ...(await page.getCookies({ domain: 'pan.quark.cn' })),
    ...(await page.getCookies({ domain: 'drive-pc.quark.cn' })),
    ...(await page.getCookies({ domain: 'quark.cn' })),
  ]);

  if (cookies.length === 0) {
    throw new AuthRequiredError('pan.quark.cn', 'Missing Quark session cookies. Please log in to Quark Netdisk in Chrome.');
  }

  return formatCookieHeader(cookies);
}

function isQuarkEvalError<T>(value: QuarkEvalResult<T>): value is QuarkEvalError {
  return isRecord(value) && '__error' in value && typeof value.__error === 'string';
}

export async function quarkRequestWithFallback<T>(
  page: IPage | null,
  requests: QuarkRequest[],
): Promise<QuarkRequestResult<T>> {
  if (!page) throw new CommandExecutionError('Browser page required for Quark command');
  if (!Array.isArray(requests) || requests.length === 0) {
    throw new CommandExecutionError('Quark request list is empty');
  }

  const preparedRequests = requests.map((request) => {
    const method = String(request.method ?? 'POST').toUpperCase();
    const endpoint = buildUrl(request.url, request.params, request.injectDefaultParams !== false);
    const headers: Record<string, string> = {
      Accept: 'application/json, text/plain, */*',
      ...(request.headers ?? {}),
    };

    let body: string | undefined;
    if (method !== 'GET' && request.body !== undefined) {
      if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = 'application/json';
      }
      body = headers['Content-Type']?.includes('application/json')
        ? JSON.stringify(request.body)
        : String(request.body);
    }

    return {
      method,
      endpoint,
      headers,
      body,
    };
  });

  const result = await page.evaluate(`
    async () => {
      const requests = ${JSON.stringify(preparedRequests)};

      function isRecord(value) {
        return typeof value === 'object' && value !== null && !Array.isArray(value);
      }

      function getMessage(value) {
        if (!isRecord(value)) return '';
        const message = value.message ?? value.msg ?? value.error_message ?? value.error;
        return typeof message === 'string' ? message.trim() : '';
      }

      function isSuccessEnvelope(body) {
        if (!isRecord(body)) return true;
        if ('success' in body) return body.success === true;
        if ('code' in body) {
          return body.code === 0 || body.code === '0' || body.code === 'OK';
        }
        return true;
      }

      function extractEnvelopeData(body) {
        if (isRecord(body) && ('data' in body || 'metadata' in body)) {
          return {
            data: 'data' in body ? body.data : body,
            metadata: isRecord(body.metadata) ? body.metadata : {},
          };
        }
        return { data: body, metadata: {} };
      }

      function isAuthFailure(status, body) {
        if (status === 401 || status === 403) return true;
        const message = getMessage(body).toLowerCase();
        if (!message) return false;
        return (
          message.includes('login')
          || message.includes('登录')
          || message.includes('未登录')
          || message.includes('please login')
          || message.includes('not login')
        );
      }

      let lastError = {
        __error: 'API_ERROR',
        status: 0,
        message: 'No Quark endpoint succeeded',
        endpoint: requests[requests.length - 1]?.endpoint || '',
      };

      for (const request of requests) {
        try {
          const response = await fetch(request.endpoint, {
            method: request.method,
            credentials: 'include',
            headers: request.headers,
            body: request.body,
          });

          const text = await response.text();
          let parsed = text;
          try {
            parsed = text ? JSON.parse(text) : {};
          } catch {
            parsed = text;
          }

          if (response.ok && isSuccessEnvelope(parsed)) {
            const extracted = extractEnvelopeData(parsed);
            return {
              ok: true,
              data: extracted.data,
              raw: parsed,
              metadata: extracted.metadata,
              endpoint: request.endpoint,
              status: response.status,
            };
          }

          const message = getMessage(parsed) || text.slice(0, 240);
          lastError = {
            __error: isAuthFailure(response.status, parsed) ? 'AUTH_REQUIRED' : 'API_ERROR',
            status: response.status,
            message,
            endpoint: request.endpoint,
            body: parsed,
          };

          if (lastError.__error === 'AUTH_REQUIRED') {
            return lastError;
          }
        } catch (error) {
          lastError = {
            __error: 'API_ERROR',
            status: 0,
            message: error instanceof Error ? error.message : String(error),
            endpoint: request.endpoint,
          };
        }
      }

      return lastError;
    }
  `) as QuarkEvalResult<T>;

  if (isQuarkEvalError(result)) {
    if (result.__error === 'AUTH_REQUIRED') {
      throw new AuthRequiredError('pan.quark.cn', result.message || 'Quark login expired. Please re-login in Chrome.');
    }
    throw new CommandExecutionError(
      `Quark API failed: HTTP ${result.status ?? '?'} ${result.message ?? 'Unknown error'} (${result.endpoint ?? 'unknown endpoint'})`,
    );
  }

  return {
    data: result.data,
    raw: result.raw,
    metadata: result.metadata,
    endpoint: result.endpoint,
    status: result.status,
  };
}

export async function quarkGetFileInfo(page: IPage | null, fileId: string): Promise<QuarkFileItem> {
  const normalizedFileId = String(fileId ?? '').trim();
  if (!normalizedFileId) throw new CommandExecutionError('Missing Quark file_id');

  const result = await quarkRequestWithFallback<QuarkFileItem>(page, [
    {
      url: `${QUARK_DRIVE_ORIGIN}/1/clouddrive/file/info`,
      method: 'GET',
      params: {
        fid: normalizedFileId,
        need_profile_tags: 1,
      },
    },
  ]);

  return result.data ?? {};
}

export async function quarkListDirectoryPage(
  page: IPage | null,
  options: {
    parentFileId: string;
    pageNo?: number;
    pageSize?: number;
    sort?: string[];
  },
): Promise<QuarkFileItem[]> {
  const result = await quarkRequestWithFallback<QuarkListResponse>(page, [
    {
      url: `${QUARK_DRIVE_ORIGIN}/1/clouddrive/file/sort`,
      method: 'GET',
      params: {
        pdir_fid: normalizeQuarkParentFileId(options.parentFileId),
        _page: options.pageNo ?? 1,
        _size: options.pageSize ?? QUARK_PAGE_SIZE,
        _fetch_total: 0,
        _fetch_sub_dirs: 0,
        fetch_dir_file_num: 1,
        _sort: (options.sort ?? []).join(','),
      },
    },
  ]);

  return Array.isArray(result.data?.list) ? result.data.list : [];
}

export async function quarkListDirectoryAll(
  page: IPage | null,
  options: {
    parentFileId: string;
    limit?: number;
    sort?: string[];
    consistencyRetries?: number;
    consistencyDelayMs?: number;
  },
): Promise<QuarkFileItem[]> {
  const limit = Number.isFinite(options.limit) ? Math.max(1, Number(options.limit)) : Number.POSITIVE_INFINITY;
  const consistencyRetries = Math.max(0, Number(options.consistencyRetries ?? 0));
  const consistencyDelayMs = Math.max(0, Number(options.consistencyDelayMs ?? 700));

  for (let attempt = 0; attempt <= consistencyRetries; attempt += 1) {
    const items: QuarkFileItem[] = [];
    let pageNo = 1;

    while (items.length < limit) {
      const pageItems = await quarkListDirectoryPage(page, {
        parentFileId: options.parentFileId,
        pageNo,
        pageSize: Math.min(QUARK_PAGE_SIZE, limit === Number.POSITIVE_INFINITY ? QUARK_PAGE_SIZE : limit - items.length),
        sort: options.sort,
      });

      items.push(...pageItems);
      if (pageItems.length < QUARK_PAGE_SIZE) break;
      pageNo += 1;
    }

    if (items.length > 0 || attempt >= consistencyRetries) {
      return items.slice(0, limit);
    }

    await sleep(consistencyDelayMs);
  }

  return [];
}

export async function quarkFindChildByName(
  page: IPage | null,
  parentFileId: string,
  childName: string,
  options?: {
    retryAttempts?: number;
    retryDelayMs?: number;
  },
): Promise<QuarkFileItem | null> {
  const retryAttempts = Math.max(0, Number(options?.retryAttempts ?? 0));
  const retryDelayMs = Math.max(0, Number(options?.retryDelayMs ?? 700));

  for (let attempt = 0; attempt <= retryAttempts; attempt += 1) {
    const items = await quarkListDirectoryAll(page, {
      parentFileId,
      sort: ['file_type:asc', 'file_name:asc'],
    });
    const matched = items.find(item => String(item.file_name ?? '') === childName) ?? null;
    if (matched || attempt >= retryAttempts) return matched;
    await sleep(retryDelayMs);
  }

  return null;
}

export async function quarkCreateFolder(
  page: IPage | null,
  options: {
    parentFileId: string;
    folderName: string;
  },
): Promise<{ item: QuarkFileItem; endpoint: string }> {
  const parentFileId = normalizeQuarkParentFileId(options.parentFileId);
  const folderName = String(options.folderName ?? '').trim();
  if (!folderName) throw new CommandExecutionError('Missing Quark folder name');

  const result = await quarkRequestWithFallback<QuarkFileItem>(page, [
    {
      url: `${QUARK_DRIVE_ORIGIN}/1/clouddrive/file`,
      body: {
        pdir_fid: parentFileId,
        file_name: folderName,
        dir_path: '',
        dir_init_lock: false,
      },
    },
  ]);

  const createdFileId = String(result.data?.fid ?? '').trim();
  const item = createdFileId
    ? await quarkGetFileInfo(page, createdFileId).catch(async () => quarkFindChildByName(page, parentFileId, folderName, {
      retryAttempts: 3,
      retryDelayMs: 700,
    }))
    : await quarkFindChildByName(page, parentFileId, folderName, {
      retryAttempts: 3,
      retryDelayMs: 700,
    });

  if (!item?.fid) {
    throw new CommandExecutionError(`Quark mkdir created "${folderName}" but it could not be resolved afterwards`);
  }
  if (normalizeQuarkFileType(item) !== 'folder') {
    throw new CommandExecutionError(`Quark mkdir returned a non-folder target for "${folderName}"`);
  }

  return {
    item,
    endpoint: result.endpoint,
  };
}

export function buildQuarkSort(orderBy: string, orderDirection: string): string[] {
  const direction = String(orderDirection ?? 'DESC').toLowerCase() === 'asc' ? 'asc' : 'desc';
  const field = String(orderBy ?? 'updated_at');
  switch (field) {
    case 'name':
      return [`file_name:${direction}`];
    case 'created_at':
      return ['file_type:asc', `created_at:${direction}`];
    case 'size':
      return ['file_type:asc', `size:${direction}`];
    case 'updated_at':
    default:
      return ['file_type:asc', `updated_at:${direction}`];
  }
}

export async function quarkResolvePath(
  page: IPage | null,
  pathValue: string,
  expectedType: 'all' | 'file' | 'folder' = 'all',
): Promise<QuarkResolvedNode> {
  const normalizedPath = normalizeQuarkPath(pathValue);
  if (normalizedPath === '/') {
    if (expectedType === 'file') {
      throw new CommandExecutionError('Path / is a folder, not a file');
    }
    return {
      path: '/',
      name: '/',
      type: 'folder',
      file_id: QUARK_ROOT_FID,
      parent_file_id: '',
      size: 0,
      updated_at: '',
      created_at: '',
      format_type: '',
    };
  }

  const segments = normalizedPath.split('/').map(segment => segment.trim()).filter(Boolean);
  let parentFileId = QUARK_ROOT_FID;
  let current: QuarkFileItem | null = null;
  let currentPath = '/';

  for (const segment of segments) {
    current = await quarkFindChildByName(page, parentFileId, segment, {
      retryAttempts: 3,
      retryDelayMs: 700,
    });
    if (!current?.fid) {
      throw new CommandExecutionError(`Quark path not found: ${normalizedPath}`);
    }
    currentPath = joinQuarkPath(currentPath, segment);
    parentFileId = String(current.fid);
  }

  const resolvedType = normalizeQuarkFileType(current);
  if (expectedType !== 'all' && resolvedType !== expectedType) {
    throw new CommandExecutionError(
      `Quark path type mismatch: expected ${expectedType}, got ${resolvedType} (${normalizedPath})`,
    );
  }

  return mapFileToResolvedNode(current!, currentPath);
}

export async function quarkDeleteFiles(page: IPage | null, fileIds: string[]): Promise<string> {
  const normalizedFileIds = fileIds.map(fileId => String(fileId ?? '').trim()).filter(Boolean);
  if (normalizedFileIds.length === 0) return `${QUARK_DRIVE_ORIGIN}/1/clouddrive/file/delete`;

  const result = await quarkRequestWithFallback<Record<string, unknown>>(page, [
    {
      url: `${QUARK_DRIVE_ORIGIN}/1/clouddrive/file/delete`,
      body: {
        action_type: 2,
        filelist: normalizedFileIds,
        exclude_fids: [],
        lock_concurr_op: 1,
      },
    },
  ]);

  return result.endpoint;
}

/* ── Share API ──────────────────────────────────────────────────── */

export type QuarkShareTokenResponse = {
  stoken?: string;
};

export type QuarkShareItem = {
  fid?: string;
  pdir_fid?: string;
  file_name?: string;
  file_type?: number;
  size?: number;
  share_fid_token?: string;
};

export type QuarkShareDetailResponse = {
  list?: QuarkShareItem[];
};

function ensureShareToken(value: string): string {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new CommandExecutionError('Quark share token response missing stoken');
  return normalized;
}

export async function getQuarkShareToken(
  page: Parameters<typeof quarkRequestWithFallback>[0],
  shareId: string,
  sharePwd: string,
): Promise<string> {
  const result = await quarkRequestWithFallback<QuarkShareTokenResponse>(page, [
    {
      url: `${QUARK_DRIVE_ORIGIN}/1/clouddrive/share/sharepage/token`,
      body: {
        pwd_id: shareId,
        passcode: sharePwd,
        support_visit_limit_private_share: true,
      },
    },
  ]);

  return ensureShareToken(result.data?.stoken ?? '');
}

export async function listShareChildrenPage(
  page: Parameters<typeof quarkRequestWithFallback>[0],
  options: {
    shareId: string;
    stoken: string;
    parentFid: string;
    pageNo?: number;
  },
): Promise<QuarkShareItem[]> {
  const result = await quarkRequestWithFallback<QuarkShareDetailResponse>(page, [
    {
      url: `${QUARK_DRIVE_ORIGIN}/1/clouddrive/share/sharepage/detail`,
      method: 'GET',
      params: {
        pwd_id: options.shareId,
        stoken: options.stoken,
        pdir_fid: options.parentFid,
        force: 0,
        _page: options.pageNo ?? 1,
        _size: 100,
        _fetch_banner: 0,
        _fetch_share: 1,
        _fetch_total: 0,
        fetch_update_flag: 1,
        support_visit_limit_private_share: true,
      },
    },
  ]);

  return Array.isArray(result.data?.list) ? result.data.list : [];
}

export async function listAllShareChildren(
  page: Parameters<typeof quarkRequestWithFallback>[0],
  options: {
    shareId: string;
    stoken: string;
    parentFid: string;
  },
): Promise<QuarkShareItem[]> {
  const items: QuarkShareItem[] = [];
  let pageNo = 1;

  for (;;) {
    const pageItems = await listShareChildrenPage(page, {
      ...options,
      pageNo,
    });
    items.push(...pageItems);
    if (pageItems.length < 100) break;
    pageNo += 1;
  }

  return items;
}
