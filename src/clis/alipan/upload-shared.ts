import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { CommandExecutionError } from '../../errors.js';

export const ALIPAN_MIN_CHUNK_SIZE = 10 * 1024 * 1024;
export const ALIPAN_MAX_PARTS = 1000;
export const ALIPAN_UPLOAD_URL_BATCH_SIZE = 20;
const CHUNK_ALIGNMENT = 64;

export const ALIPAN_CHECK_NAME_MODES = ['auto_rename', 'overwrite', 'refuse'] as const;
export type AliPanCheckNameMode = typeof ALIPAN_CHECK_NAME_MODES[number];

export type AliPanChunkPlan = {
  chunkSize: number;
  chunkCount: number;
};

export type AliPanPartInfo = {
  part_number: number;
};

function alignUp(value: number, multiple: number): number {
  if (!Number.isFinite(value) || value <= 0) return multiple;
  return Math.ceil(value / multiple) * multiple;
}

export function planAliPanMultipartUpload(fileSize: number): AliPanChunkPlan {
  if (!Number.isFinite(fileSize) || fileSize <= 0) {
    throw new CommandExecutionError('AliPan upload requires a non-empty file');
  }

  const minChunkSize = alignUp(ALIPAN_MIN_CHUNK_SIZE, CHUNK_ALIGNMENT);
  const requiredChunkSize = alignUp(Math.ceil(fileSize / ALIPAN_MAX_PARTS), CHUNK_ALIGNMENT);
  const chunkSize = Math.max(minChunkSize, requiredChunkSize);
  const chunkCount = Math.ceil(fileSize / chunkSize);

  return { chunkSize, chunkCount };
}

export function buildAliPanPartInfoList(count: number, startPartNumber: number = 1): AliPanPartInfo[] {
  if (!Number.isFinite(count) || count <= 0) return [];
  return Array.from({ length: count }, (_, index) => ({
    part_number: startPartNumber + index,
  }));
}

export async function calculateAliPanSha1(filePath: string): Promise<string> {
  const hash = createHash('sha1');
  const stream = fs.createReadStream(filePath);

  return await new Promise<string>((resolve, reject) => {
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex').toUpperCase()));
  });
}

export async function calculateAliPanProofCode(filePath: string, accessToken: string): Promise<string> {
  const stat = await fs.promises.stat(filePath);
  if (stat.size <= 0) return '';

  const tokenDigest = createHash('md5').update(accessToken).digest('hex').slice(0, 16);
  const offset = Number(BigInt(`0x${tokenDigest}`) % BigInt(stat.size));
  const length = Math.min(8, stat.size - offset);
  const handle = await fs.promises.open(filePath, 'r');

  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead).toString('base64');
  } finally {
    await handle.close();
  }
}

export async function readAliPanFileChunk(
  handle: fs.promises.FileHandle,
  start: number,
  length: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, start);
  return buffer.subarray(0, bytesRead);
}

export function joinAliPanPath(basePath: string, name: string): string {
  const normalizedBase = (basePath || '/').trim();
  if (!normalizedBase || normalizedBase === '/') return `/${name}`;
  return `${normalizedBase.replace(/\/+$/, '')}/${name}`;
}
