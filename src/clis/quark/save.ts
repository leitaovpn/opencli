import { CommandExecutionError } from '../../errors.js';
import { cli, Strategy } from '../../registry.js';
import {
  QUARK_DRIVE_ORIGIN,
  QUARK_WEB_ORIGIN,
  getQuarkShareToken,
  listAllShareChildren,
  normalizeQuarkFileType,
  normalizeQuarkParentFileId,
  quarkDeleteFiles,
  quarkListDirectoryAll,
  quarkRequestWithFallback,
  quarkResolvePath,
} from './utils.js';
import type { QuarkShareItem } from './utils.js';
import { normalizeQuarkSharePath, parseQuarkShareReference } from './save-shared.js';

type QuarkShareSaveResponse = {
  task_id?: string;
};

type QuarkTaskResponse = {
  status?: number;
  message?: string;
  save_as?: {
    save_as_top_fids?: string[];
  };
  batch_save_as?: {
    sub_task_detail_list?: Array<{
      save_as_top_fids?: string[];
      fail_reason?: string;
    }>;
  };
};

type SelectedShareItem = {
  fid: string;
  parentFid: string;
  fileName: string;
  shareFidToken: string;
  type: string;
};

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function collectSavedIds(payload: QuarkTaskResponse | null | undefined): string[] {
  const saved = new Set<string>();
  const pushMany = (values: unknown) => {
    if (!Array.isArray(values)) return;
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) saved.add(value.trim());
    }
  };

  pushMany(payload?.save_as?.save_as_top_fids);
  const detailList = payload?.batch_save_as?.sub_task_detail_list;
  for (const detail of Array.isArray(detailList) ? detailList : []) {
    pushMany(detail?.save_as_top_fids);
  }
  return [...saved];
}

function countFailedItems(payload: QuarkTaskResponse | null | undefined): number {
  const detailList = payload?.batch_save_as?.sub_task_detail_list;
  if (!Array.isArray(detailList)) return 0;
  return detailList.filter(detail => String(detail?.fail_reason ?? '').trim()).length;
}

async function resolveSharePath(
  page: Parameters<typeof quarkRequestWithFallback>[0],
  options: {
    shareId: string;
    stoken: string;
    sourcePath: string;
  },
): Promise<SelectedShareItem> {
  const normalizedPath = normalizeQuarkSharePath(options.sourcePath);
  const segments = normalizedPath.split('/').map(segment => segment.trim()).filter(Boolean);
  if (segments.length === 0) {
    throw new CommandExecutionError('Source path must point to a file or folder inside the share');
  }

  let parentFid = '0';
  let found: QuarkShareItem | null = null;
  for (const segment of segments) {
    const children = await listAllShareChildren(page, {
      shareId: options.shareId,
      stoken: options.stoken,
      parentFid,
    });
    found = children.find(item => String(item.file_name ?? '') === segment) ?? null;
    if (!found?.fid || !found?.share_fid_token) {
      throw new CommandExecutionError(`Share path not found: ${normalizedPath}`);
    }
    parentFid = String(found.fid);
  }

  return {
    fid: String(found?.fid ?? ''),
    parentFid: String(found?.pdir_fid ?? '0'),
    fileName: String(found?.file_name ?? ''),
    shareFidToken: String(found?.share_fid_token ?? ''),
    type: normalizeQuarkFileType(found),
  };
}

async function findShareItemByFid(
  page: Parameters<typeof quarkRequestWithFallback>[0],
  options: {
    shareId: string;
    stoken: string;
    targetFid: string;
    parentFid?: string;
  },
): Promise<SelectedShareItem | null> {
  const visited = new Set<string>();
  const queue = [options.parentFid ?? '0'];

  while (queue.length > 0) {
    const currentParent = queue.shift() ?? '0';
    if (visited.has(currentParent)) continue;
    visited.add(currentParent);

    const children = await listAllShareChildren(page, {
      shareId: options.shareId,
      stoken: options.stoken,
      parentFid: currentParent,
    });

    for (const child of children) {
      if (String(child.fid ?? '') === options.targetFid && child.share_fid_token) {
        return {
          fid: String(child.fid ?? ''),
          parentFid: String(child.pdir_fid ?? currentParent),
          fileName: String(child.file_name ?? ''),
          shareFidToken: String(child.share_fid_token ?? ''),
          type: normalizeQuarkFileType(child),
        };
      }
      if (normalizeQuarkFileType(child) === 'folder' && child.fid) {
        queue.push(String(child.fid));
      }
    }
  }

  return null;
}

async function pollSaveTask(
  page: Parameters<typeof quarkRequestWithFallback>[0],
  taskId: string,
  intervalMs: number,
): Promise<{ data: QuarkTaskResponse; endpoint: string }> {
  for (let retryIndex = 0; retryIndex < 60; retryIndex += 1) {
    if (retryIndex > 0) {
      await delay(intervalMs);
    }

    const result = await quarkRequestWithFallback<QuarkTaskResponse>(page, [
      {
        url: `${QUARK_DRIVE_ORIGIN}/1/clouddrive/task`,
        method: 'GET',
        params: {
          task_id: taskId,
          retry_index: retryIndex,
        },
      },
    ]);

    const status = Number(result.data?.status ?? -1);
    if (status === 2) {
      return {
        data: result.data ?? {},
        endpoint: result.endpoint,
      };
    }
    if (status === 3) {
      throw new CommandExecutionError(`Quark save task failed: ${result.data?.message ?? 'unknown error'}`);
    }
  }

  throw new CommandExecutionError('Quark save task polling timed out');
}

cli({
  site: 'quark',
  name: 'save',
  description: 'Save files from a Quark share link to your drive',
  domain: 'pan.quark.cn',
  strategy: Strategy.HEADER,
  browser: true,
  navigateBefore: false,
  args: [
    { name: 'share', required: true, positional: true, help: 'Quark share URL or pwd_id' },
    { name: 'share-pwd', default: '', help: 'Share password / extraction code' },
    { name: 'source-path', default: '', help: 'Optional path inside share, e.g. /电影/演示.mp4' },
    { name: 'to-parent-file-id', default: 'root', help: 'Destination parent folder file_id' },
    { name: 'to-path', default: '', help: 'Destination folder path from root (overrides --to-parent-file-id)' },
    { name: 'overwrite', type: 'boolean', default: false, help: 'Overwrite same-name files by recycling the existing target first' },
  ],
  columns: ['status', 'share_id', 'source', 'saved_count', 'failed_count', 'to_path', 'to_parent_file_id', 'endpoint'],
  func: async (page, kwargs) => {
    if (!page) throw new CommandExecutionError('Browser page required for quark save');

    const shareInput = String(kwargs.share ?? '').trim();
    const sharePwdArg = String(kwargs['share-pwd'] ?? '').trim();
    const sourcePathArg = String(kwargs['source-path'] ?? '').trim();
    const toParentFileIdArg = normalizeQuarkParentFileId(String(kwargs['to-parent-file-id'] ?? 'root'));
    const toPathArg = String(kwargs['to-path'] ?? '').trim();
    const overwrite = Boolean(kwargs.overwrite);

    const shareRef = parseQuarkShareReference(shareInput, sharePwdArg);

    await page.goto(`${QUARK_WEB_ORIGIN}/list#/list/all`);
    await page.wait(1);

    const destination = toPathArg
      ? await quarkResolvePath(page, toPathArg, 'folder')
      : null;
    const toParentFileId = destination?.file_id ?? toParentFileIdArg;
    const shareToken = await getQuarkShareToken(page, shareRef.shareId, shareRef.sharePwd);

    let selectedItems: SelectedShareItem[] = [];
    if (sourcePathArg) {
      selectedItems = [await resolveSharePath(page, {
        shareId: shareRef.shareId,
        stoken: shareToken,
        sourcePath: sourcePathArg,
      })];
    } else if (shareRef.initialFileId) {
      const found = await findShareItemByFid(page, {
        shareId: shareRef.shareId,
        stoken: shareToken,
        targetFid: shareRef.initialFileId,
      });
      if (!found) {
        throw new CommandExecutionError(`Quark share deep link target not found: ${shareRef.initialFileId}`);
      }
      selectedItems = [found];
    } else {
      const rootItems = await listAllShareChildren(page, {
        shareId: shareRef.shareId,
        stoken: shareToken,
        parentFid: '0',
      });
      selectedItems = rootItems
        .filter(item => item.fid && item.share_fid_token)
        .map(item => ({
          fid: String(item.fid ?? ''),
          parentFid: String(item.pdir_fid ?? '0'),
          fileName: String(item.file_name ?? ''),
          shareFidToken: String(item.share_fid_token ?? ''),
          type: normalizeQuarkFileType(item),
        }));
    }

    if (selectedItems.length === 0) {
      throw new CommandExecutionError('No files/folders found in the Quark share');
    }

    const sourceParentFid = selectedItems[0]?.parentFid ?? '0';
    if (!selectedItems.every(item => item.parentFid === sourceParentFid)) {
      throw new CommandExecutionError('Selected share items are not from the same parent folder. Please use --source-path for one target at a time.');
    }

    if (overwrite) {
      const siblings = await quarkListDirectoryAll(page, {
        parentFileId: toParentFileId,
        sort: ['file_type:asc', 'file_name:asc'],
      });
      const sameNameIds = siblings
        .filter(item => selectedItems.some(selected => selected.fileName === String(item.file_name ?? '')))
        .map(item => String(item.fid ?? '').trim())
        .filter(Boolean);
      await quarkDeleteFiles(page, sameNameIds);
    }

    const saveBody: Record<string, unknown> = {
      pwd_id: shareRef.shareId,
      stoken: shareToken,
      to_pdir_fid: toParentFileId,
      pdir_fid: sourceParentFid,
      fid_list: selectedItems.map(item => item.fid),
      fid_token_list: selectedItems.map(item => item.shareFidToken),
    };
    if (selectedItems.length === 1 && selectedItems[0].type !== 'folder') {
      saveBody.mode = 'inc_single';
    }

    const saved = await quarkRequestWithFallback<QuarkShareSaveResponse>(page, [
      {
        url: `${QUARK_DRIVE_ORIGIN}/1/clouddrive/share/sharepage/save`,
        body: saveBody,
      },
    ]);

    const taskId = String(saved.data?.task_id ?? '').trim();
    if (!taskId) {
      throw new CommandExecutionError('Quark save response missing task_id');
    }

    const polled = await pollSaveTask(page, taskId, Math.max(200, Number(saved.metadata?.tq_gap ?? 1000)));
    const savedIds = collectSavedIds(polled.data);
    const failedCount = countFailedItems(polled.data);

    return [{
      status: failedCount > 0 ? 'partial' : 'saved',
      share_id: shareRef.shareId,
      source: sourcePathArg || (shareRef.initialFileId ? `/${shareRef.initialType || 'file'}/${shareRef.initialFileId}` : '/'),
      saved_count: savedIds.length || selectedItems.length - failedCount,
      failed_count: failedCount,
      to_path: toPathArg || '',
      to_parent_file_id: toParentFileId,
      endpoint: polled.endpoint,
    }];
  },
});

