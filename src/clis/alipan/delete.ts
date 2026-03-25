import { CommandExecutionError } from '../../errors.js';
import { cli, Strategy } from '../../registry.js';
import { alipanPostWithFallback, alipanResolvePath } from './utils.js';

cli({
  site: 'alipan',
  name: 'delete',
  description: 'Delete (move to recycle bin) a file/folder in AliPan',
  domain: 'www.alipan.com',
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
    const fileIdArg = String(kwargs['file-id'] ?? '').trim();
    const pathArg = String(kwargs.path ?? '').trim();
    if (!fileIdArg && !pathArg) {
      throw new CommandExecutionError('Provide file-id positional argument or --path');
    }
    if (!kwargs.yes) {
      throw new CommandExecutionError('Delete is destructive. Re-run with --yes true');
    }

    await page!.goto('https://www.alipan.com/drive/home');
    await page!.wait(1);

    const resolved = fileIdArg
      ? null
      : await alipanResolvePath(page, pathArg, 'all');
    const fileId = fileIdArg || resolved!.file_id;

    const result = await alipanPostWithFallback<Record<string, unknown>>(page, [
      {
        url: 'https://api.aliyundrive.com/v2/recyclebin/trash',
        body: { file_id: fileId },
      },
      {
        url: 'https://api.aliyundrive.com/v3/file/delete',
        body: { file_id: fileId },
      },
    ]);

    return [{
      status: 'success',
      file_id: fileId,
      path: pathArg || '',
      endpoint: result.endpoint,
      message: 'File moved to recycle bin',
    }];
  },
});
