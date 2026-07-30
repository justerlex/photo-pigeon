/**
 * Exit codes and the one error type the commands throw on purpose.
 *
 * A CommandError is an expected, explainable stop: it prints as a sentence and
 * an optional hint, never as a stack trace. Anything else is a real crash.
 */

/** Process exit codes. Stable, so scripts and scheduled tasks can branch on them. */
export const EXIT = {
  /** Everything the command was asked to do, it did. */
  OK: 0,
  /** Something went wrong and the command could not finish. */
  FAILED: 1,
  /** No usable config yet: the user has not run setup. */
  NOT_CONFIGURED: 2,
  /**
   * The command ran fine and found something worth looking at.
   *
   * Two things wear this code, and they are the same shape: doctor finished its
   * checks and some of them failed, and `watch --once` finished its pass and
   * some files did not make it. In both cases the command did its job. Anything
   * that stopped the command from doing its job is FAILED instead.
   */
  PROBLEMS: 3,
  /** The feature is not present in this build. */
  UNAVAILABLE: 4,
  /**
   * Another photo-pigeon already holds the single instance lock on this ledger.
   *
   * Its own code since M3, and the reason is that this is the failure a shell
   * meets most often and the only one where retrying later is the right answer:
   * nothing is broken, somebody else is simply already delivering these
   * folders. Under `--events ndjson` the refusal is also a `failed` event
   * carrying the sentence and the pid, followed by `stopped`, which stays the
   * better signal for a shell because a code cannot name a pid.
   */
  ALREADY_RUNNING: 5,
  /** Interrupted twice, so we left without draining. */
  INTERRUPTED: 130,
} as const;

/** One of the EXIT values. */
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** An expected failure with a human sentence, an exit code, and optionally the next thing to try. */
export class CommandError extends Error {
  readonly code: number;
  readonly hint: string | undefined;

  constructor(message: string, code: number = EXIT.FAILED, hint?: string) {
    super(message);
    this.name = 'CommandError';
    this.code = code;
    this.hint = hint;
  }
}

/** The message of an unknown thrown value, without ever throwing itself. */
export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
