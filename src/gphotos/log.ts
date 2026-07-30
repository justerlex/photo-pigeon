/**
 * The smallest logger this module needs.
 *
 * The transport has things worth saying out loud: a 429 nap, a quota warning,
 * a consent screen still stuck in Testing. It should say them without dragging
 * a logging framework into an npx-installable package.
 */

/** Somewhere to put a line of text. The CLI passes its own, tests pass a spy. */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
}

/** Writes to the console. Warnings go to stderr so piped output stays clean. */
export const consoleLogger: Logger = {
  info(message: string): void {
    console.log(message);
  },
  warn(message: string): void {
    console.error(message);
  },
};

/** Says nothing at all. Handy in tests and in dry runs. */
export const silentLogger: Logger = {
  info(): void {
    /* nothing */
  },
  warn(): void {
    /* nothing */
  },
};
