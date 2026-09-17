/** Suppress repeat round-changing actions while pending and for a short cooldown. */
export function createActionGuard(cooldownMs = 600, now = () => performance.now()) {
  let pending = false;
  let nextAllowed = -Infinity;
  return async (action: () => Promise<void>): Promise<void> => {
    if (pending || now() < nextAllowed) return;
    pending = true;
    nextAllowed = now() + cooldownMs;
    try {
      await action();
    } finally {
      pending = false;
    }
  };
}
