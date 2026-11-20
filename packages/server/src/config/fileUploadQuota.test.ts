import { afterEach, expect, test, vi } from "vitest";
import { configuredMonthlyFileUploadLimitBytes } from "./fileUploadQuota";

afterEach(() => vi.unstubAllEnvs());

test.each([
  [undefined, undefined], ["", undefined], ["  ", undefined],
  ["-1", -1], ["  -1  ", -1], ["0", 0], ["8000", 8000],
  ["9007199254740991", Number.MAX_SAFE_INTEGER],
])("parses deployment quota %s", (raw, expected) => {
  vi.stubEnv("RAFT_MONTHLY_FILE_UPLOAD_LIMIT_BYTES", raw);
  expect(configuredMonthlyFileUploadLimitBytes()).toBe(expected);
});

test.each(["-2", "1.5", "NaN", "Infinity", "100MiB", "9007199254740992", "1e3"])("rejects invalid quota %s", raw => {
  vi.stubEnv("RAFT_MONTHLY_FILE_UPLOAD_LIMIT_BYTES", raw);
  expect(configuredMonthlyFileUploadLimitBytes).toThrow(/must be -1 or a non-negative safe integer/);
});
