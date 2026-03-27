import { CommandExecutionError } from '../../errors.js';
import { cli, Strategy } from '../../registry.js';
import {
  QUARK_DRIVE_ORIGIN,
  QUARK_WEB_ORIGIN,
  normalizeQuarkParentFileId,
  quarkRequestWithFallback,
  quarkResolvePath,
} from './utils.js';

type MoveResponse = {
  task_id?: string;
  updated_at?: string;
};

cli({
  site: 'quark',
  name: 'move',
  description: 'Move a file/folder to another folder in Quark',
  domain: 'pan.quark.cn',
  strategy: Strategy.HEADER,
  browser: true,
  navigateBefore: false,
  args: [
    { name: 'file-id', required: false, positional: true, help: 'Target file_id' },
    { name: 'to-parent-file-id', required: false, positional: true, help: 'Destination parent folder file_id' },
    { name: 'path', default: '', help: 'Source file/folder path (alternative to file-id)' },
    { name: 'to-path', default: '', help: 'Destination folder path (alternative to to-parent-file-id)' },
  ],
  columns: ['status', 'file_id', 'path', 'to_parent_file_id', 'to_path', 'task_id', 'endpoint'],
  func: async (page, kwargs) => {
    if (!page) throw new CommandExecutionError('Browser page required for quark move');

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

    await page.goto(`${QUARK_WEB_ORIGIN}/list#/list/all`);
    await page.wait(1);

    const sourceResolved = fileIdArg
      ? null
      : await quarkResolvePath(page, pathArg, 'all');
    const destResolved = toParentFileIdArg
      ? null
      : await quarkResolvePath(page, toPathArg, 'folder');

    const fileId = fileIdArg || sourceResolved!.file_id;
    const toParentFileId = normalizeQuarkParentFileId(toParentFileIdArg || destResolved!.file_id);

    const result = await quarkRequestWithFallback<MoveResponse>(page, [
      {
        url: `${QUARK_DRIVE_ORIGIN}/1/clouddrive/file/move`,
        body: {
          action_type: 1,
          to_pdir_fid: toParentFileId,
          filelist: [fileId],
          exclude_fids: [],
          lock_concurr_op: 1,
        },
      },
    ]);

    return [{
      status: 'success',
      file_id: fileId,
      path: pathArg || '',
      to_parent_file_id: toParentFileId,
      to_path: toPathArg || '',
      task_id: result.data?.task_id ?? '',
      endpoint: result.endpoint,
    }];
  },
});

