import { CommandExecutionError } from '../../errors.js';
import { cli, Strategy } from '../../registry.js';
import { QUARK_DRIVE_ORIGIN, QUARK_WEB_ORIGIN, quarkRequestWithFallback, quarkResolvePath } from './utils.js';

type RenameResponse = {
  fid?: string;
  file_name?: string;
  updated_at?: string;
};

cli({
  site: 'quark',
  name: 'rename',
  description: 'Rename a file/folder in Quark',
  domain: 'pan.quark.cn',
  strategy: Strategy.HEADER,
  browser: true,
  navigateBefore: false,
  args: [
    { name: 'file-id', required: false, positional: true, help: 'Target file_id' },
    { name: 'name', required: false, positional: true, help: 'New file/folder name' },
    { name: 'path', default: '', help: 'Path to target file/folder (alternative to file-id)' },
    { name: 'new-name', default: '', help: 'New file/folder name (alternative to positional name)' },
  ],
  columns: ['status', 'file_id', 'path', 'name', 'updated_at', 'endpoint'],
  func: async (page, kwargs) => {
    if (!page) throw new CommandExecutionError('Browser page required for quark rename');

    const fileIdArg = String(kwargs['file-id'] ?? '').trim();
    const pathArg = String(kwargs.path ?? '').trim();
    const newName = String(kwargs['new-name'] ?? kwargs.name ?? '').trim();
    if (!fileIdArg && !pathArg) {
      throw new CommandExecutionError('Provide file-id positional argument or --path');
    }
    if (!newName) throw new CommandExecutionError('Missing required new-name');

    await page.goto(`${QUARK_WEB_ORIGIN}/list#/list/all`);
    await page.wait(1);

    const resolved = fileIdArg
      ? null
      : await quarkResolvePath(page, pathArg, 'all');
    const fileId = fileIdArg || resolved!.file_id;

    const result = await quarkRequestWithFallback<RenameResponse>(page, [
      {
        url: `${QUARK_DRIVE_ORIGIN}/1/clouddrive/file/rename`,
        body: {
          fid: fileId,
          file_name: newName,
        },
      },
    ]);

    return [{
      status: 'success',
      file_id: result.data?.fid ?? fileId,
      path: pathArg || '',
      name: result.data?.file_name ?? newName,
      updated_at: result.data?.updated_at ?? '',
      endpoint: result.endpoint,
    }];
  },
});

