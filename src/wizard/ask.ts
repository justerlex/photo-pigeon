/**
 * The wizard's input seam.
 *
 * The wizard's *output* has sat behind `WizardIo` since the first version, so a
 * test could run the whole walk quietly. Its *input* did not: `steps.ts`
 * imported `confirm` and `input` from `@inquirer/prompts` and called them, and
 * `requireInteractive()` refused anything without a TTY. That is exactly the
 * condition a sidecar spawned by the tray is in, so the window could not reuse
 * the state machine and would have had to grow a second copy of it.
 *
 * This is the other half of the pair. One state machine, two front ends:
 *
 *   terminal   `terminalAsk` wraps @inquirer/prompts, unchanged behaviour
 *   window     `src/commands/setup-channel.ts` asks over NDJSON, and the
 *              answer comes back on stdin as the one payload-carrying form
 *              M4 is allowed to add. docs/ASK-PROTOCOL.md is the contract.
 *
 * The interface is deliberately two methods and no more. Every question the
 * wizard asks is a yes/no or a line of text, and a seam that can express more
 * than the caller needs is a seam the two front ends will drift across.
 */

/** What a yes or no question needs. */
export interface ConfirmQuestion {
  message: string;
  default?: boolean;
}

/**
 * What a typed-answer question needs.
 *
 * `validate` runs on whichever side is holding the state machine, which is the
 * core in both front ends. A window never re-implements a rule: it shows the
 * sentence the core sent back and asks again.
 */
export interface InputQuestion {
  message: string;
  default?: string;
  validate?: (value: string) => boolean | string | Promise<boolean | string>;
  /** Cancels a question that is no longer wanted, as the Downloads race does. */
  signal?: AbortSignal;
}

/** Everything the wizard uses to ask the person a question. */
export interface Ask {
  confirm(question: ConfirmQuestion): Promise<boolean>;
  input(question: InputQuestion): Promise<string>;
  /**
   * Refuse early if this front end cannot work here.
   *
   * Only the terminal one can fail this way, and it is the whole of what
   * `requireInteractive` used to be. A front end that does not implement it is
   * a front end that has its own channel and does not need a TTY, which is the
   * entire point of the seam.
   */
  ensureUsable?(): void;
}

/** The message a terminal wizard gives when it has nowhere to ask. */
export const NO_TERMINAL_MESSAGE =
  'The setup wizard needs a terminal it can ask questions in. Run photo-pigeon setup directly, not through a pipe or a service wrapper.';

/**
 * The terminal front end: @inquirer/prompts, exactly as the wizard always used
 * it, now reached through the seam instead of imported at the call site.
 *
 * The import is lazy so that a sidecar running `setup --events ndjson` never
 * loads the prompt stack at all. That matters beyond startup cost: it is what
 * lets the bundler mark `@inquirer/prompts` external once the console path is
 * gone, because the one code path a brand-new user hits first no longer
 * reaches it.
 */
export const terminalAsk: Ask = {
  async confirm(question) {
    const { confirm } = await import('@inquirer/prompts');
    return confirm({
      message: question.message,
      ...(question.default === undefined ? {} : { default: question.default }),
    });
  },
  async input(question) {
    const { input } = await import('@inquirer/prompts');
    const config: Parameters<typeof input>[0] = { message: question.message };
    if (question.default !== undefined) config.default = question.default;
    if (question.validate) config.validate = question.validate;
    return question.signal
      ? input(config, { signal: question.signal })
      : input(config);
  },
  ensureUsable() {
    if (!process.stdin.isTTY) throw new Error(NO_TERMINAL_MESSAGE);
  },
};
