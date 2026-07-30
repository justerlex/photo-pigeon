/** Small time helpers shared by the wizard and doctor. Pure, so they are easy to test. */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Whole days between two epoch millisecond timestamps, floored, never negative. */
export function daysBetween(earlierMs: number, laterMs: number): number {
  return Math.max(0, Math.floor((laterMs - earlierMs) / DAY));
}

/** A duration in milliseconds as something a person would say out loud. */
export function humanizeDuration(ms: number): string {
  if (ms < MINUTE) return 'just now';
  if (ms < HOUR) {
    const minutes = Math.round(ms / MINUTE);
    return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  }
  if (ms < DAY) {
    const hours = Math.round(ms / HOUR);
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  const days = Math.round(ms / DAY);
  if (days < 60) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.round(days / 30);
  return `about ${months} months ago`;
}
