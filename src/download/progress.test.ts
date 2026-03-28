import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProgressBar } from './progress.js';

describe('progress bar rendering', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throttles duplicate renders for the same percentage', () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const nowSpy = vi.spyOn(Date, 'now');
    const bar = createProgressBar('sample.bin', 0, 1);

    nowSpy.mockReturnValue(0);
    bar.update(1, 100);

    nowSpy.mockReturnValue(10);
    bar.update(1, 100);

    nowSpy.mockReturnValue(20);
    bar.update(1, 100);

    nowSpy.mockReturnValue(200);
    bar.update(1, 100);

    expect(writeSpy).toHaveBeenCalledTimes(2);
  });

  it('renders immediately when the label changes', () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const nowSpy = vi.spyOn(Date, 'now');
    const bar = createProgressBar('sample.bin', 0, 1);

    nowSpy.mockReturnValue(0);
    bar.update(25, 100, 'attempt 1/2');

    nowSpy.mockReturnValue(10);
    bar.update(25, 100, 'attempt 2/2');

    expect(writeSpy).toHaveBeenCalledTimes(2);
  });
});
