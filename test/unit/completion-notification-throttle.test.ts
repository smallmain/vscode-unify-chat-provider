import { describe, expect, it } from 'vitest';
import { NotificationThrottle } from '../../src/completion/notification-throttle';

describe('completion notification throttle', () => {
  it('suppresses repeated keys inside the throttle window', () => {
    const throttle = new NotificationThrottle(60_000);

    expect(throttle.shouldShow('missing-model', 1_000)).toBe(true);
    expect(throttle.shouldShow('missing-model', 60_999)).toBe(false);
    expect(throttle.shouldShow('other-error', 60_999)).toBe(true);
    expect(throttle.shouldShow('missing-model', 61_000)).toBe(true);
  });
});
