import { describe, expect, it } from 'vitest';
import { summarizeQuarkCapacity } from './capacity-shared.js';

describe('summarizeQuarkCapacity', () => {
  it('calculates available capacity for normal accounts', () => {
    expect(summarizeQuarkCapacity(1000, 400)).toEqual({
      totalSize: 1000,
      usedSize: 400,
      availableSize: 600,
      usedPercent: 40,
      isOverLimit: false,
    });
  });

  it('clamps available capacity at zero when usage exceeds quota', () => {
    expect(summarizeQuarkCapacity(1000, 1200)).toEqual({
      totalSize: 1000,
      usedSize: 1200,
      availableSize: 0,
      usedPercent: 120,
      isOverLimit: true,
    });
  });
});

