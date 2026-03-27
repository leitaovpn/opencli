import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  calculateQuarkFileHashes,
  guessQuarkMimeType,
  joinQuarkUploadPath,
  planQuarkUploadParts,
  readQuarkFileChunk,
} from './upload-shared.js';

const tempDirs: string[] = [];

function makeTempFile(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quark-upload-test-'));
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

describe('quark upload helpers', () => {
  it('plans aligned multipart uploads from part size', () => {
    expect(planQuarkUploadParts(10, 4)).toEqual([
      { partNo: 1, start: 0, end: 4, size: 4 },
      { partNo: 2, start: 4, end: 8, size: 4 },
      { partNo: 3, start: 8, end: 10, size: 2 },
    ]);
  });

  it('guesses content types from file extensions', () => {
    expect(guessQuarkMimeType('/tmp/demo.mp4')).toBe('video/mp4');
    expect(guessQuarkMimeType('/tmp/demo.unknown')).toBe('application/octet-stream');
  });

  it('joins Quark upload paths without duplicate slashes', () => {
    expect(joinQuarkUploadPath('/', 'demo.mp4')).toBe('/demo.mp4');
    expect(joinQuarkUploadPath('/Movies', 'demo.mp4')).toBe('/Movies/demo.mp4');
    expect(joinQuarkUploadPath('/Movies/', 'demo.mp4')).toBe('/Movies/demo.mp4');
  });

  it('reads a byte range from a local file', async () => {
    const filePath = makeTempFile('hello.txt', 'hello world');
    const handle = await fs.promises.open(filePath, 'r');
    try {
      const chunk = await readQuarkFileChunk(handle, 6, 5);
      expect(chunk.toString('utf8')).toBe('world');
    } finally {
      await handle.close();
    }
  });

  it('computes md5 and sha1 hashes for a local file', async () => {
    const filePath = makeTempFile('hash.txt', 'hello world');
    await expect(calculateQuarkFileHashes(filePath)).resolves.toEqual({
      md5: '5eb63bbbe01eeed093cb22bb8f5acdc3',
      sha1: '2aae6c35c94fcfb415dbe95f408b9ce91ee846ed',
    });
  });
});
