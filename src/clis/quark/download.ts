import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
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

type QuarkResolvedDownloadUrl = {
  downloadUrl: string;
  endpoint: string;
  source: 'task' | 'direct';
};

type QuarkClientDeepLinkPushResponse = {
  success?: boolean;
  data?: {
    id?: string;
  };
  message?: string;
  msg?: string;
};

type QuarkClientDesktopInfoResponse = {
  success?: boolean;
  data?: {
    version?: string;
    isLogin?: boolean;
  };
  message?: string;
  msg?: string;
};

type QuarkClientDesktopCallerResponse = {
  success?: boolean;
  data?: {
    message?: string;
  };
  message?: string;
  msg?: string;
};

type QuarkDownloadAttempt = {
  label: string;
  cookies: string;
  headers?: Record<string, string>;
};

type QuarkClientDesktopInfo = {
  port: number;
  version: string;
  isLogin: boolean;
};

type QuarkClientHandoffResult = {
  port: number;
  version: string;
  rawActLink: string;
  callerLink: string;
};

const QUARK_WEB_DOWNLOAD_LIMIT_BYTES = 50 * 1024 * 1024;
const QUARK_CLIENT_LOCAL_HOST = 'http://127.0.0.1';
const QUARK_CLIENT_PORTS = [9125, 9126, 9127, 9128, 9129, 9130] as const;
const QUARK_CLIENT_DOWNLOAD_QUEUE_LIMIT = 50;
const QUARK_DEFAULT_OUTPUT_DIR = './quark-downloads';
const QUARK_CLIENT_DEFAULT_SAVE_PATH = '[Quark client download directory]';
const QUARK_CLIENT_MACOS_AUTOMATION_TIMEOUT_MS = 15000;
const QUARK_BROWSER_BUNDLE_ID = 'com.quark.desktop';
const QUARK_CLOUDDRIVE_BUNDLE_ID = 'com.alibaba.quark.clouddrive';
const QUARK_BROWSER_PREFERENCE_PATH = path.join(os.homedir(), 'Library', 'Application Support', 'Quark', 'preference.json');
const QUARK_CLOUDDRIVE_PREFERENCE_PATH = path.join(os.homedir(), 'Library', 'Application Support', 'quark-cloud-drive', 'preference.json');

type QuarkClientDownloadPreferenceState = {
  applied: boolean;
  preferencePath: string;
  restore: () => void;
};

export function expandHomeDirectory(rawPath: string): string {
  if (rawPath === '~') return os.homedir();
  if (rawPath.startsWith('~/')) return path.join(os.homedir(), rawPath.slice(2));
  return rawPath;
}

export function resolveQuarkOutputDirectory(rawPath: string): string {
  return path.resolve(expandHomeDirectory(String(rawPath ?? '').trim() || QUARK_DEFAULT_OUTPUT_DIR));
}

export function getQuarkClientBundleIdForPort(port: number): string {
  return port > 9127 ? QUARK_BROWSER_BUNDLE_ID : QUARK_CLOUDDRIVE_BUNDLE_ID;
}

export function getQuarkClientPreferencePathForPort(port: number): string {
  return port > 9127 ? QUARK_BROWSER_PREFERENCE_PATH : QUARK_CLOUDDRIVE_PREFERENCE_PATH;
}

export function buildQuarkClientSelectDirectoryAppleScript(bundleId: string): string[] {
  return [
    'on run argv',
    'set targetPath to item 1 of argv',
    'set targetPath to POSIX path of (POSIX file targetPath)',
    `tell application id "${bundleId}" to activate`,
    'delay 0.3',
    'set targetProcess to my waitForTargetProcess()',
    'tell application "System Events"',
    'repeat 50 times',
    'try',
    'set frontmost of targetProcess to true',
    'if frontmost of targetProcess then exit repeat',
    'end try',
    // Accept any browser/system confirmation dialog until Quark owns the frontmost window.
    'key code 36',
    'delay 0.2',
    'end repeat',
    'set downloadDialog to my waitForDownloadDialog(targetProcess)',
    'keystroke "g" using {command down, shift down}',
    'set goToFolderSheet to my waitForNestedSheet(downloadDialog)',
    'my setFirstTextFieldValue(goToFolderSheet, targetPath)',
    'my clickFirstButton(goToFolderSheet, {"前往", "Go"})',
    'my waitForNestedSheetToClose(downloadDialog)',
    'my clickFirstButton(downloadDialog, {"选取", "Choose", "打开", "Open", "保存", "Save"})',
    'end tell',
    'end run',
    '',
    'on waitForTargetProcess()',
    'tell application "System Events"',
    'repeat 75 times',
    'try',
    `return first application process whose bundle identifier is "${bundleId}"`,
    'end try',
    'delay 0.2',
    'end repeat',
    'end tell',
    'error "Timed out waiting for Quark client process"',
    'end waitForTargetProcess',
    '',
    'on waitForDownloadDialog(targetProcess)',
    'tell application "System Events"',
    'repeat 75 times',
    'try',
    'repeat with currentWindow in windows of targetProcess',
    'try',
    'if exists sheet 1 of currentWindow then return sheet 1 of currentWindow',
    'end try',
    'try',
    'if my hasAnyButton(currentWindow, {"选取", "Choose", "打开", "Open", "保存", "Save"}) then return currentWindow',
    'end try',
    'end repeat',
    'end try',
    'delay 0.2',
    'end repeat',
    'end tell',
    'error "Timed out waiting for Quark download dialog"',
    'end waitForDownloadDialog',
    '',
    'on waitForNestedSheet(container)',
    'tell application "System Events"',
    'repeat 50 times',
    'try',
    'if exists sheet 1 of container then return sheet 1 of container',
    'end try',
    'delay 0.1',
    'end repeat',
    'end tell',
    'error "Timed out waiting for the Go to Folder sheet"',
    'end waitForNestedSheet',
    '',
    'on waitForNestedSheetToClose(container)',
    'tell application "System Events"',
    'repeat 50 times',
    'try',
    'if not (exists sheet 1 of container) then return',
    'on error',
    'return',
    'end try',
    'delay 0.1',
    'end repeat',
    'end tell',
    'error "Timed out waiting for the Go to Folder sheet to close"',
    'end waitForNestedSheetToClose',
    '',
    'on setFirstTextFieldValue(container, targetValue)',
    'tell application "System Events"',
    'set fieldList to {}',
    'try',
    'set fieldList to text fields of entire contents of container',
    'end try',
    'repeat with currentField in fieldList',
    'try',
    'if enabled of currentField then',
    'set focused of currentField to true',
    'try',
    'set value of currentField to targetValue',
    'on error',
    'keystroke "a" using {command down}',
    'delay 0.05',
    'keystroke targetValue',
    'end try',
    'return',
    'end if',
    'end try',
    'end repeat',
    'end tell',
    'error "Unable to locate the folder path text field"',
    'end setFirstTextFieldValue',
    '',
    'on hasAnyButton(container, buttonNames)',
    'tell application "System Events"',
    'set buttonList to {}',
    'try',
    'set buttonList to buttons of entire contents of container',
    'end try',
    'repeat with desiredName in buttonNames',
    'set expectedName to contents of desiredName',
    'repeat with currentButton in buttonList',
    'try',
    'set buttonName to name of currentButton',
    'if buttonName is expectedName or buttonName contains expectedName then return true',
    'end try',
    'end repeat',
    'end repeat',
    'end tell',
    'return false',
    'end hasAnyButton',
    '',
    'on clickFirstButton(container, buttonNames)',
    'tell application "System Events"',
    'set buttonList to {}',
    'try',
    'set buttonList to buttons of entire contents of container',
    'end try',
    'repeat with desiredName in buttonNames',
    'set expectedName to contents of desiredName',
    'repeat with currentButton in buttonList',
    'try',
    'set buttonName to name of currentButton',
    'if buttonName is expectedName or buttonName contains expectedName then',
    'click currentButton',
    'return',
    'end if',
    'end try',
    'end repeat',
    'end repeat',
    'end tell',
    'error "Unable to find a matching button in the Quark download dialog"',
    'end clickFirstButton',
  ];
}

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

async function resolveDownloadCandidates(
  page: Parameters<typeof quarkRequestWithFallback>[0],
  fileId: string,
): Promise<{ candidates: QuarkResolvedDownloadUrl[]; errors: string[] }> {
  const candidates: QuarkResolvedDownloadUrl[] = [];
  const errors: string[] = [];

  try {
    const directInfo = await requestDirectDownloadInfo(page, fileId);
    const directUrl = String(directInfo.item?.download_url ?? '').trim();
    if (directUrl) {
      candidates.push({
        downloadUrl: directUrl,
        endpoint: directInfo.endpoint,
        source: 'direct',
      });
    } else {
      errors.push('direct: missing download_url');
    }
  } catch (error) {
    errors.push(`direct: ${getErrorMessage(error)}`);
  }

  try {
    const taskResult = await requestTaskDownloadUrl(page, fileId);
    candidates.push({
      downloadUrl: taskResult.downloadUrl,
      endpoint: taskResult.endpoint,
      source: 'task',
    });
  } catch (error) {
    errors.push(`task: ${getErrorMessage(error)}`);
  }

  if (candidates.length === 0) {
    throw new CommandExecutionError(`Unable to resolve Quark download URL: ${errors.join(' | ')}`);
  }

  return { candidates, errors };
}

function parseContentRangeTotal(contentRange: string | null | undefined): number {
  const match = String(contentRange ?? '').match(/\/(\d+)\s*$/);
  if (!match) return 0;
  const total = Number(match[1]);
  return Number.isFinite(total) && total > 0 ? total : 0;
}

function matchesExpectedDownloadSize(receivedSize: number, expectedSize: number): boolean {
  return !Number.isFinite(expectedSize) || expectedSize <= 0 || receivedSize === expectedSize;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getQuarkClientMessage(value: unknown): string {
  if (!isRecord(value)) return '';
  const raw = value.message ?? value.msg ?? value.error;
  return typeof raw === 'string' ? raw.trim() : '';
}

async function fetchJsonWithTimeout<T>(url: string, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
    });
    const text = await response.text();

    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = text;
    }

    if (!response.ok) {
      throw new CommandExecutionError(`HTTP ${response.status} ${String(text).slice(0, 240)}`.trim());
    }
    return body as T;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new CommandExecutionError(`Request timed out: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function isQuarkWebDownloadSizeLimited(size: number): boolean {
  return Number.isFinite(size) && size > QUARK_WEB_DOWNLOAD_LIMIT_BYTES;
}

export function trimQuarkClientDownloadList(fileIds: string[]): string[] {
  return fileIds
    .map((fileId) => String(fileId ?? '').trim())
    .filter(Boolean)
    .slice(0, QUARK_CLIENT_DOWNLOAD_QUEUE_LIMIT);
}

export function buildQuarkClientDownloadRawActLink(
  downloadId: string,
  options: {
    scheme?: 'clouddrive' | 'browser';
    from?: string;
    shareDn?: string;
  } = {},
): string {
  const normalizedId = String(downloadId ?? '').trim();
  if (!normalizedId) throw new CommandExecutionError('Missing Quark client download id');

  const params = new URLSearchParams({ id: normalizedId });
  if (options.from) params.set('from', String(options.from));
  if (options.shareDn) params.set('share_dn', String(options.shareDn));

  const scheme = options.scheme === 'browser' ? 'qklink://' : 'qkclouddrive://';
  return `${scheme}download?${params.toString()}`;
}

export function normalizeQuarkClientActLinkForPort(rawActLink: string, port: number): string {
  if (port > 9127 && rawActLink.startsWith('qkclouddrive://')) {
    return rawActLink.replace('qkclouddrive://', 'qklink://');
  }
  return rawActLink;
}

async function requestQuarkClientDownloadId(
  page: Parameters<typeof quarkRequestWithFallback>[0],
  fileIds: string[],
): Promise<string> {
  if (!page) throw new CommandExecutionError('Browser page required for Quark client handoff');

  const normalizedFileIds = trimQuarkClientDownloadList(fileIds);
  if (normalizedFileIds.length === 0) {
    throw new CommandExecutionError('Quark client handoff requires at least one file_id');
  }

  const result = await page.evaluate(`
    async () => {
      const fileIds = ${JSON.stringify(normalizedFileIds)};
      const cookieMatch = document.cookie.match(/(?:^|; )ctoken=([^;]+)/);
      const ctoken = cookieMatch ? decodeURIComponent(cookieMatch[1]) : '';

      const response = await fetch('/api/deeplink/push', {
        method: 'POST',
        credentials: 'include',
        headers: {
          Accept: 'application/json, text/plain, */*',
          'Content-Type': 'application/json',
          ...(ctoken ? { 'x-csrf-token': ctoken } : {}),
        },
        body: JSON.stringify({
          action: 'download',
          payload: {
            list: fileIds,
          },
        }),
      });

      const text = await response.text();
      let body = text;
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = text;
      }

      return {
        ok: response.ok,
        status: response.status,
        body,
        text: typeof text === 'string' ? text.slice(0, 240) : '',
      };
    }
  `) as {
    ok: boolean;
    status: number;
    body: unknown;
    text: string;
  };

  if (!result.ok) {
    throw new CommandExecutionError(`Quark client deeplink push failed: HTTP ${result.status} ${result.text}`.trim());
  }

  const body = isRecord(result.body) ? result.body as QuarkClientDeepLinkPushResponse : {};
  const pushedId = String(body.data?.id ?? '').trim();
  if (!pushedId) {
    throw new CommandExecutionError(`Quark client deeplink push returned no download id: ${getQuarkClientMessage(body) || result.text || 'unknown response'}`);
  }

  return pushedId;
}

async function discoverQuarkClientDesktopInfo(): Promise<QuarkClientDesktopInfo | null> {
  for (const port of QUARK_CLIENT_PORTS) {
    try {
      const body = await fetchJsonWithTimeout<QuarkClientDesktopInfoResponse>(
        `${QUARK_CLIENT_LOCAL_HOST}:${port}/desktop_info`,
        800,
      );
      if (!body?.success) continue;
      return {
        port,
        version: String(body.data?.version ?? '').trim(),
        isLogin: Boolean(body.data?.isLogin),
      };
    } catch {
      // Try the next known client port.
    }
  }
  return null;
}

async function handoffQuarkDownloadToClient(
  page: Parameters<typeof quarkRequestWithFallback>[0],
  fileIds: string[],
): Promise<QuarkClientHandoffResult> {
  const clientDownloadId = await requestQuarkClientDownloadId(page, fileIds);
  const desktopInfo = await discoverQuarkClientDesktopInfo();
  if (!desktopInfo) {
    throw new CommandExecutionError('Quark client local service is unavailable');
  }
  if (!desktopInfo.isLogin) {
    throw new CommandExecutionError('Quark client is installed but not logged in');
  }

  const rawActLink = buildQuarkClientDownloadRawActLink(clientDownloadId);
  const callerLink = normalizeQuarkClientActLinkForPort(rawActLink, desktopInfo.port);
  const callerResponse = await fetchJsonWithTimeout<QuarkClientDesktopCallerResponse>(
    `${QUARK_CLIENT_LOCAL_HOST}:${desktopInfo.port}/desktop_caller?deeplink=${encodeURIComponent(callerLink)}`,
    1500,
  );

  if (!callerResponse?.success) {
    throw new CommandExecutionError(`Quark client handoff failed: ${getQuarkClientMessage(callerResponse) || 'desktop_caller returned an error'}`);
  }

  return {
    port: desktopInfo.port,
    version: desktopInfo.version,
    rawActLink,
    callerLink,
  };
}

function automateQuarkClientOutputDirectorySelection(outputDir: string, port: number): string {
  const resolvedOutputDir = resolveQuarkOutputDirectory(outputDir);
  fs.mkdirSync(resolvedOutputDir, { recursive: true });

  const bundleId = getQuarkClientBundleIdForPort(port);
  const script = buildQuarkClientSelectDirectoryAppleScript(bundleId);
  const args = script.flatMap(line => ['-e', line]).concat(['--', resolvedOutputDir]);

  try {
    execFileSync('osascript', args, {
      stdio: 'ignore',
      timeout: QUARK_CLIENT_MACOS_AUTOMATION_TIMEOUT_MS,
    });
  } catch (error) {
    throw new CommandExecutionError(
      `Quark client accepted the download, but opencli could not select the requested folder automatically. ` +
      `Grant Accessibility permissions to your terminal in macOS Settings > Privacy & Security > Accessibility, ` +
      `then try again. Requested folder: ${resolvedOutputDir}. ${getErrorMessage(error)}`,
    );
  }

  return resolvedOutputDir;
}

function configureQuarkClientDownloadDirectory(outputDir: string, port: number): QuarkClientDownloadPreferenceState {
  const resolvedOutputDir = resolveQuarkOutputDirectory(outputDir);
  const preferencePath = getQuarkClientPreferencePathForPort(port);
  const original = fs.readFileSync(preferencePath, 'utf8');

  let parsed: unknown;
  try {
    parsed = JSON.parse(original);
  } catch (error) {
    throw new CommandExecutionError(`Failed to parse Quark preference file ${preferencePath}: ${getErrorMessage(error)}`);
  }

  if (!isRecord(parsed)) {
    throw new CommandExecutionError(`Unexpected Quark preference format: ${preferencePath}`);
  }

  const globalSettingKey = 'global:setting';
  const globalSetting = parsed[globalSettingKey];
  if (!isRecord(globalSetting)) {
    throw new CommandExecutionError(`Quark preference file is missing "${globalSettingKey}": ${preferencePath}`);
  }

  const downloadPosition = globalSetting.downloadPosition;
  if (!isRecord(downloadPosition)) {
    throw new CommandExecutionError(`Quark preference file is missing downloadPosition: ${preferencePath}`);
  }

  const alreadyConfigured = String(downloadPosition.where ?? '').trim() === resolvedOutputDir
    && downloadPosition.enable === true
    && (!('lastSavePath' in downloadPosition) || String(downloadPosition.lastSavePath ?? '').trim() === resolvedOutputDir);

  if (!alreadyConfigured) {
    downloadPosition.where = resolvedOutputDir;
    downloadPosition.enable = true;
    if ('lastSavePath' in downloadPosition || port > 9127) {
      downloadPosition.lastSavePath = resolvedOutputDir;
    }
    fs.mkdirSync(path.dirname(preferencePath), { recursive: true });
    fs.writeFileSync(preferencePath, JSON.stringify(parsed, null, 2), 'utf8');
  }

  return {
    applied: !alreadyConfigured,
    preferencePath,
    restore: () => {
      if (!alreadyConfigured) {
        fs.writeFileSync(preferencePath, original, 'utf8');
      }
    },
  };
}

async function fetchBrowserDownloadChunk(
  page: Parameters<typeof quarkRequestWithFallback>[0],
  url: string,
  rangeHeader: string,
): Promise<{
  status: number;
  contentLength: string | null;
  contentRange: string | null;
  bodyBase64: string;
  errorText: string;
}> {
  if (!page) throw new CommandExecutionError('Browser page required for Quark download');
  return page.evaluate(`
    async () => {
      const url = ${JSON.stringify(url)};
      const rangeHeader = ${JSON.stringify(rangeHeader)};

      function toBase64(bytes) {
        let binary = '';
        const chunkSize = 0x8000;
        for (let index = 0; index < bytes.length; index += chunkSize) {
          binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
        }
        return btoa(binary);
      }

      const response = await fetch(url, {
        credentials: 'include',
        headers: rangeHeader ? { Range: rangeHeader } : {},
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
      return {
        status: response.status,
        contentLength: response.headers.get('content-length'),
        contentRange: response.headers.get('content-range'),
        bodyBase64: toBase64(bytes),
        errorText: response.ok ? '' : new TextDecoder().decode(bytes),
      };
    }
  `) as Promise<{
    status: number;
    contentLength: string | null;
    contentRange: string | null;
    bodyBase64: string;
    errorText: string;
  }>;
}

async function browserDownloadDirect(
  page: Parameters<typeof quarkRequestWithFallback>[0],
  url: string,
  savePath: string,
  options: {
    expectedSize: number;
    onProgress?: (received: number, total: number) => void;
    chunkSize?: number;
  },
): Promise<{ success: boolean; size: number; error?: string }> {
  const chunkSize = Math.max(64 * 1024, Number(options.chunkSize ?? 1024 * 1024));
  const tempPath = `${savePath}.tmp`;
  let received = 0;
  let total = Number.isFinite(options.expectedSize) && options.expectedSize > 0 ? options.expectedSize : 0;

  try {
    await fs.promises.mkdir(path.dirname(savePath), { recursive: true });
    await fs.promises.rm(tempPath, { force: true });

    while (true) {
      const end = total > 0 ? Math.min(received + chunkSize - 1, total - 1) : received + chunkSize - 1;
      const chunk = await fetchBrowserDownloadChunk(page, url, `bytes=${received}-${end}`);
      if (chunk.status !== 200 && chunk.status !== 206) {
        throw new CommandExecutionError(`HTTP ${chunk.status}${chunk.errorText ? ` ${chunk.errorText}` : ''}`.trim());
      }

      const buffer = Buffer.from(chunk.bodyBase64, 'base64');
      if (buffer.length === 0) {
        throw new CommandExecutionError('Browser download returned an empty response body');
      }

      await fs.promises.appendFile(tempPath, buffer);
      received += buffer.length;

      const parsedTotal = parseContentRangeTotal(chunk.contentRange);
      if (parsedTotal > 0) total = parsedTotal;
      options.onProgress?.(received, total || received);

      if (chunk.status === 200 || (total > 0 && received >= total)) break;
    }

    if (!matchesExpectedDownloadSize(received, total || options.expectedSize)) {
      throw new CommandExecutionError(`size mismatch: expected ${total || options.expectedSize}, received ${received}`);
    }

    await fs.promises.rename(tempPath, savePath);
    return { success: true, size: received };
  } catch (error) {
    try {
      await fs.promises.rm(tempPath, { force: true });
    } catch {
      // Ignore temp cleanup failures.
    }
    return {
      success: false,
      size: received,
      error: getErrorMessage(error),
    };
  }
}

async function downloadCandidateWithHttp(
  candidate: QuarkResolvedDownloadUrl,
  savePath: string,
  expectedSize: number,
  cookieHeader: string,
  timeout: number,
  onProgress: (received: number, total: number) => void,
): Promise<{ success: boolean; size: number; error?: string }> {
  const attempts: QuarkDownloadAttempt[] = [
    { label: `${candidate.source}-plain`, cookies: '' },
    {
      label: `${candidate.source}-origin`,
      cookies: '',
      headers: {
        Referer: `${QUARK_WEB_ORIGIN}/`,
        Origin: QUARK_WEB_ORIGIN,
      },
    },
    ...(cookieHeader
      ? [
        { label: `${candidate.source}-cookies`, cookies: cookieHeader },
        {
          label: `${candidate.source}-origin+cookies`,
          cookies: cookieHeader,
          headers: {
            Referer: `${QUARK_WEB_ORIGIN}/`,
            Origin: QUARK_WEB_ORIGIN,
          },
        },
      ]
      : []),
  ];

  const errors: string[] = [];
  for (const attempt of attempts) {
    const result = await httpDownload(candidate.downloadUrl, savePath, {
      cookies: attempt.cookies || undefined,
      timeout,
      headers: attempt.headers,
      onProgress,
    });
    if (!result.success) {
      errors.push(`${attempt.label}: ${result.error ?? 'unknown error'}`);
      continue;
    }
    if (!matchesExpectedDownloadSize(result.size, expectedSize)) {
      try {
        fs.rmSync(savePath, { force: true });
      } catch {
        // Ignore cleanup failures for invalid downloads.
      }
      errors.push(`${attempt.label}: size mismatch (expected ${expectedSize}, received ${result.size})`);
      continue;
    }
    return result;
  }

  return {
    success: false,
    size: 0,
    error: errors.join(' | ') || 'unknown error',
  };
}

async function downloadCandidate(
  page: Parameters<typeof quarkRequestWithFallback>[0],
  candidate: QuarkResolvedDownloadUrl,
  savePath: string,
  expectedSize: number,
  cookieHeader: string,
  timeout: number,
  onProgress: (received: number, total: number) => void,
): Promise<{ success: boolean; size: number; error?: string }> {
  const httpResult = await downloadCandidateWithHttp(candidate, savePath, expectedSize, cookieHeader, timeout, onProgress);
  if (httpResult.success) return httpResult;

  const browserResult = await browserDownloadDirect(page, candidate.downloadUrl, savePath, {
    expectedSize,
    onProgress,
  });
  if (browserResult.success) return browserResult;

  return {
    success: false,
    size: 0,
    error: `${httpResult.error ?? 'http download failed'} | browser-direct: ${browserResult.error ?? 'unknown error'}`,
  };
}

function maskCandidate(candidate: QuarkResolvedDownloadUrl): string {
  return `${candidate.source}:${maskUrl(candidate.downloadUrl)}`;
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
    const outputDir = resolveQuarkOutputDirectory(String(kwargs.output ?? './quark-downloads'));
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

    const originalName = String(detail.file_name ?? resolved?.name ?? '').trim() || `${fileId}.bin`;
    const sourceName = nameArg || originalName;
    const safeName = sanitizeFilename(sourceName) || `quark_${fileId}.bin`;
    const savePath = path.resolve(outputDir, safeName);
    const expectedSize = Number(detail.size ?? 0);
    const exceedsWebLimit = isQuarkWebDownloadSizeLimited(expectedSize);

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

    let candidates: QuarkResolvedDownloadUrl[] = [];
    let candidateErrors: string[] = [];
    let candidateResolveError = '';
    try {
      const resolvedCandidates = await resolveDownloadCandidates(page, fileId);
      candidates = resolvedCandidates.candidates;
      candidateErrors = resolvedCandidates.errors;
    } catch (error) {
      candidateResolveError = getErrorMessage(error);
    }

    let cookieHeader = '';
    let cookieWarning = '';
    try {
      cookieHeader = await collectQuarkCookieHeader(page);
    } catch (error) {
      cookieWarning = getErrorMessage(error);
    }

    const progressBar = showProgress ? createProgressBar(safeName, 0, 1) : null;
    let downloadResult: { success: boolean; size: number; error?: string } | null = null;
    let successfulCandidate: QuarkResolvedDownloadUrl | null = null;
    const downloadErrors: string[] = [];
    for (const candidate of candidates) {
      const result = await downloadCandidate(
        page,
        candidate,
        savePath,
        expectedSize,
        cookieHeader,
        timeout,
        (received, total) => {
          progressBar?.update(received, total);
        },
      );
      if (result.success) {
        downloadResult = result;
        successfulCandidate = candidate;
        break;
      }
      downloadErrors.push(`${maskCandidate(candidate)} -> ${result.error ?? 'unknown error'}`);
    }

    if (!downloadResult?.success && exceedsWebLimit) {
      const localErrors = downloadErrors.length > 0 ? ` Local download attempts failed first: ${downloadErrors.join(' | ')}` : '';
      const resolveErrors = candidateResolveError
        ? ` Resolve error: ${candidateResolveError}`
        : candidateErrors.length > 0
          ? ` Resolve notes: ${candidateErrors.join(' | ')}`
          : '';

      if (nameArg) {
        throw new CommandExecutionError(
          `Direct Quark download failed, and Quark client downloads larger than 50 MB do not support --name yet. Please omit --name.${localErrors}${resolveErrors}`,
        );
      }

      let preferenceState: QuarkClientDownloadPreferenceState | null = null;
      let preferenceSetupError = '';
      if (process.platform === 'darwin') {
        const desktopInfo = await discoverQuarkClientDesktopInfo().catch(() => null);
        if (desktopInfo) {
          try {
            preferenceState = configureQuarkClientDownloadDirectory(outputDir, desktopInfo.port);
          } catch (error) {
            preferenceSetupError = getErrorMessage(error);
          }
        } else {
          preferenceSetupError = 'Quark client local service is unavailable';
        }
      }

      const handoff = await handoffQuarkDownloadToClient(page, [fileId]).catch((error) => {
        try {
          preferenceState?.restore();
        } catch {
          // Ignore preference restore failures when the client handoff itself did not start.
        }
        throw new CommandExecutionError(
          `Quark direct download failed for a ${expectedSize}-byte file, and automatic client handoff also failed: ${getErrorMessage(error)}.${localErrors}${resolveErrors}`,
        );
      });
      let savedTo = QUARK_CLIENT_DEFAULT_SAVE_PATH;
      if (process.platform === 'darwin') {
        try {
          if (preferenceState) {
            await new Promise(resolve => setTimeout(resolve, 1200));
            savedTo = path.join(outputDir, safeName);
          } else {
            const clientOutputDir = automateQuarkClientOutputDirectorySelection(outputDir, handoff.port);
            savedTo = path.join(clientOutputDir, safeName);
          }
        } catch (error) {
          const preferenceSuffix = preferenceSetupError ? ` Preference setup failed before fallback: ${preferenceSetupError}.` : '';
          throw new CommandExecutionError(`${getErrorMessage(error)}.${preferenceSuffix}${localErrors}${resolveErrors}`);
        }
      } else if (outputDir !== resolveQuarkOutputDirectory(QUARK_DEFAULT_OUTPUT_DIR)) {
        throw new CommandExecutionError(
          `Quark large-file downloads can only respect --output on macOS right now. Requested folder: ${outputDir}`,
        );
      }

      return [{
        status: 'queued_in_client',
        file_id: fileId,
        path: pathArg || '',
        name: safeName,
        size: expectedSize,
        saved_to: savedTo,
        endpoint: `${QUARK_CLIENT_LOCAL_HOST}:${handoff.port}/desktop_caller`,
      }];
    }

    if (!downloadResult?.success) {
      const masked = candidates.map(maskCandidate).join(', ');
      const candidateSuffix = candidateResolveError
        ? ` | resolve: ${candidateResolveError}`
        : candidateErrors.length > 0
          ? ` | resolve: ${candidateErrors.join(' | ')}`
          : '';
      const suffix = cookieWarning ? ` | cookie fallback unavailable: ${cookieWarning}` : '';
      throw new CommandExecutionError(`Quark download failed: ${masked} -> ${downloadErrors.join(' | ') || 'unknown error'}${candidateSuffix}${suffix}`);
    }

    progressBar?.complete(true);

    return [{
      status: 'success',
      file_id: fileId,
      path: pathArg || '',
      name: safeName,
      size: Number(detail.size ?? downloadResult.size ?? 0),
      saved_to: savePath,
      endpoint: successfulCandidate?.endpoint ?? '',
    }];
  },
});
