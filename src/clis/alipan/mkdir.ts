import { CommandExecutionError } from '../../errors.js';
import { cli, Strategy } from '../../registry.js';
import { joinAliPanPath } from './upload-shared.js';
import {
  basenameAliPanMkdirPath,
  normalizeAliPanMkdirPath,
  splitAliPanMkdirPath,
} from './mkdir-shared.js';
import {
  alipanCreateFolder,
  alipanFindChildByName,
  type AliPanResolvedNode,
} from './utils.js';

cli({
  site: 'alipan',
  name: 'mkdir',
  description: 'Create a folder in AliPan',
  domain: 'www.alipan.com',
  strategy: Strategy.HEADER,
  browser: true,
  navigateBefore: false,
  args: [
    { name: 'path', required: true, positional: true, help: 'Folder path from root, e.g. /Movies/2026' },
    { name: 'parents', type: 'boolean', default: false, help: 'Create missing parent folders as needed' },
  ],
  columns: ['status', 'path', 'name', 'file_id', 'parent_file_id', 'created_at', 'updated_at', 'endpoint'],
  func: async (page, kwargs) => {
    if (!page) throw new CommandExecutionError('Browser page required for alipan mkdir');

    const rawPath = String(kwargs.path ?? '').trim();
    const parents = Boolean(kwargs.parents);
    const normalizedPath = normalizeAliPanMkdirPath(rawPath);
    if (normalizedPath === '/') {
      throw new CommandExecutionError('AliPan mkdir requires a non-root folder path');
    }

    const segments = splitAliPanMkdirPath(normalizedPath);
    const finalName = basenameAliPanMkdirPath(normalizedPath);
    if (!finalName || segments.length === 0) {
      throw new CommandExecutionError(`Invalid AliPan mkdir path: ${rawPath}`);
    }

    await page.goto('https://www.alipan.com/drive/home');
    await page.wait(1);

    let currentParentFileId = 'root';
    let currentPath = '/';
    let finalNode: AliPanResolvedNode | null = null;
    let endpoint = '';
    let createdCount = 0;

    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      const targetPath = joinAliPanPath(currentPath, segment);
      const isLast = index === segments.length - 1;
      const existing = await alipanFindChildByName(page, currentParentFileId, segment);

      if (existing?.file_id) {
        const existingType = String(existing.type ?? '');
        if (existingType && existingType !== 'folder') {
          throw new CommandExecutionError(`AliPan path segment is not a folder: ${targetPath}`);
        }
        currentParentFileId = String(existing.file_id);
        currentPath = targetPath;
        finalNode = {
          path: targetPath,
          name: String(existing.name ?? segment),
          type: 'folder',
          file_id: String(existing.file_id),
          parent_file_id: String(existing.parent_file_id ?? ''),
          size: Number(existing.size ?? 0),
          updated_at: String(existing.updated_at ?? ''),
          created_at: String(existing.created_at ?? ''),
        };
        continue;
      }

      if (!isLast && !parents) {
        throw new CommandExecutionError(
          `Parent folder does not exist: ${targetPath}. Re-run with --parents true to create missing folders.`,
        );
      }

      const created = await alipanCreateFolder(page, {
        parentFileId: currentParentFileId,
        folderName: segment,
        resolvedPath: targetPath,
      });

      createdCount += 1;
      endpoint = created.endpoint;
      currentParentFileId = created.file_id;
      currentPath = targetPath;
      finalNode = created;
    }

    if (!finalNode) {
      throw new CommandExecutionError(`AliPan mkdir failed to resolve target path: ${normalizedPath}`);
    }

    return [{
      status: createdCount > 0 ? 'created' : 'exists',
      path: finalNode.path || normalizedPath,
      name: finalNode.name || finalName,
      file_id: finalNode.file_id,
      parent_file_id: finalNode.parent_file_id,
      created_at: finalNode.created_at,
      updated_at: finalNode.updated_at,
      endpoint,
    }];
  },
});
