import { CommandExecutionError } from '../../errors.js';
import { cli, Strategy } from '../../registry.js';
import { alipanPostWithFallback, alipanResolvePath } from './utils.js';

type RenameResponse = {
  file_id?: string;
  name?: string;
  parent_file_id?: string;
  updated_at?: string;
};

cli({
  site: 'alipan',
  name: 'rename',
  description: 'Rename a file/folder in AliPan',
  domain: 'www.alipan.com',
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
    const fileIdArg = String(kwargs['file-id'] ?? '').trim();
    const pathArg = String(kwargs.path ?? '').trim();
    const newName = String(kwargs['new-name'] ?? kwargs.name ?? '').trim();
    if (!fileIdArg && !pathArg) {
      throw new CommandExecutionError('Provide file-id positional argument or --path');
    }
    if (!newName) throw new CommandExecutionError('Missing required new-name');

    await page!.goto('https://www.alipan.com/drive/home');
    await page!.wait(1);

    const resolved = fileIdArg
      ? null
      : await alipanResolvePath(page, pathArg, 'all');
    const fileId = fileIdArg || resolved!.file_id;

    const result = await alipanPostWithFallback<RenameResponse>(page, [
      {
        url: 'https://api.aliyundrive.com/v3/file/update',
        body: { file_id: fileId, name: newName },
      },
      {
        url: 'https://api.aliyundrive.com/v2/file/update',
        body: { file_id: fileId, name: newName },
      },
    ]);

    return [{
      status: 'success',
      file_id: result.data?.file_id ?? fileId,
      path: pathArg || '',
      name: result.data?.name ?? newName,
      updated_at: result.data?.updated_at ?? '',
      endpoint: result.endpoint,
    }];
  },
});
