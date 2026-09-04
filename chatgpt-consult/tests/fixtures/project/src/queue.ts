export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
}

export const retryDelay = (attempt: number, policy: RetryPolicy): number => {
  if (attempt < 1 || attempt > policy.maxAttempts) return 0;
  return policy.baseDelayMs * 2 ** (attempt - 1);
};
