import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ALIPAN_MIN_CHUNK_SIZE,
  buildAliPanPartInfoList,
  calculateAliPanProofCode,
  calculateAliPanSha1,
  joinAliPanPath,
  planAliPanMultipartUpload,
} from './upload-shared.js';

const tempDirs: string[] = [];

function makeTempFile(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alipan-upload-test-'));
  tempDirs.push(dir);
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('alipan upload helpers', () => {
  it('plans a single-part upload for small files', () => {
    const plan = planAliPanMultipartUpload(1024 * 1024);

    expect(plan.chunkCount).toBe(1);
    expect(plan.chunkSize).toBeGreaterThanOrEqual(ALIPAN_MIN_CHUNK_SIZE);
  });

  it('increases chunk size to keep part count within AliPan limits', () => {
    const hugeFileSize = 15 * 1024 * 1024 * 1024;
    const plan = planAliPanMultipartUpload(hugeFileSize);

    expect(plan.chunkCount).toBeLessThanOrEqual(1000);
    expect(plan.chunkSize * plan.chunkCount).toBeGreaterThanOrEqual(hugeFileSize);
  });

  it('builds consecutive part numbers for upload batches', () => {
    expect(buildAliPanPartInfoList(3, 5)).toEqual([
      { part_number: 5 },
      { part_number: 6 },
      { part_number: 7 },
    ]);
  });

  it('calculates uppercase SHA1 for a local file', async () => {
    const filePath = makeTempFile('hello.txt', 'hello world');

    await expect(calculateAliPanSha1(filePath)).resolves.toBe(
      '2AAE6C35C94FCFB415DBE95F408B9CE91EE846ED',
    );
  });

  it('calculates proof_code from the token-derived byte offset', async () => {
    const filePath = makeTempFile('hello.txt', 'hello world');
    const content = fs.readFileSync(filePath);
    const accessToken = 'opencli-token';
    const tokenDigest = createHash('md5').update(accessToken).digest('hex').slice(0, 16);
    const offset = Number(BigInt(`0x${tokenDigest}`) % BigInt(content.length));
    const expected = content.subarray(offset, Math.min(offset + 8, content.length)).toString('base64');

    await expect(calculateAliPanProofCode(filePath, accessToken)).resolves.toBe(expected);
  });

  it('joins AliPan paths without duplicate slashes', () => {
    expect(joinAliPanPath('/', 'demo.mp4')).toBe('/demo.mp4');
    expect(joinAliPanPath('/Movies', 'demo.mp4')).toBe('/Movies/demo.mp4');
    expect(joinAliPanPath('/Movies/', 'demo.mp4')).toBe('/Movies/demo.mp4');
  });
});
