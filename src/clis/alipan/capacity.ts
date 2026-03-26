import { formatBytes } from '../../download/progress.js';
import { CommandExecutionError } from '../../errors.js';
import { cli, Strategy } from '../../registry.js';
import { summarizeAliPanCapacity } from './capacity-shared.js';
import { alipanPostWithFallback } from './utils.js';

type AliPanDriveCapacityDetailsResponse = {
  drive_total_size?: number;
  drive_used_size?: number;
};

cli({
  site: 'alipan',
  name: 'capacity',
  description: 'Show AliPan total, used, and available storage',
  domain: 'www.alipan.com',
  strategy: Strategy.HEADER,
  browser: true,
  navigateBefore: false,
  args: [],
  columns: ['status', 'total_size', 'used_size', 'available_size', 'used_percent', 'endpoint'],
  func: async (page) => {
    if (!page) throw new CommandExecutionError('Browser page required for alipan capacity');

    await page.goto('https://www.alipan.com/drive/home');
    await page.wait(1);

    const capacityDetailsResult = await alipanPostWithFallback<AliPanDriveCapacityDetailsResponse>(page, [
      {
        url: 'https://api.aliyundrive.com/adrive/v1/user/driveCapacityDetails',
        body: {},
        injectDriveId: false,
      },
    ]);

    const totalSize = Number(capacityDetailsResult.data?.drive_total_size ?? 0);
    const usedSize = Number(capacityDetailsResult.data?.drive_used_size ?? 0);
    const summary = summarizeAliPanCapacity(totalSize, usedSize);

    return [{
      status: summary.isOverLimit ? 'over_limit' : 'ok',
      total_size: formatBytes(summary.totalSize),
      used_size: formatBytes(summary.usedSize),
      available_size: formatBytes(summary.availableSize),
      used_percent: `${summary.usedPercent}%`,
      endpoint: capacityDetailsResult.endpoint,
    }];
  },
});
