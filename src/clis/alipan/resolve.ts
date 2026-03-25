import { CommandExecutionError } from '../../errors.js';
import { cli, Strategy } from '../../registry.js';
import type { IPage } from '../../types.js';
import { alipanResolvePath } from './utils.js';

cli({
  site: 'alipan',
  name: 'resolve',
  description: 'Resolve an AliPan path to file_id and metadata',
  domain: 'www.alipan.com',
  strategy: Strategy.HEADER,
  browser: true,
  navigateBefore: false,
  args: [
    { name: 'path', required: true, positional: true, help: 'Path from root, e.g. /Movies/2025/file.mp4' },
    { name: 'type', default: 'all', choices: ['all', 'file', 'folder'], help: 'Expected target type' },
  ],
  columns: ['path', 'name', 'type', 'file_id', 'parent_file_id', 'size', 'updated_at'],
  func: async (page: IPage | null, kwargs) => {
    if (!page) throw new CommandExecutionError('Browser page required for alipan resolve');

    const rawPath = String(kwargs.path ?? '').trim();
    const expectedType = String(kwargs.type ?? 'all') as 'all' | 'file' | 'folder';
    if (!rawPath) throw new CommandExecutionError('Missing required path');

    await page.goto('https://www.alipan.com/drive/home');
    await page.wait(1);

    const result = await alipanResolvePath(page, rawPath, expectedType);
    return [result];
  },
});
