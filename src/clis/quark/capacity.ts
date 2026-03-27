import { formatBytes } from '../../download/progress.js';
import { CommandExecutionError } from '../../errors.js';
import { cli, Strategy } from '../../registry.js';
import { summarizeQuarkCapacity } from './capacity-shared.js';
import { QUARK_DRIVE_ORIGIN, QUARK_WEB_ORIGIN, quarkRequestWithFallback } from './utils.js';

type QuarkMemberInfoResponse = {
  user?: {
    memberInfo?: {
      use_capacity?: number;
      total_capacity?: number;
    };
  };
  memberInfo?: {
    use_capacity?: number;
    total_capacity?: number;
  };
  use_capacity?: number;
  total_capacity?: number;
};

cli({
  site: 'quark',
  name: 'capacity',
  description: 'Show Quark total, used, and available storage',
  domain: 'pan.quark.cn',
  strategy: Strategy.HEADER,
  browser: true,
  navigateBefore: false,
  args: [],
  columns: ['status', 'total_size', 'used_size', 'available_size', 'used_percent', 'endpoint'],
  func: async (page) => {
    if (!page) throw new CommandExecutionError('Browser page required for quark capacity');

    await page.goto(`${QUARK_WEB_ORIGIN}/list#/list/all`);
    await page.wait(1);

    const result = await quarkRequestWithFallback<QuarkMemberInfoResponse>(page, [
      {
        url: `${QUARK_DRIVE_ORIGIN}/1/clouddrive/member`,
        method: 'GET',
        params: {
          fetch_subscribe: 1,
          fetch_identity: 1,
          _ch: 'home',
        },
      },
    ]);

    const memberInfo = result.data?.user?.memberInfo ?? result.data?.memberInfo ?? result.data;
    const totalSize = Number(memberInfo?.total_capacity ?? 0);
    const usedSize = Number(memberInfo?.use_capacity ?? 0);
    const summary = summarizeQuarkCapacity(totalSize, usedSize);

    return [{
      status: summary.isOverLimit ? 'over_limit' : 'ok',
      total_size: formatBytes(summary.totalSize),
      used_size: formatBytes(summary.usedSize),
      available_size: formatBytes(summary.availableSize),
      used_percent: `${summary.usedPercent}%`,
      endpoint: result.endpoint,
    }];
  },
});

