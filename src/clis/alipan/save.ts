import { CommandExecutionError } from '../../errors.js';
import { cli, Strategy } from '../../registry.js';
import { alipanResolvePath, alipanPostWithFallback } from './utils.js';
import { normalizeAliPanSharePath, parseAliPanShareReference } from './save-shared.js';

type AliPanShareTokenResponse = {
  share_token?: string;
};

type AliPanShareListItem = {
  file_id?: string;
  name?: string;
  type?: string;
  size?: number;
  parent_file_id?: string;
};

type AliPanShareListResponse = {
  items?: AliPanShareListItem[];
  next_marker?: string;
};

type AliPanBatchResponseItem = {
  id?: string;
  status?: number;
  body?: {
    code?: string;
    message?: string;
    async_task_id?: string;
    state?: string;
    punished_file_count?: number;
  };
};

type AliPanBatchResponse = {
  responses?: AliPanBatchResponseItem[];
};

type AliPanAuthContext = {
  driveId: string;
};

type SelectedShareItem = {
  fileId: string;
  name: string;
  type: string;
};

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getAliPanDriveContext(page: { evaluate(js: string): Promise<unknown> }): Promise<AliPanAuthContext> {
  const result = await page.evaluate(`
    (() => {
      const raw = localStorage.getItem('token') || '';
      let token = {};
      try { token = JSON.parse(raw || '{}'); } catch {}
      return {
        driveId: token.default_drive_id || token.default_sbox_drive_id || '',
      };
    })()
  `) as AliPanAuthContext;

  if (!result?.driveId) {
    throw new CommandExecutionError('Missing AliPan drive id. Please log in to AliPan in Chrome.');
  }

  return result;
}

async function getShareToken(
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

async function listShareChildren(
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

async function listAllShareChildren(
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
    const listed = await listShareChildren(page, { ...options, marker });
    items.push(...(Array.isArray(listed.items) ? listed.items : []));
    marker = String(listed.next_marker ?? '').trim();
  } while (marker);

  return items;
}

async function resolveSharePath(
  page: Parameters<typeof alipanPostWithFallback>[0],
  options: {
    shareId: string;
    shareToken: string;
    sourcePath: string;
  },
): Promise<SelectedShareItem> {
  const normalizedPath = normalizeAliPanSharePath(options.sourcePath);
  const segments = normalizedPath.split('/').map(segment => segment.trim()).filter(Boolean);
  if (segments.length === 0) {
    throw new CommandExecutionError('Source path must point to a file or folder inside the share');
  }

  let parentFileId = 'root';
  let found: AliPanShareListItem | null = null;

  for (const segment of segments) {
    const children = await listAllShareChildren(page, {
      shareId: options.shareId,
      shareToken: options.shareToken,
      parentFileId,
    });
    found = children.find(item => String(item.name ?? '') === segment) ?? null;
    if (!found?.file_id) {
      throw new CommandExecutionError(`Share path not found: ${normalizedPath}`);
    }
    parentFileId = found.file_id;
  }

  return {
    fileId: String(found?.file_id ?? ''),
    name: String(found?.name ?? ''),
    type: String(found?.type ?? ''),
  };
}

async function batchCopyShareFiles(
  page: Parameters<typeof alipanPostWithFallback>[0],
  options: {
    shareId: string;
    shareToken: string;
    fileIds: string[];
    toDriveId: string;
    toParentFileId: string;
    overwrite: boolean;
  },
): Promise<AliPanBatchResponse> {
  const requests = options.fileIds.map((fileId, index) => ({
    body: {
      file_id: fileId,
      share_id: options.shareId,
      auto_rename: !options.overwrite,
      overwrite: options.overwrite,
      to_parent_file_id: options.toParentFileId,
      to_drive_id: options.toDriveId,
    },
    headers: { 'Content-Type': 'application/json' },
    id: String(index),
    method: 'POST',
    url: '/file/copy',
  }));

  const result = await alipanPostWithFallback<AliPanBatchResponse>(page, [
    {
      url: 'https://api.aliyundrive.com/adrive/v4/batch',
      body: {
        requests,
        resource: 'file',
      },
      injectDriveId: false,
      injectShareToken: true,
      shareToken: options.shareToken,
    },
  ]);

  return result.data || {};
}

async function pollAsyncTasks(
  page: Parameters<typeof alipanPostWithFallback>[0],
  options: {
    shareToken: string;
    asyncTaskIds: string[];
  },
): Promise<AliPanBatchResponseItem[]> {
  const maxPolls = 60;
  for (let attempt = 0; attempt < maxPolls; attempt++) {
    const result = await alipanPostWithFallback<AliPanBatchResponse>(page, [
      {
        url: 'https://api.aliyundrive.com/adrive/v4/batch',
        body: {
          requests: options.asyncTaskIds.map(asyncTaskId => ({
            body: { async_task_id: asyncTaskId },
            headers: { 'Content-Type': 'application/json' },
            id: asyncTaskId,
            method: 'POST',
            url: '/async_task/get',
          })),
          resource: 'file',
        },
        injectDriveId: false,
        injectShareToken: true,
        shareToken: options.shareToken,
      },
    ]);

    const responses = Array.isArray(result.data?.responses) ? result.data.responses : [];
    const running = responses.filter(item => item?.body?.state === 'Running');
    if (running.length === 0) return responses;
    await delay(2000);
  }

  throw new CommandExecutionError('AliPan save task polling timed out');
}

cli({
  site: 'alipan',
  name: 'save',
  description: 'Save files from an AliPan share link to your drive',
  domain: 'www.alipan.com',
  strategy: Strategy.HEADER,
  browser: true,
  navigateBefore: false,
  timeoutSeconds: 300,
  args: [
    { name: 'share', required: true, positional: true, help: 'AliPan share link or share_id' },
    { name: 'share-pwd', default: '', help: 'Share password / extraction code' },
    { name: 'source-path', default: '', help: 'Path inside the share to save, e.g. /Movies/demo.mp4' },
    { name: 'to-parent-file-id', default: 'root', help: 'Destination parent folder file_id' },
    { name: 'to-path', default: '', help: 'Destination folder path from root (overrides --to-parent-file-id)' },
    { name: 'overwrite', type: 'boolean', default: false, help: 'Overwrite same-name files instead of auto-renaming' },
  ],
  columns: ['status', 'share_id', 'source', 'saved_count', 'failed_count', 'to_path', 'to_parent_file_id', 'endpoint'],
  func: async (page, kwargs) => {
    if (!page) throw new CommandExecutionError('Browser page required for alipan save');

    const shareInput = String(kwargs.share ?? '').trim();
    const sharePwdArg = String(kwargs['share-pwd'] ?? '').trim();
    const sourcePathArg = String(kwargs['source-path'] ?? '').trim();
    const toPathArg = String(kwargs['to-path'] ?? '').trim();
    const toParentFileIdArg = String(kwargs['to-parent-file-id'] ?? 'root').trim() || 'root';
    const overwrite = Boolean(kwargs.overwrite);

    const shareRef = parseAliPanShareReference(shareInput, sharePwdArg);

    await page.goto('https://www.alipan.com/drive/home');
    await page.wait(1);

    const driveContext = await getAliPanDriveContext(page);
    const destination = toPathArg
      ? await alipanResolvePath(page, toPathArg, 'folder')
      : null;
    const toParentFileId = destination?.file_id ?? toParentFileIdArg;

    const shareToken = await getShareToken(page, shareRef.shareId, shareRef.sharePwd);

    let selectedItems: SelectedShareItem[];
    let sourceLabel: string;

    if (sourcePathArg) {
      const resolved = await resolveSharePath(page, {
        shareId: shareRef.shareId,
        shareToken,
        sourcePath: sourcePathArg,
      });
      selectedItems = [resolved];
      sourceLabel = normalizeAliPanSharePath(sourcePathArg);
    } else if (shareRef.initialFileId) {
      selectedItems = [{
        fileId: shareRef.initialFileId,
        name: shareRef.initialFileId,
        type: '',
      }];
      sourceLabel = `/file/${shareRef.initialFileId}`;
    } else {
      const rootItems = await listAllShareChildren(page, {
        shareId: shareRef.shareId,
        shareToken,
        parentFileId: 'root',
      });
      selectedItems = rootItems
        .filter(item => String(item.file_id ?? '').trim())
        .map(item => ({
          fileId: String(item.file_id ?? '').trim(),
          name: String(item.name ?? '').trim(),
          type: String(item.type ?? '').trim(),
        }));
      sourceLabel = '/';
    }

    if (selectedItems.length === 0) {
      throw new CommandExecutionError('No files found in the share to save');
    }

    const copyResult = await batchCopyShareFiles(page, {
      shareId: shareRef.shareId,
      shareToken,
      fileIds: selectedItems.map(item => item.fileId),
      toDriveId: driveContext.driveId,
      toParentFileId,
      overwrite,
    });

    const responses = Array.isArray(copyResult.responses) ? copyResult.responses : [];
    const immediateFailures = responses.filter(item => Number(item.status ?? 0) >= 400);
    const asyncTaskIds = responses
      .map(item => String(item.body?.async_task_id ?? '').trim())
      .filter(Boolean);

    let failedCount = immediateFailures.length;
    let savedCount = responses.length - failedCount;
    let status: 'saved' | 'partial' | 'failed' = failedCount > 0 ? 'partial' : 'saved';

    if (asyncTaskIds.length > 0) {
      const asyncResults = await pollAsyncTasks(page, { shareToken, asyncTaskIds });
      const failedTasks = asyncResults.filter(item => {
        const state = String(item?.body?.state ?? '');
        return state === 'Failed' || state === 'PartialSucceed';
      });
      const succeededTasks = asyncResults.filter(item => String(item?.body?.state ?? '') === 'Succeed');
      failedCount += failedTasks.length;
      savedCount = Math.max(0, savedCount - asyncTaskIds.length) + succeededTasks.length;
      if (savedCount === 0 && failedCount > 0) status = 'failed';
      else if (failedCount > 0) status = 'partial';
      else status = 'saved';
    } else if (savedCount === 0 && failedCount > 0) {
      status = 'failed';
    }

    return [{
      status,
      share_id: shareRef.shareId,
      source: sourceLabel,
      saved_count: savedCount,
      failed_count: failedCount,
      to_path: toPathArg || '',
      to_parent_file_id: toParentFileId,
      endpoint: 'https://api.aliyundrive.com/v2/share_link/get_share_token, https://api.aliyundrive.com/adrive/v2/file/list_by_share, https://api.aliyundrive.com/adrive/v4/batch',
    }];
  },
});
