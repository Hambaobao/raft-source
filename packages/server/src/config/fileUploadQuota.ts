/** Deployment-wide monthly upload allowance in bytes; undefined keeps plan rules. */
export function configuredMonthlyFileUploadLimitBytes(): number | undefined {
  const raw = process.env.RAFT_MONTHLY_FILE_UPLOAD_LIMIT_BYTES?.trim();
  if (!raw) return undefined;
  if (raw === "-1") return -1;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new Error("RAFT_MONTHLY_FILE_UPLOAD_LIMIT_BYTES must be -1 or a non-negative safe integer (bytes)");
  }
  return Number(raw);
}
