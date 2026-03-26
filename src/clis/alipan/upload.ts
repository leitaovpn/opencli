import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { createProgressBar, formatBytes } from '../../download/progress.js';
import { AuthRequiredError, CommandExecutionError, getErrorMessage } from '../../errors.js';
import { cli, Strategy } from '../../registry.js';
import { alipanPostWithFallback, alipanResolvePath } from './utils.js';
import {
  ALIPAN_CHECK_NAME_MODES,
  ALIPAN_UPLOAD_URL_BATCH_SIZE,
  type AliPanCheckNameMode,
  buildAliPanPartInfoList,
  calculateAliPanProofCode,
  calculateAliPanSha1,
  joinAliPanPath,
  planAliPanMultipartUpload,
  readAliPanFileChunk,
} from './upload-shared.js';

type AliPanAuthContext = {
  accessToken: string;
  tokenType: string;
  driveId: string;
};

type AliPanUploadPartInfo = {
  part_number?: number;
  upload_url?: string;
};

type AliPanCreateFileResponse = {
  drive_id?: string;
  file_id?: string;
  file_name?: string;
  name?: string;
  parent_file_id?: string;
  part_info_list?: AliPanUploadPartInfo[];
  rapid_upload?: boolean;
  upload_id?: string;
};

type AliPanCompleteFileResponse = {
  file_id?: string;
  name?: string;
  parent_file_id?: string;
  size?: number;
  status?: string;
};

function assertAliPanCheckNameMode(value: string): asserts value is AliPanCheckNameMode {
  if ((ALIPAN_CHECK_NAME_MODES as readonly string[]).includes(value)) return;
  throw new CommandExecutionError(
    `Unsupported check-name-mode: ${value}`,
    `Use one of: ${ALIPAN_CHECK_NAME_MODES.join(', ')}`,
  );
}

async function getAliPanAuthContext(page: { evaluate(js: string): Promise<unknown> }): Promise<AliPanAuthContext> {
  const result = await page.evaluate(`
    (() => {
      const raw = localStorage.getItem('token') || '';
      let token = {};
      try { token = JSON.parse(raw || '{}'); } catch {}
      return {
        accessToken: token.access_token || '',
        tokenType: token.token_type || 'Bearer',
        driveId: token.default_drive_id || token.default_sbox_drive_id || '',
      };
    })()
  `) as AliPanAuthContext;

  if (!result?.accessToken || !result?.driveId) {
    throw new AuthRequiredError('www.alipan.com', 'Missing AliPan access token or drive id. Please log in to AliPan in Chrome.');
  }

  return result;
}

function collectUploadUrls(parts: AliPanUploadPartInfo[] | null | undefined): Map<number, string> {
  const urls = new Map<number, string>();
  for (const part of Array.isArray(parts) ? parts : []) {
    const partNumber = Number(part?.part_number);
    const uploadUrl = String(part?.upload_url ?? '').trim();
    if (partNumber > 0 && uploadUrl) urls.set(partNumber, uploadUrl);
  }
  return urls;
}

async function requestAliPanUploadUrls(
  page: Parameters<typeof alipanPostWithFallback>[0],
  fileId: string,
  uploadId: string,
  driveId: string,
  startPartNumber: number,
  remainingPartCount: number,
): Promise<Map<number, string>> {
  const count = Math.min(ALIPAN_UPLOAD_URL_BATCH_SIZE, remainingPartCount);
  const result = await alipanPostWithFallback<{ part_info_list?: AliPanUploadPartInfo[] }>(page, [
    {
      url: 'https://api.aliyundrive.com/v2/file/get_upload_url',
      body: {
        file_id: fileId,
        upload_id: uploadId,
        drive_id: driveId,
        part_info_list: buildAliPanPartInfoList(count, startPartNumber),
      },
    },
    {
      url: 'https://api.aliyundrive.com/adrive/v2/file/get_upload_url',
      body: {
        file_id: fileId,
        upload_id: uploadId,
        drive_id: driveId,
        part_info_list: buildAliPanPartInfoList(count, startPartNumber),
      },
    },
  ]);

  return collectUploadUrls(result.data?.part_info_list);
}

async function uploadAliPanPart(uploadUrl: string, chunk: Buffer, partNumber: number): Promise<void> {
  let response: Response;
  try {
    const body = chunk.buffer.slice(
      chunk.byteOffset,
      chunk.byteOffset + chunk.byteLength,
    ) as ArrayBuffer;
    response = await fetch(uploadUrl, {
      method: 'PUT',
      body,
    });
  } catch (error) {
    throw new CommandExecutionError(
      `AliPan upload part ${partNumber} failed: ${getErrorMessage(error)}`,
    );
  }

  if (response.ok || response.status === 409) return;

  const body = await response.text().catch(() => '');
  throw new CommandExecutionError(
    `AliPan upload part ${partNumber} failed: HTTP ${response.status} ${body}`.trim(),
  );
}

cli({
  site: 'alipan',
  name: 'upload',
  description: 'Upload a local file to AliPan',
  domain: 'www.alipan.com',
  strategy: Strategy.HEADER,
  browser: true,
  navigateBefore: false,
  timeoutSeconds: 1800,
  args: [
    { name: 'file', required: true, positional: true, help: 'Local file path to upload' },
    { name: 'to-parent-file-id', default: 'root', help: 'Destination parent folder file_id' },
    { name: 'to-path', default: '', help: 'Destination folder path from root (overrides --to-parent-file-id)' },
    { name: 'name', default: '', help: 'Override remote filename' },
    { name: 'check-name-mode', default: 'auto_rename', choices: [...ALIPAN_CHECK_NAME_MODES], help: 'Conflict strategy: auto_rename, overwrite, refuse' },
    { name: 'show-progress', type: 'boolean', default: true, help: 'Show realtime upload progress in terminal' },
  ],
  columns: ['status', 'name', 'size', 'path', 'file_id', 'parent_file_id', 'rapid_upload', 'endpoint'],
  func: async (page, kwargs) => {
    if (!page) throw new CommandExecutionError('Browser page required for alipan upload');

    const localFileInput = String(kwargs.file ?? '').trim();
    const toParentFileIdArg = String(kwargs['to-parent-file-id'] ?? 'root').trim() || 'root';
    const toPathArg = String(kwargs['to-path'] ?? '').trim();
    const remoteNameOverride = String(kwargs.name ?? '').trim();
    const checkNameMode = String(kwargs['check-name-mode'] ?? 'auto_rename').trim();
    const showProgress = Boolean(kwargs['show-progress']) && process.stderr.isTTY !== false;

    if (!localFileInput) {
      throw new CommandExecutionError('Missing required local file path');
    }
    assertAliPanCheckNameMode(checkNameMode);

    const localFilePath = path.resolve(localFileInput);
    if (!fs.existsSync(localFilePath)) {
      throw new CommandExecutionError(`Local file not found: ${localFilePath}`);
    }

    const stat = await fs.promises.stat(localFilePath);
    if (!stat.isFile()) {
      throw new CommandExecutionError(`Upload target is not a file: ${localFilePath}`);
    }
    if (stat.size <= 0) {
      throw new CommandExecutionError('AliPan upload requires a non-empty file');
    }

    const remoteName = remoteNameOverride || path.basename(localFilePath);

    await page.goto('https://www.alipan.com/drive/home');
    await page.wait(1);

    const auth = await getAliPanAuthContext(page);
    const destination = toPathArg
      ? await alipanResolvePath(page, toPathArg, 'folder')
      : null;
    const parentFileId = destination?.file_id ?? toParentFileIdArg;

    process.stderr.write(chalk.dim(`Preparing AliPan upload: ${remoteName} (${formatBytes(stat.size)})\n`));
    process.stderr.write(chalk.dim('Calculating SHA1 and proof_code...\n'));

    const [sha1, proofCode] = await Promise.all([
      calculateAliPanSha1(localFilePath),
      calculateAliPanProofCode(localFilePath, auth.accessToken),
    ]);

    const { chunkSize, chunkCount } = planAliPanMultipartUpload(stat.size);
    const createPayload = {
      drive_id: auth.driveId,
      parent_file_id: parentFileId,
      name: remoteName,
      type: 'file',
      check_name_mode: checkNameMode,
      size: stat.size,
      part_info_list: buildAliPanPartInfoList(Math.min(chunkCount, ALIPAN_UPLOAD_URL_BATCH_SIZE)),
      content_hash: sha1,
      content_hash_name: 'sha1',
      proof_code: proofCode,
      proof_version: 'v1',
      local_created_at: stat.birthtime.toISOString(),
      local_modified_at: stat.mtime.toISOString(),
    };

    const createResult = await alipanPostWithFallback<AliPanCreateFileResponse>(page, [
      {
        url: 'https://api.aliyundrive.com/adrive/v2/file/createWithFolders',
        body: createPayload,
      },
    ]);

    const created = createResult.data || {};
    const fileId = String(created.file_id ?? '').trim();
    const uploadId = String(created.upload_id ?? '').trim();
    const finalName = String(created.file_name ?? created.name ?? remoteName).trim() || remoteName;
    const remotePath = destination
      ? joinAliPanPath(destination.path, finalName)
      : toPathArg
        ? joinAliPanPath(toPathArg, finalName)
        : parentFileId === 'root'
          ? `/${finalName}`
          : '';

    if (!fileId) {
      throw new CommandExecutionError('AliPan create file response missing file_id');
    }

    if (created.rapid_upload) {
      process.stderr.write(chalk.green('AliPan rapid upload completed.\n'));
      return [{
        status: 'uploaded',
        name: finalName,
        size: formatBytes(stat.size),
        path: remotePath,
        file_id: fileId,
        parent_file_id: String(created.parent_file_id ?? parentFileId),
        rapid_upload: true,
        endpoint: createResult.endpoint,
      }];
    }

    if (!uploadId) {
      throw new CommandExecutionError('AliPan upload response missing upload_id');
    }

    const progressBar = showProgress ? createProgressBar(finalName, 0, 1) : null;
    const uploadUrls = collectUploadUrls(created.part_info_list);
    const fileHandle = await fs.promises.open(localFilePath, 'r');

    try {
      for (let partNumber = 1; partNumber <= chunkCount; partNumber++) {
        let uploadUrl = uploadUrls.get(partNumber);
        if (!uploadUrl) {
          const refreshed = await requestAliPanUploadUrls(
            page,
            fileId,
            uploadId,
            auth.driveId,
            partNumber,
            chunkCount - partNumber + 1,
          );
          for (const [key, value] of refreshed) uploadUrls.set(key, value);
          uploadUrl = uploadUrls.get(partNumber);
        }

        if (!uploadUrl) {
          throw new CommandExecutionError(`AliPan did not return upload_url for part ${partNumber}`);
        }

        const start = (partNumber - 1) * chunkSize;
        const length = Math.min(chunkSize, stat.size - start);
        const chunk = await readAliPanFileChunk(fileHandle, start, length);
        try {
          await uploadAliPanPart(uploadUrl, chunk, partNumber);
        } catch (error) {
          const refreshed = await requestAliPanUploadUrls(
            page,
            fileId,
            uploadId,
            auth.driveId,
            partNumber,
            1,
          ).catch(() => new Map<number, string>());
          const retryUrl = refreshed.get(partNumber);
          if (!retryUrl || retryUrl === uploadUrl) throw error;
          uploadUrls.set(partNumber, retryUrl);
          await uploadAliPanPart(retryUrl, chunk, partNumber);
        }

        progressBar?.update(
          Math.min(start + chunk.length, stat.size),
          stat.size,
          chunkCount > 1 ? `part ${partNumber}/${chunkCount}` : undefined,
        );
      }
    } catch (error) {
      progressBar?.fail(getErrorMessage(error));
      throw error;
    } finally {
      await fileHandle.close();
    }

    const completeResult = await alipanPostWithFallback<AliPanCompleteFileResponse>(page, [
      {
        url: 'https://api.aliyundrive.com/v2/file/complete',
        body: {
          file_id: fileId,
          upload_id: uploadId,
          drive_id: auth.driveId,
        },
      },
      {
        url: 'https://api.aliyundrive.com/adrive/v2/file/complete',
        body: {
          file_id: fileId,
          upload_id: uploadId,
          drive_id: auth.driveId,
        },
      },
    ]);

    progressBar?.complete(true, formatBytes(stat.size));

    return [{
      status: 'uploaded',
      name: String(completeResult.data?.name ?? finalName),
      size: formatBytes(stat.size),
      path: remotePath,
      file_id: String(completeResult.data?.file_id ?? fileId),
      parent_file_id: String(completeResult.data?.parent_file_id ?? created.parent_file_id ?? parentFileId),
      rapid_upload: false,
      endpoint: completeResult.endpoint,
    }];
  },
});
