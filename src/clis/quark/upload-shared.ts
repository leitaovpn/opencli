import * as fs from 'node:fs';
import { createHash } from 'node:crypto';

export const QUARK_UPLOAD_PART_ALIGNMENT = 64 * 1024;

export const QUARK_CHECK_NAME_MODES = ['auto_rename', 'overwrite', 'refuse'] as const;
export type QuarkCheckNameMode = typeof QUARK_CHECK_NAME_MODES[number];

export type QuarkUploadPart = {
  partNo: number;
  start: number;
  end: number;
  size: number;
};

const MIME_MAP: Record<string, string> = {
  '.7z': 'application/x-7z-compressed',
  '.apk': 'application/vnd.android.package-archive',
  '.avi': 'video/x-msvideo',
  '.csv': 'text/csv',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.m4a': 'audio/mp4',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.srt': 'application/x-subrip',
  '.txt': 'text/plain',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.zip': 'application/zip',
};

export function joinQuarkUploadPath(basePath: string, childName: string): string {
  const normalizedBase = (basePath || '/').trim();
  if (!normalizedBase || normalizedBase === '/') return `/${childName}`;
  return `${normalizedBase.replace(/\/+$/, '')}/${childName}`;
}

export function guessQuarkMimeType(filePath: string): string {
  const lower = filePath.toLowerCase();
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.')) : '';
  return MIME_MAP[ext] || 'application/octet-stream';
}

export function planQuarkUploadParts(fileSize: number, partSize: number): QuarkUploadPart[] {
  if (!Number.isFinite(fileSize) || fileSize <= 0 || !Number.isFinite(partSize) || partSize <= 0) {
    return [];
  }

  const parts: QuarkUploadPart[] = [];
  let start = 0;
  let partNo = 1;
  while (start < fileSize) {
    const end = Math.min(start + partSize, fileSize);
    parts.push({
      partNo,
      start,
      end,
      size: end - start,
    });
    start = end;
    partNo += 1;
  }
  return parts;
}

export async function readQuarkFileChunk(
  handle: fs.promises.FileHandle,
  start: number,
  length: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, start);
  return buffer.subarray(0, bytesRead);
}

export async function calculateQuarkFileHashes(filePath: string): Promise<{ md5: string; sha1: string }> {
  const md5 = createHash('md5');
  const sha1 = createHash('sha1');
  const stream = fs.createReadStream(filePath);

  for await (const chunk of stream) {
    md5.update(chunk);
    sha1.update(chunk);
  }

  return {
    md5: md5.digest('hex'),
    sha1: sha1.digest('hex'),
  };
}
