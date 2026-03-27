import { formatCookieHeader } from '../../download/index.js';
import { AuthRequiredError, CommandExecutionError, getErrorMessage } from '../../errors.js';
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

type QuarkResponseEnvelope<T> = {
  code?: number | string;
  success?: boolean;
  status?: number;
  message?: string;
  msg?: string;
  data?: T;
  metadata?: Record<string, unknown>;
};

type QuarkRequestResult<T> = {
  data: T;
  raw: unknown;
  metadata: Record<string, unknown>;
  endpoint: string;
  status: number;
};

type QuarkListResponse = {
  list?: QuarkFileItem[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getMessage(value: unknown): string {
  if (!isRecord(value)) return '';
  const message = value.message ?? value.msg ?? value.error_message ?? value.error;
  return typeof message === 'string' ? message.trim() : '';
}

function isSuccessEnvelope(body: unknown): boolean {
  if (!isRecord(body)) return true;
  if ('success' in body) return body.success === true;
  if ('code' in body) {
    return body.code === 0 || body.code === '0' || body.code === 'OK';
  }
  return true;
}

function extractEnvelopeData<T>(body: unknown): { data: T; metadata: Record<string, unknown> } {
  if (isRecord(body) && ('data' in body || 'metadata' in body)) {
    const data = ('data' in body ? body.data : body) as T;
    const metadata = isRecord(body.metadata) ? body.metadata : {};
    return { data, metadata };
  }
  return { data: body as T, metadata: {} };
}

function isAuthFailure(status: number, body: unknown): boolean {
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

function mapFileToResolvedNode(item: QuarkFileItem, resolvedPath: string): QuarkResolvedNode {
  return {
    path: resolvedPath,
    name: String(item.file_name ?? ''),
    type: normalizeQuarkFileType(item),
    file_id: String(item.fid ?? ''),
    parent_file_id: String(item.pdir_fid ?? ''),
    size: Number(item.size ?? 0),
    updated_at: String(item.updated_at ?? ''),
    created_at: String(item.created_at ?? ''),
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

export async function quarkRequestWithFallback<T>(
  page: IPage | null,
  requests: QuarkRequest[],
): Promise<QuarkRequestResult<T>> {
  if (!Array.isArray(requests) || requests.length === 0) {
    throw new CommandExecutionError('Quark request list is empty');
  }

  const cookieHeader = await collectQuarkCookieHeader(page);
  let lastStatus = 0;
  let lastEndpoint = '';
  let lastBody: unknown = null;
  let lastErrorMessage = '';

  for (const request of requests) {
    const method = String(request.method ?? 'POST').toUpperCase();
    const endpoint = buildUrl(request.url, request.params, request.injectDefaultParams !== false);
    lastEndpoint = endpoint;
    try {
      const headers: Record<string, string> = {
        Accept: 'application/json, text/plain, */*',
        Cookie: cookieHeader,
        Referer: `${QUARK_WEB_ORIGIN}/`,
        Origin: QUARK_WEB_ORIGIN,
        ...(request.headers ?? {}),
      };

      let body: string | undefined;
      if (method !== 'GET' && request.body !== undefined) {
        if (!Object.keys(headers).some(key => key.toLowerCase() === 'content-type')) {
          headers['Content-Type'] = 'application/json';
        }
        body = headers['Content-Type']?.includes('application/json')
          ? JSON.stringify(request.body)
          : String(request.body);
      }

      const response = await fetch(endpoint, {
        method,
        headers,
        body,
      });
      lastStatus = response.status;

      const text = await response.text();
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        parsed = text;
      }
      lastBody = parsed;

      if (response.ok && isSuccessEnvelope(parsed)) {
        const extracted = extractEnvelopeData<T>(parsed);
        return {
          data: extracted.data,
          raw: parsed,
          metadata: extracted.metadata,
          endpoint,
          status: response.status,
        };
      }

      lastErrorMessage = getMessage(parsed) || text.slice(0, 240);
      if (isAuthFailure(response.status, parsed)) {
        throw new AuthRequiredError('pan.quark.cn', lastErrorMessage || 'Quark login expired. Please re-login in Chrome.');
      }
    } catch (error) {
      if (error instanceof AuthRequiredError) throw error;
      lastErrorMessage = getErrorMessage(error);
    }
  }

  if (isAuthFailure(lastStatus, lastBody)) {
    throw new AuthRequiredError('pan.quark.cn', lastErrorMessage || 'Quark login expired. Please re-login in Chrome.');
  }

  throw new CommandExecutionError(
    `Quark API failed: HTTP ${lastStatus || '?'} ${lastErrorMessage || 'Unknown error'} (${lastEndpoint})`,
  );
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
  },
): Promise<QuarkFileItem[]> {
  const limit = Number.isFinite(options.limit) ? Math.max(1, Number(options.limit)) : Number.POSITIVE_INFINITY;
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

  return items.slice(0, limit);
}

export async function quarkFindChildByName(
  page: IPage | null,
  parentFileId: string,
  childName: string,
): Promise<QuarkFileItem | null> {
  const items = await quarkListDirectoryAll(page, {
    parentFileId,
    sort: ['file_type:asc', 'file_name:asc'],
  });
  return items.find(item => String(item.file_name ?? '') === childName) ?? null;
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
    ? await quarkGetFileInfo(page, createdFileId).catch(async () => quarkFindChildByName(page, parentFileId, folderName))
    : await quarkFindChildByName(page, parentFileId, folderName);

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
    current = await quarkFindChildByName(page, parentFileId, segment);
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
