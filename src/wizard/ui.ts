/**
 * Console output for the wizard and doctor: one screen at a time, links that
 * are impossible to miss, no ceremony.
 */

import pc from 'picocolors';
import open from 'open';

/**
 * One thing the wizard said, with its weight kept rather than flattened into a
 * line of decorated text.
 *
 * The terminal does not need this: it wants the decorated line and nothing
 * else. A window does, because "note" and "hm" are a yellow word and a red one
 * in a console and a callout and an error in a page, and re-deriving that from
 * prose means parsing prose. So the helpers below emit a signal when the io
 * takes one and print when it does not, and neither front end sees the other's
 * shape.
 */
export type WizardSignal =
  | { kind: 'heading'; index: number; total: number; title: string }
  | { kind: 'line'; level: 'plain' | 'step' | 'note' | 'problem' | 'good'; text: string }
  | { kind: 'link'; url: string; opened: boolean };

/** Everything the wizard uses to talk to the outside world, so tests can hand in a quiet one. */
export interface WizardIo {
  /** Print a line. No argument prints a blank one. */
  log(line?: string): void;
  /** Try to open a URL in the default browser. Returns false when the machine has no browser to open. */
  openUrl(url: string): Promise<boolean>;
  /**
   * Take the structured form instead of the printed one.
   *
   * Present on the NDJSON channel and absent on the console, and the helpers
   * below call exactly one of the two so nothing is ever said twice.
   */
  emit?(signal: WizardSignal): void;
}

/** The real console. */
export const consoleIo: WizardIo = {
  log(line = '') {
    console.log(line);
  },
  async openUrl(url) {
    try {
      await open(url);
      return true;
    } catch {
      return false;
    }
  },
};

/** An io that swallows everything, for tests. */
export const silentIo: WizardIo = {
  log() {
    /* quiet */
  },
  async openUrl() {
    return false;
  },
};

const RULE = '─'.repeat(64);

/** The step banner: which step, out of how many, and what it is. */
export function heading(io: WizardIo, step: number, total: number, title: string): void {
  if (io.emit) {
    io.emit({ kind: 'heading', index: step, total, title });
    return;
  }
  io.log();
  io.log(pc.dim(RULE));
  io.log(`${pc.dim(`Step ${step} of ${total}`)}  ${pc.bold(title)}`);
  io.log(pc.dim(RULE));
}

/** A plain paragraph line. */
export function say(io: WizardIo, line = ''): void {
  if (io.emit) {
    io.emit({ kind: 'line', level: 'plain', text: line });
    return;
  }
  io.log(line);
}

/** A bulleted instruction. */
export function step(io: WizardIo, line: string): void {
  if (io.emit) {
    io.emit({ kind: 'line', level: 'step', text: line });
    return;
  }
  io.log(`  ${pc.dim('·')} ${line}`);
}

/** The link for a screen, printed even when we also open it: copy and paste has to stay possible. */
export function showLink(io: WizardIo, url: string): void {
  if (io.emit) {
    io.emit({ kind: 'link', url, opened: false });
    return;
  }
  io.log();
  io.log(`  ${pc.cyan(url)}`);
  io.log();
}

/** Something the user needs to hold on to. */
export function note(io: WizardIo, line: string): void {
  if (io.emit) {
    io.emit({ kind: 'line', level: 'note', text: line });
    return;
  }
  io.log(`  ${pc.yellow('note')} ${line}`);
}

/** Something that went wrong but is recoverable. */
export function problem(io: WizardIo, line: string): void {
  if (io.emit) {
    io.emit({ kind: 'line', level: 'problem', text: line });
    return;
  }
  io.log(`  ${pc.red('hm')}   ${line}`);
}

/** Something worked. */
export function good(io: WizardIo, line: string): void {
  if (io.emit) {
    io.emit({ kind: 'line', level: 'good', text: line });
    return;
  }
  io.log(`  ${pc.green('ok')}   ${line}`);
}

/** Prints the link and opens it, telling the user which of those happened. */
export async function openAndShow(io: WizardIo, url: string, canOpen: boolean): Promise<void> {
  if (io.emit) {
    // One event carrying both facts, rather than a link line and then a
    // sentence about it: a page renders a button differently when the browser
    // has already been sent there.
    const opened = canOpen ? await io.openUrl(url) : false;
    io.emit({ kind: 'link', url, opened });
    return;
  }
  showLink(io, url);
  if (!canOpen) return;
  const opened = await io.openUrl(url);
  if (opened) {
    io.log(pc.dim('  (opened in your browser)'));
    io.log();
  }
}
