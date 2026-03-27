import { CommandExecutionError } from '../../errors.js';
import { cli, Strategy } from '../../registry.js';
import { QUARK_WEB_ORIGIN, quarkDeleteFiles, quarkResolvePath } from './utils.js';

cli({
  site: 'quark',
  name: 'delete',
  description: 'Delete (move to recycle bin) a file/folder in Quark',
  domain: 'pan.quark.cn',
  strategy: Strategy.HEADER,
  browser: true,
  navigateBefore: false,
  args: [
    { name: 'file-id', required: false, positional: true, help: 'Target file_id to delete' },
    { name: 'path', default: '', help: 'Path to target file/folder (alternative to file-id)' },
    { name: 'yes', type: 'boolean', default: false, help: 'Confirm destructive action (must be true)' },
  ],
  columns: ['status', 'file_id', 'path', 'endpoint', 'message'],
  func: async (page, kwargs) => {
    if (!page) throw new CommandExecutionError('Browser page required for quark delete');

    const fileIdArg = String(kwargs['file-id'] ?? '').trim();
    const pathArg = String(kwargs.path ?? '').trim();
    if (!fileIdArg && !pathArg) {
      throw new CommandExecutionError('Provide file-id positional argument or --path');
    }
    if (!kwargs.yes) {
      throw new CommandExecutionError('Delete is destructive. Re-run with --yes true');
    }

    await page.goto(`${QUARK_WEB_ORIGIN}/list#/list/all`);
    await page.wait(1);

    const resolved = fileIdArg
      ? null
      : await quarkResolvePath(page, pathArg, 'all');
    const fileId = fileIdArg || resolved!.file_id;

    const endpoint = await quarkDeleteFiles(page, [fileId]);

    return [{
      status: 'success',
      file_id: fileId,
      path: pathArg || '',
      endpoint,
      message: 'File moved to recycle bin',
    }];
  },
});
