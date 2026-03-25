import { CommandExecutionError } from '../../errors.js';
import { cli, Strategy } from '../../registry.js';
import { alipanPostWithFallback, alipanResolvePath } from './utils.js';

type MoveResponse = {
  file_id?: string;
  parent_file_id?: string;
  updated_at?: string;
};

cli({
  site: 'alipan',
  name: 'move',
  description: 'Move a file/folder to another folder in AliPan',
  domain: 'www.alipan.com',
  strategy: Strategy.HEADER,
  browser: true,
  navigateBefore: false,
  args: [
    { name: 'file-id', required: false, positional: true, help: 'Target file_id' },
    { name: 'to-parent-file-id', required: false, positional: true, help: 'Destination parent folder file_id' },
    { name: 'path', default: '', help: 'Source file/folder path (alternative to file-id)' },
    { name: 'to-path', default: '', help: 'Destination folder path (alternative to to-parent-file-id)' },
  ],
  columns: ['status', 'file_id', 'path', 'to_parent_file_id', 'to_path', 'updated_at', 'endpoint'],
  func: async (page, kwargs) => {
    const fileIdArg = String(kwargs['file-id'] ?? '').trim();
    const toParentFileIdArg = String(kwargs['to-parent-file-id'] ?? '').trim();
    const pathArg = String(kwargs.path ?? '').trim();
    const toPathArg = String(kwargs['to-path'] ?? '').trim();

    if (!fileIdArg && !pathArg) {
      throw new CommandExecutionError('Provide source file-id positional argument or --path');
    }
    if (!toParentFileIdArg && !toPathArg) {
      throw new CommandExecutionError('Provide destination to-parent-file-id positional argument or --to-path');
    }

    await page!.goto('https://www.alipan.com/drive/home');
    await page!.wait(1);

    const sourceResolved = fileIdArg
      ? null
      : await alipanResolvePath(page, pathArg, 'all');
    const destResolved = toParentFileIdArg
      ? null
      : await alipanResolvePath(page, toPathArg, 'folder');

    const fileId = fileIdArg || sourceResolved!.file_id;
    const toParentFileId = toParentFileIdArg || destResolved!.file_id;

    const result = await alipanPostWithFallback<MoveResponse>(page, [
      {
        url: 'https://api.aliyundrive.com/v2/file/move',
        body: {
          file_id: fileId,
          to_parent_file_id: toParentFileId,
          to_drive_id: '$drive_id',
        },
      },
      {
        url: 'https://api.aliyundrive.com/v3/file/move',
        body: {
          file_id: fileId,
          to_parent_file_id: toParentFileId,
          to_drive_id: '$drive_id',
        },
      },
      {
        url: 'https://api.aliyundrive.com/v3/file/update',
        body: {
          file_id: fileId,
          parent_file_id: toParentFileId,
        },
      },
    ]);

    return [{
      status: 'success',
      file_id: result.data?.file_id ?? fileId,
      path: pathArg || '',
      to_parent_file_id: result.data?.parent_file_id ?? toParentFileId,
      to_path: toPathArg || '',
      updated_at: result.data?.updated_at ?? '',
      endpoint: result.endpoint,
    }];
  },
});
