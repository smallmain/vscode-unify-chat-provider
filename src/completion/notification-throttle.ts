export class NotificationThrottle {
  private readonly lastShownAt = new Map<string, number>();

  constructor(private readonly throttleMs: number) {}

  shouldShow(key: string, now: number): boolean {
    const lastShownAt = this.lastShownAt.get(key);
    if (
      lastShownAt !== undefined &&
      now - lastShownAt < this.throttleMs
    ) {
      return false;
    }
    this.lastShownAt.set(key, now);
    return true;
  }
}
