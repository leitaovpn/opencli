export type AliPanCapacitySummary = {
  totalSize: number;
  usedSize: number;
  availableSize: number;
  usedPercent: number;
  isOverLimit: boolean;
};

function toSafeNonNegativeNumber(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return value;
}

export function summarizeAliPanCapacity(totalSize: number, usedSize: number): AliPanCapacitySummary {
  const safeTotalSize = toSafeNonNegativeNumber(totalSize);
  const safeUsedSize = toSafeNonNegativeNumber(usedSize);
  const availableRaw = safeTotalSize - safeUsedSize;

  return {
    totalSize: safeTotalSize,
    usedSize: safeUsedSize,
    availableSize: Math.max(availableRaw, 0),
    usedPercent: safeTotalSize > 0
      ? Number(((safeUsedSize / safeTotalSize) * 100).toFixed(1))
      : 0,
    isOverLimit: availableRaw < 0,
  };
}
