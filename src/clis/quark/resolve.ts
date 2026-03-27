import { CommandExecutionError } from '../../errors.js';
import { cli, Strategy } from '../../registry.js';
import type { IPage } from '../../types.js';
import { QUARK_WEB_ORIGIN, quarkResolvePath } from './utils.js';

cli({
  site: 'quark',
  name: 'resolve',
  description: 'Resolve a Quark path to file_id and metadata',
  domain: 'pan.quark.cn',
  strategy: Strategy.HEADER,
  browser: true,
  navigateBefore: false,
  args: [
    { name: 'path', required: true, positional: true, help: 'Path from root, e.g. /Movies/2025/file.mp4' },
    { name: 'type', default: 'all', choices: ['all', 'file', 'folder'], help: 'Expected target type' },
  ],
  columns: ['path', 'name', 'type', 'file_id', 'parent_file_id', 'size', 'updated_at'],
  func: async (page: IPage | null, kwargs) => {
    if (!page) throw new CommandExecutionError('Browser page required for quark resolve');

    const rawPath = String(kwargs.path ?? '').trim();
    const expectedType = String(kwargs.type ?? 'all') as 'all' | 'file' | 'folder';
    if (!rawPath) throw new CommandExecutionError('Missing required path');

    await page.goto(`${QUARK_WEB_ORIGIN}/list#/list/all`);
    await page.wait(1);

    const result = await quarkResolvePath(page, rawPath, expectedType);
    return [result];
  },
});

