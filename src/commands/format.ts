/** Small formatting helpers shared by the commands. No colors here, only text. */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

/** Byte count as something a person reads at a glance, for example '2.4 MB'. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

/** Thousands separated count, always the same separator whatever the machine locale is. */
export function formatCount(count: number): string {
  return Math.trunc(count).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** '1 file' or '3 files'. */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${formatCount(count)} ${count === 1 ? one : many}`;
}

/** Seconds, rounded, for retry messages. */
export function formatSeconds(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  return `${seconds}s`;
}
