import { CommandExecutionError } from '../../errors.js';
import { cli, Strategy } from '../../registry.js';
import {
  QUARK_WEB_ORIGIN,
  type QuarkFileItem,
  joinQuarkPath,
  normalizeQuarkFileType,
  normalizeQuarkPath,
  quarkCreateFolder,
  quarkFindChildByName,
} from './utils.js';

cli({
  site: 'quark',
  name: 'mkdir',
  description: 'Create a folder in Quark',
  domain: 'pan.quark.cn',
  strategy: Strategy.HEADER,
  browser: true,
  navigateBefore: false,
  args: [
    { name: 'path', required: true, positional: true, help: 'Folder path from root, e.g. /Movies/2026' },
    { name: 'parents', type: 'boolean', default: false, help: 'Create missing parent folders as needed' },
  ],
  columns: ['status', 'path', 'name', 'file_id', 'parent_file_id', 'endpoint'],
  func: async (page, kwargs) => {
    if (!page) throw new CommandExecutionError('Browser page required for quark mkdir');

    const rawPath = String(kwargs.path ?? '').trim();
    const parents = Boolean(kwargs.parents);
    const targetPath = normalizeQuarkPath(rawPath);
    if (!rawPath || targetPath === '/') {
      throw new CommandExecutionError('Provide a folder path below root, e.g. /Movies/2026');
    }

    await page.goto(`${QUARK_WEB_ORIGIN}/list#/list/all`);
    await page.wait(1);

    const segments = targetPath.split('/').map(segment => segment.trim()).filter(Boolean);
    let parentFileId = '0';
    let currentPath = '/';
    let lastEndpoint = '';
    let createdAny = false;
    let lastItem: QuarkFileItem | null = null;

    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      const nextPath = joinQuarkPath(currentPath, segment);
      const existing = await quarkFindChildByName(page, parentFileId, segment);

      if (existing?.fid) {
        if (normalizeQuarkFileType(existing) !== 'folder') {
          throw new CommandExecutionError(`Quark mkdir path is blocked by a file: ${nextPath}`);
        }
        lastItem = existing;
        parentFileId = String(existing.fid);
        currentPath = nextPath;
        continue;
      }

      if (!parents && index < segments.length - 1) {
        throw new CommandExecutionError(`Parent folder does not exist: ${nextPath}. Re-run with --parents true`);
      }

      const created = await quarkCreateFolder(page, {
        parentFileId,
        folderName: segment,
      });
      createdAny = true;
      lastEndpoint = created.endpoint;
      lastItem = created.item;
      parentFileId = String(created.item.fid ?? '');
      currentPath = nextPath;
    }

    if (!lastItem?.fid) {
      throw new CommandExecutionError(`Quark mkdir completed but could not determine the created folder: ${targetPath}`);
    }

    return [{
      status: createdAny ? 'created' : 'exists',
      path: currentPath,
      name: String(lastItem.file_name ?? segments[segments.length - 1] ?? ''),
      file_id: String(lastItem.fid ?? ''),
      parent_file_id: String(lastItem.pdir_fid ?? ''),
      endpoint: lastEndpoint,
    }];
  },
});
