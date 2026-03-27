import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { createProgressBar } from '../../download/progress.js';
import { CommandExecutionError, getErrorMessage } from '../../errors.js';
import { cli, Strategy } from '../../registry.js';
import {
  QUARK_DRIVE_ORIGIN,
  QUARK_WEB_ORIGIN,
  normalizeQuarkParentFileId,
  quarkDeleteFiles,
  quarkListDirectoryAll,
  quarkRequestWithFallback,
  quarkResolvePath,
} from './utils.js';
import {
  QUARK_CHECK_NAME_MODES,
  calculateQuarkFileHashes,
  type QuarkCheckNameMode,
  guessQuarkMimeType,
  joinQuarkUploadPath,
  planQuarkUploadParts,
  readQuarkFileChunk,
} from './upload-shared.js';

type QuarkUploadPartInfo = {
  part_number?: number;
  upload_url?: string;
  url?: string;
  headers?: Record<string, string>;
};

type QuarkUploadPreResponse = {
  finish?: boolean;
  fid?: string;
  file_name?: string;
  pdir_fid?: string;
  obj_key?: string;
  task_id?: string;
  upload_id?: string;
  part_info_list?: QuarkUploadPartInfo[];
};

type QuarkUploadFinishResponse = {
  fid?: string;
  file_name?: string;
  pdir_fid?: string;
  size?: number;
  status?: string;
};

type QuarkFormUploadAuth = {
  auth_key?: string;
  policy?: string;
  key_id?: string;
  headers?: Array<Record<string, string>>;
};

type QuarkUploadCallback = {
  callbackUrl?: string;
  callbackBody?: string;
};

type QuarkFormUploadPreResponse = {
  finish?: boolean;
  fid?: string;
  file_name?: string;
  pdir_fid?: string;
  task_id?: string;
  upload_id?: string;
  obj_key?: string;
  upload_url?: string;
  bucket?: string;
  md5?: string;
  sha1?: string;
  callback?: QuarkUploadCallback;
  format_type?: string;
  size?: number;
  auth_info?: string;
  auth_info_expried?: number;
  upload_auth?: QuarkFormUploadAuth;
  file_struct?: Record<string, unknown>;
};

type UploadUrlEntry = {
  url: string;
  headers: Record<string, string>;
};

function assertQuarkCheckNameMode(value: string): asserts value is QuarkCheckNameMode {
  if ((QUARK_CHECK_NAME_MODES as readonly string[]).includes(value)) return;
  throw new CommandExecutionError(
    `Unsupported check-name-mode: ${value}`,
    `Use one of: ${QUARK_CHECK_NAME_MODES.join(', ')}`,
  );
}

function collectUploadUrls(partInfoList: QuarkUploadPartInfo[] | null | undefined): Map<number, UploadUrlEntry> {
  const urls = new Map<number, UploadUrlEntry>();
  for (const part of Array.isArray(partInfoList) ? partInfoList : []) {
    const partNumber = Number(part?.part_number);
    const uploadUrl = String(part?.upload_url ?? part?.url ?? '').trim();
    if (partNumber <= 0 || !uploadUrl) continue;
    urls.set(partNumber, {
      url: uploadUrl,
      headers: typeof part?.headers === 'object' && part.headers !== null
        ? Object.fromEntries(Object.entries(part.headers).map(([key, value]) => [key, String(value)]))
        : {},
    });
  }
  return urls;
}

async function uploadPart(uploadUrl: string, headers: Record<string, string>, chunk: Buffer, partNumber: number): Promise<void> {
  let response: Response;
  try {
    const body = chunk.buffer.slice(
      chunk.byteOffset,
      chunk.byteOffset + chunk.byteLength,
    ) as ArrayBuffer;
    response = await fetch(uploadUrl, {
      method: 'PUT',
      headers,
      body,
    });
  } catch (error) {
    throw new CommandExecutionError(`Quark upload part ${partNumber} failed: ${getErrorMessage(error)}`);
  }

  if (response.ok || response.status === 409) return;
  const responseBody = await response.text().catch(() => '');
  throw new CommandExecutionError(`Quark upload part ${partNumber} failed: HTTP ${response.status} ${responseBody}`.trim());
}

async function uploadFormFile(
  prepared: QuarkFormUploadPreResponse,
  localFilePath: string,
  remoteName: string,
  mimeType: string,
): Promise<void> {
  const uploadUrl = String(prepared.upload_url ?? '').trim();
  const objKey = String(prepared.obj_key ?? '').trim();
  const auth = prepared.upload_auth ?? {};
  const policy = String(auth.policy ?? '').trim();
  const keyId = String(auth.key_id ?? '').trim();
  const authKey = String(auth.auth_key ?? '').trim();

  if (!uploadUrl || !objKey || !policy || !keyId || !authKey) {
    throw new CommandExecutionError('Quark form upload response is missing upload_url, obj_key, or upload_auth credentials');
  }

  const form = new FormData();
  form.append('key', objKey);
  form.append('policy', policy);
  form.append('OSSAccessKeyId', keyId);
  form.append('success_action_status', '200');
  form.append('signature', authKey);
  form.append('callback', Buffer.from(JSON.stringify(prepared.callback ?? {}), 'utf8').toString('base64'));

  const fileBuffer = await fs.promises.readFile(localFilePath);
  form.append('file', new Blob([fileBuffer], { type: mimeType }), remoteName);

  const response = await fetch(uploadUrl, {
    method: 'POST',
    body: form,
  });

  if (response.ok) return;

  const responseBody = await response.text().catch(() => '');
  throw new CommandExecutionError(`Quark form upload failed: HTTP ${response.status} ${responseBody}`.trim());
}

function splitFileName(name: string): { stem: string; ext: string } {
  const ext = path.extname(name);
  return {
    stem: ext ? name.slice(0, -ext.length) : name,
    ext,
  };
}

function buildUniqueName(name: string, existingNames: Set<string>): string {
  if (!existingNames.has(name)) return name;
  const { stem, ext } = splitFileName(name);
  for (let index = 1; index < 10000; index += 1) {
    const candidate = `${stem} (${index})${ext}`;
    if (!existingNames.has(candidate)) return candidate;
  }
  throw new CommandExecutionError(`Could not generate a unique Quark filename for ${name}`);
}

cli({
  site: 'quark',
  name: 'upload',
  description: 'Upload a local file to Quark',
  domain: 'pan.quark.cn',
  strategy: Strategy.HEADER,
  browser: true,
  navigateBefore: false,
  timeoutSeconds: 1800,
  args: [
    { name: 'file', required: true, positional: true, help: 'Local file path to upload' },
    { name: 'to-parent-file-id', default: 'root', help: 'Destination parent folder file_id' },
    { name: 'to-path', default: '', help: 'Destination folder path from root (overrides --to-parent-file-id)' },
    { name: 'name', default: '', help: 'Override remote filename' },
    { name: 'check-name-mode', default: 'auto_rename', choices: [...QUARK_CHECK_NAME_MODES], help: 'Conflict strategy: auto_rename, overwrite, refuse' },
    { name: 'show-progress', type: 'boolean', default: true, help: 'Show realtime upload progress in terminal' },
  ],
  columns: ['status', 'name', 'size', 'path', 'file_id', 'parent_file_id', 'rapid_upload', 'endpoint'],
  func: async (page, kwargs) => {
    if (!page) throw new CommandExecutionError('Browser page required for quark upload');

    const localFileInput = String(kwargs.file ?? '').trim();
    const toParentFileIdArg = normalizeQuarkParentFileId(String(kwargs['to-parent-file-id'] ?? 'root'));
    const toPathArg = String(kwargs['to-path'] ?? '').trim();
    const remoteNameOverride = String(kwargs.name ?? '').trim();
    const checkNameMode = String(kwargs['check-name-mode'] ?? 'auto_rename').trim();
    const showProgress = Boolean(kwargs['show-progress']) && process.stderr.isTTY !== false;

    if (!localFileInput) throw new CommandExecutionError('Missing required local file path');
    assertQuarkCheckNameMode(checkNameMode);

    const localFilePath = path.resolve(localFileInput);
    if (!fs.existsSync(localFilePath)) {
      throw new CommandExecutionError(`Local file not found: ${localFilePath}`);
    }

    const stat = await fs.promises.stat(localFilePath);
    if (!stat.isFile()) {
      throw new CommandExecutionError(`Upload target is not a file: ${localFilePath}`);
    }
    if (stat.size <= 0) {
      throw new CommandExecutionError('Quark upload requires a non-empty file');
    }

    await page.goto(`${QUARK_WEB_ORIGIN}/list#/list/all`);
    await page.wait(1);

    const destination = toPathArg
      ? await quarkResolvePath(page, toPathArg, 'folder')
      : null;
    const parentFileId = destination?.file_id ?? toParentFileIdArg;

    const siblings = await quarkListDirectoryAll(page, {
      parentFileId,
      sort: ['file_type:asc', 'file_name:asc'],
    });
    const existingNames = new Set(siblings.map(item => String(item.file_name ?? '')));
    const hasConflict = (name: string) => siblings.some(item => String(item.file_name ?? '') === name);

    const requestedRemoteName = remoteNameOverride || path.basename(localFilePath);
    const remoteName = checkNameMode === 'auto_rename'
      ? buildUniqueName(requestedRemoteName, existingNames)
      : requestedRemoteName;

    if (checkNameMode === 'refuse' && hasConflict(remoteName)) {
      throw new CommandExecutionError(`A file or folder named "${remoteName}" already exists in the target directory.`);
    }

    if (checkNameMode === 'overwrite') {
      const conflict = siblings.find(item => String(item.file_name ?? '') === remoteName);
      if (conflict?.fid) {
        await quarkDeleteFiles(page, [String(conflict.fid)]);
      }
    }

    process.stderr.write(chalk.dim(`Preparing Quark upload: ${remoteName}\n`));

    const preResult = await quarkRequestWithFallback<QuarkUploadPreResponse>(page, [
      {
        url: `${QUARK_DRIVE_ORIGIN}/1/clouddrive/file/upload/pre`,
        params: {
          mi: '',
        },
        body: {
          pdir_fid: parentFileId,
          dir_name: '',
          size: stat.size,
          file_name: remoteName,
          format_type: guessQuarkMimeType(localFilePath),
          same_path_reuse: false,
          ccp_hash_update: true,
          parallel_upload: true,
          l_created_at: Math.floor(stat.birthtimeMs),
          l_updated_at: Math.floor(stat.mtimeMs),
          file_local_path: localFilePath,
        },
      },
    ]);

    const prepared = preResult.data ?? {};
    const finalName = String(prepared.file_name ?? remoteName).trim() || remoteName;
    const remotePath = joinQuarkUploadPath(destination?.path ?? '/', finalName);

    if (prepared.finish) {
      return [{
        status: 'success',
        name: finalName,
        size: stat.size,
        path: remotePath,
        file_id: prepared.fid ?? '',
        parent_file_id: prepared.pdir_fid ?? parentFileId,
        rapid_upload: 'true',
        endpoint: preResult.endpoint,
      }];
    }

    const taskId = String(prepared.task_id ?? '').trim();
    const objKey = String(prepared.obj_key ?? '').trim();
    const partSize = Number(preResult.metadata?.part_size ?? 0);
    if (!taskId || !objKey || !Number.isFinite(partSize) || partSize <= 0) {
      throw new CommandExecutionError('Quark upload/pre response is missing task_id, obj_key, or metadata.part_size');
    }

    const parts = planQuarkUploadParts(stat.size, partSize);
    const uploadUrls = collectUploadUrls(prepared.part_info_list);
    if (uploadUrls.size < parts.length) {
      if (parts.length === 1 && stat.size <= partSize) {
        process.stderr.write(chalk.dim('Falling back to Quark form upload for single-part file\n'));

        const mimeType = guessQuarkMimeType(localFilePath);
        const { md5, sha1 } = await calculateQuarkFileHashes(localFilePath);
        const formPreResult = await quarkRequestWithFallback<QuarkFormUploadPreResponse>(page, [
          {
            url: `${QUARK_DRIVE_ORIGIN}/1/clouddrive/file/formupload/pre`,
            body: {
              sha1,
              md5,
              pdir_fid: parentFileId,
              size: stat.size,
              file_name: finalName,
              format_type: mimeType,
              l_created_at: Math.floor(stat.birthtimeMs),
              l_updated_at: Math.floor(stat.mtimeMs),
            },
          },
        ]);

        const formPrepared = formPreResult.data ?? {};
        const progressBar = showProgress ? createProgressBar(finalName, 0, stat.size) : null;
        if (!formPrepared.finish) {
          await uploadFormFile(formPrepared, localFilePath, finalName, mimeType);
          progressBar?.update(stat.size, stat.size, 'form upload');
        }
        progressBar?.complete(true);

        const finishResult = formPrepared.finish
          ? { data: formPrepared, endpoint: formPreResult.endpoint }
          : await quarkRequestWithFallback<QuarkUploadFinishResponse>(page, [
            {
              url: `${QUARK_DRIVE_ORIGIN}/1/clouddrive/file/upload/finish`,
              body: {
                obj_key: formPrepared.obj_key,
                task_id: formPrepared.task_id,
              },
            },
          ]);

        return [{
          status: 'success',
          name: finishResult.data?.file_name ?? finalName,
          size: Number(finishResult.data?.size ?? stat.size),
          path: remotePath,
          file_id: finishResult.data?.fid ?? formPrepared.fid ?? '',
          parent_file_id: finishResult.data?.pdir_fid ?? formPrepared.pdir_fid ?? parentFileId,
          rapid_upload: formPrepared.finish ? 'true' : 'false',
          endpoint: formPrepared.finish
            ? formPreResult.endpoint
            : `${formPreResult.endpoint}, ${finishResult.endpoint}`,
        }];
      }

      throw new CommandExecutionError(
        `Quark upload/pre returned ${uploadUrls.size}/${parts.length} upload URLs. Advanced upload URL refresh is not implemented yet.`,
      );
    }

    const progressBar = showProgress ? createProgressBar(finalName, 0, stat.size) : null;
    const handle = await fs.promises.open(localFilePath, 'r');
    let uploadedBytes = 0;

    try {
      for (const part of parts) {
        const uploadEntry = uploadUrls.get(part.partNo);
        if (!uploadEntry?.url) {
          throw new CommandExecutionError(`Missing Quark upload URL for part ${part.partNo}`);
        }
        const chunk = await readQuarkFileChunk(handle, part.start, part.size);
        await uploadPart(uploadEntry.url, uploadEntry.headers, chunk, part.partNo);
        uploadedBytes += chunk.length;
        progressBar?.update(uploadedBytes, stat.size, `part ${part.partNo}/${parts.length}`);
      }
    } finally {
      await handle.close();
    }

    progressBar?.complete(true);

    const finishResult = await quarkRequestWithFallback<QuarkUploadFinishResponse>(page, [
      {
        url: `${QUARK_DRIVE_ORIGIN}/1/clouddrive/file/upload/finish`,
        body: {
          obj_key: objKey,
          task_id: taskId,
        },
      },
    ]);

    return [{
      status: 'success',
      name: finishResult.data?.file_name ?? finalName,
      size: Number(finishResult.data?.size ?? stat.size),
      path: remotePath,
      file_id: finishResult.data?.fid ?? prepared.fid ?? '',
      parent_file_id: finishResult.data?.pdir_fid ?? prepared.pdir_fid ?? parentFileId,
      rapid_upload: 'false',
      endpoint: `${preResult.endpoint}, ${finishResult.endpoint}`,
    }];
  },
});
