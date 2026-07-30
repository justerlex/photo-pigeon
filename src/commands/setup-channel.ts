/**
 * The setup wizard's machine channel.
 *
 * `photo-pigeon setup --events ndjson` is the seam the tray's first-run window
 * stands on. It is the same wizard the terminal runs, with its output behind
 * `WizardIo` as it always was and its **input** behind the `Ask` seam added at
 * M4, so there is one state machine and two front ends rather than two
 * wizards drifting apart.
 *
 * The contract is written down in `docs/ASK-PROTOCOL.md` and the shapes here
 * are the authority for it, exactly as `WatchEventBody` is the authority for
 * the watch stream. Three rules carry the whole design:
 *
 * 1. **One question is open at a time.** The core does not ask a second thing
 *    until the first is settled, so a window never has to reconcile two.
 * 2. **Every `answer` line is answered, including the ones that change
 *    nothing.** This is the M3 rule about the machine channel, applied to the
 *    one new form: a front end has exactly one reading of silence, that the
 *    core did not understand the word, and it acts on that reading. So an
 *    answer for a dead ask id gets a receipt saying so and naming the question
 *    that really is open.
 * 3. **Validation lives here, never in the page.** A rule the window
 *    re-implements is a rule that will disagree with the terminal one. A
 *    refused answer comes back with the core's own sentence and the same
 *    question is asked again carrying it.
 *
 * The one new stdin form is `answer <json>` and it is the only payload-carrying
 * line this project has. The six bare words are unchanged.
 */

import type { Ask, ConfirmQuestion, InputQuestion } from '../wizard/ask.js';
import type { WizardIo, WizardSignal } from '../wizard/ui.js';

/** The one word that carries a payload, and the whole of the M4 vocabulary growth. */
export const ANSWER_WORD = 'answer';

/** What a question wants back. */
export type AskKind = 'confirm' | 'input';

/** The weights the wizard says a line at. */
export type SayLevel = Extract<WizardSignal, { kind: 'line' }>['level'];

/** One thing that happened during setup, without its timestamp. */
export type SetupEventBody =
  /** The run is up, and where it is going to write. */
  | { type: 'setup-started'; pid: number; version?: string; configPath: string; steps: number }
  /** A new screen. */
  | { type: 'heading'; index: number; total: number; title: string }
  /** A line of the wizard's own prose, with the weight it was said at. */
  | { type: 'say'; level: SayLevel; text: string }
  /**
   * A console deep link.
   *
   * `opened` says whether the core handed it to the system browser. A page
   * shows it as text to copy and must never render it in a frame: the CSP
   * forbids that anyway, and no sign-in URL ever travels on this channel at
   * all. Consent is opened by the core, in the system browser, always.
   */
  | { type: 'link'; url: string; opened: boolean }
  /** The one open question. `error` is present when this is a re-ask. */
  | { type: 'ask'; id: string; kind: AskKind; message: string; default?: boolean | string; error?: string }
  /** The receipt for exactly one `answer` line. Never omitted. */
  | { type: 'answered'; id: string | null; accepted: boolean; error?: string; open?: string | null }
  /** The question is off the table without having been answered. */
  | { type: 'cancelled'; id: string }
  /** The wizard wrote the config and the run is about to sign in. */
  | { type: 'setup-written'; configPath: string; watchDirs: string[]; album?: string }
  /** Sign-in is happening in the system browser, and there is nothing to render. */
  | { type: 'signing-in' }
  /**
   * Setup is finished and the credentials really work.
   *
   * The moment it finished is the envelope's `at`, and the done screen's
   * postmark is drawn from it. There is deliberately no second timestamp field
   * here: `at` is already the instant this became true, sampled by `emit`, and
   * two names for one instant is one more thing that can disagree with itself.
   */
  | { type: 'setup-done'; configPath: string; ledgerPath: string }
  /** The run itself did not make it. */
  | { type: 'failed'; error: string }
  /** A stop was asked for. */
  | { type: 'stopping'; reason: 'stdin' | 'done' }
  /** The last line of a run, always. */
  | { type: 'stopped'; exitCode: number };

/**
 * One event on the wire: a body plus the moment it happened.
 *
 * `at` is stamped when the event is emitted, so it is when the thing happened
 * and not when a front end got round to rendering it. That difference is worth
 * a sentence because a front end has to render a moment exactly once: the
 * postmark on the setup window's done screen.
 */
export type SetupEvent = SetupEventBody & { at: string };

/** Thrown when the parent asked the run to stop while a question was open. */
export class SetupCancelled extends Error {
  constructor() {
    super('setup was cancelled');
    this.name = 'SetupCancelled';
  }
}

/** Where a channel writes. Injectable so the whole protocol is testable in process. */
export interface ChannelSinks {
  /** One JSON line per event. */
  out(line: string): void;
  /** Human prose, which never shares a descriptor with the events. */
  err(line: string): void;
  /**
   * Hand a console deep link to the system browser, from this process.
   *
   * The core opens links, never the page. That is the same rule the OAuth law
   * states and it is stated once for both: the webview has no opener
   * permission for an arbitrary URL and never will, so a link a page could
   * launch would need a capability this app deliberately does not grant.
   * Absent means print only, which is what `--no-open` asks for.
   */
  openUrl?(url: string): Promise<boolean>;
}

/** What `createSetupChannel` hands back. */
export interface SetupChannel {
  io: WizardIo;
  ask: Ask;
  emit(body: SetupEventBody): void;
  /** Feed one line of stdin. Returns false when the line asked the run to stop. */
  line(raw: string): boolean;
  /** End of file, or an explicit stop word. Rejects any open question. */
  cancel(): void;
}

interface Pending {
  id: string;
  kind: AskKind;
  message: string;
  default?: boolean | string;
  validate?: (value: string) => boolean | string | Promise<boolean | string>;
  settle(value: boolean | string): void;
  fail(error: Error): void;
}

/**
 * Coerces whatever JSON arrived into the shape the open question wants.
 *
 * A window sends a real boolean for a confirm and a real string for an input,
 * and this is forgiving about the near misses rather than strict about them,
 * because the alternative is a first-run window that cannot be finished over a
 * one character difference. Anything genuinely unusable is refused by name.
 */
function coerce(kind: AskKind, value: unknown): { ok: true; value: boolean | string } | { ok: false; why: string } {
  if (kind === 'confirm') {
    if (typeof value === 'boolean') return { ok: true, value };
    if (value === 'yes' || value === 'true') return { ok: true, value: true };
    if (value === 'no' || value === 'false') return { ok: true, value: false };
    return { ok: false, why: 'that question wants true or false' };
  }
  if (typeof value === 'string') return { ok: true, value };
  if (value === undefined || value === null) return { ok: true, value: '' };
  if (typeof value === 'number') return { ok: true, value: String(value) };
  return { ok: false, why: 'that question wants a line of text' };
}

/**
 * Builds the NDJSON front end.
 *
 * `now` is injectable because every event carries the moment it happened and a
 * test that cannot fix time cannot assert on the envelope.
 */
export function createSetupChannel(
  sinks: ChannelSinks,
  now: () => number = Date.now,
): SetupChannel {
  let pending: Pending | undefined;
  let nextId = 1;
  let stopped = false;

  const emit = (body: SetupEventBody): void => {
    sinks.out(JSON.stringify({ ...body, at: new Date(now()).toISOString() }));
  };

  const askFor = (
    kind: AskKind,
    message: string,
    fallback: boolean | string | undefined,
    validate: Pending['validate'],
    signal: AbortSignal | undefined,
  ): Promise<boolean | string> =>
    new Promise<boolean | string>((resolve, reject) => {
      if (stopped) {
        reject(new SetupCancelled());
        return;
      }
      const id = String(nextId++);
      const entry: Pending = {
        id,
        kind,
        message,
        ...(fallback === undefined ? {} : { default: fallback }),
        ...(validate ? { validate } : {}),
        settle: (value) => {
          pending = undefined;
          if (signal) signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        fail: (error) => {
          pending = undefined;
          if (signal) signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      };
      function onAbort(): void {
        if (pending?.id !== id) return;
        emit({ type: 'cancelled', id });
        entry.fail(new SetupCancelled());
      }
      if (signal) {
        if (signal.aborted) {
          reject(new SetupCancelled());
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      pending = entry;
      emit({
        type: 'ask',
        id,
        kind,
        message,
        ...(fallback === undefined ? {} : { default: fallback }),
      });
    });

  /** Re-ask the same question, carrying the sentence that refused the last answer. */
  const reask = (entry: Pending, error: string): void => {
    pending = entry;
    emit({
      type: 'ask',
      id: entry.id,
      kind: entry.kind,
      message: entry.message,
      ...(entry.default === undefined ? {} : { default: entry.default }),
      error,
    });
  };

  const takeAnswer = (payload: string): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload) as unknown;
    } catch {
      emit({
        type: 'answered',
        id: null,
        accepted: false,
        error: `${ANSWER_WORD} takes one JSON object, {"id":"<the ask id>","value":<the answer>}`,
        open: pending?.id ?? null,
      });
      return;
    }
    const record = (parsed ?? {}) as { id?: unknown; value?: unknown };
    const id = typeof record.id === 'string' ? record.id : null;

    if (!pending || id === null || id !== pending.id) {
      emit({
        type: 'answered',
        id,
        accepted: false,
        error: pending
          ? 'that is not the question that is open'
          : 'that is not the question that is open, because none is',
        open: pending?.id ?? null,
      });
      return;
    }

    const entry = pending;
    const shaped = coerce(entry.kind, record.value);
    if (!shaped.ok) {
      emit({ type: 'answered', id, accepted: false, error: shaped.why, open: id });
      reask(entry, shaped.why);
      return;
    }

    // The question is off the table while validation runs, so a second answer
    // arriving in that window is a dead id rather than a race.
    pending = undefined;
    const finish = (verdict: boolean | string): void => {
      if (verdict === true) {
        emit({ type: 'answered', id, accepted: true });
        entry.settle(shaped.value);
        return;
      }
      const why = typeof verdict === 'string' ? verdict : 'that answer was refused';
      emit({ type: 'answered', id, accepted: false, error: why, open: id });
      reask(entry, why);
    };

    if (!entry.validate || entry.kind !== 'input') {
      finish(true);
      return;
    }
    void Promise.resolve(entry.validate(shaped.value as string)).then(finish, (error: unknown) => {
      finish(error instanceof Error ? error.message : 'that answer was refused');
    });
  };

  return {
    io: {
      log() {
        /* prose travels as `say` events, never as bare lines on the pipe */
      },
      emit(signal) {
        if (signal.kind === 'heading') {
          emit({ type: 'heading', index: signal.index, total: signal.total, title: signal.title });
          return;
        }
        if (signal.kind === 'link') {
          emit({ type: 'link', url: signal.url, opened: signal.opened });
          return;
        }
        emit({ type: 'say', level: signal.level, text: signal.text });
      },
      async openUrl(url) {
        return sinks.openUrl ? sinks.openUrl(url) : false;
      },
    },
    ask: {
      confirm: (question: ConfirmQuestion) =>
        askFor('confirm', question.message, question.default, undefined, undefined) as Promise<boolean>,
      input: (question: InputQuestion) =>
        askFor(
          'input',
          question.message,
          question.default,
          question.validate,
          question.signal,
        ) as Promise<string>,
    },
    emit,
    line(raw) {
      const trimmed = raw.trim();
      if (trimmed === '') return true;
      const space = trimmed.indexOf(' ');
      const word = (space < 0 ? trimmed : trimmed.slice(0, space)).toLowerCase();
      if (word === ANSWER_WORD) {
        takeAnswer(space < 0 ? '' : trimmed.slice(space + 1));
        return true;
      }
      if (word === 'stop' || word === 'quit') return false;
      // Every other word is answered by name rather than swallowed, exactly as
      // a watch answers one. The four watch words are named on purpose: they
      // are the ones a shell is most likely to send here by mistake.
      const heard = JSON.stringify(trimmed.length > 60 ? `${trimmed.slice(0, 60)}...` : trimmed);
      sinks.err(
        `${heard} is not a command setup understands on stdin. Setup takes stop, quit, and ${ANSWER_WORD} {"id":"...","value":...}, one to a line. detach, pause, resume and rescan belong to a watch.`,
      );
      return true;
    },
    cancel() {
      stopped = true;
      const entry = pending;
      if (!entry) return;
      pending = undefined;
      emit({ type: 'cancelled', id: entry.id });
      entry.fail(new SetupCancelled());
    },
  };
}
