/**
 * The sign-in step of a setup run that is talking to a window, not a terminal.
 *
 * Two guarantees, both found by the M4 rig against the real binary and both
 * invisible from inside `createSetupChannel`, because the thing that broke
 * them is the layer above it: the Google Photos client the command builds.
 *
 * 1. **stdout stays the event stream.** The gphotos module has prose worth
 *    saying and its default sink writes `info` to `console.log`. Under
 *    `--events ndjson` that is the machine channel, so four lines of English
 *    landed in a stream a parser is entitled to read strictly. One of them was
 *    the consent URL, which is the OAuth law's business: a window must never be
 *    able to render the consent screen, and a URL it can read off the wire is
 *    the first half of being able to.
 *
 * 2. **The cancel reaches the consent wait.** The wizard's cancel fails the
 *    question that is open, and past the last question there is none. The run
 *    then sat in the loopback wait holding a live listener for the full five
 *    minute timeout, so a window closed mid sign-in left a process behind.
 */

import { describe, expect, it, vi } from 'vitest';

import type { AppConfig, GPhotosClient } from '../contracts.js';
import { runSetup, type SetupIo } from './setup.js';
import type { Runtime, SpeakingOptions } from './runtime.js';

const CONFIG: AppConfig = {
  watchDirs: ['C:\\temp\\watch'],
  credentialsPath: 'C:\\temp\\credentials.json',
  tokenPath: 'C:\\temp\\token.json',
  ledgerPath: 'C:\\temp\\ledger.jsonl',
  extensions: ['.png'],
} as AppConfig;

/** Collects stdout and lets a test push lines in, the way a shell would. */
function fakeIo(): SetupIo & { lines: string[]; send: (line: string) => void; end: () => void } {
  const lines: string[] = [];
  let onLine: (line: string) => void = () => {};
  let onEnd: () => void = () => {};
  return {
    lines,
    out: (line) => void lines.push(line),
    onLine: (handler) => void (onLine = handler),
    onEnd: (handler) => void (onEnd = handler),
    close: () => {},
    send: (line) => onLine(line),
    end: () => onEnd(),
  };
}

/**
 * A runtime whose sign-in never returns on its own, exactly like a consent
 * screen nobody is going to answer. It resolves only when the signal it was
 * handed aborts, which is the behaviour under test.
 */
function runtimeWaitingForConsent(seen: { speaking?: SpeakingOptions }): Runtime {
  return {
    runWizard: async () => CONFIG,
    createClient: async (_config: AppConfig, speaking: SpeakingOptions = {}) => {
      seen.speaking = speaking;
      return {
        async ensureAuth(): Promise<void> {
          await new Promise<void>((resolve, reject) => {
            const signal = speaking.signal;
            if (!signal) return; // never settles, which is the bug this guards
            if (signal.aborted) {
              reject(new Error('cancelled'));
              return;
            }
            signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
            void resolve;
          });
        },
      } as unknown as GPhotosClient;
    },
    pigeonPaths: async () => ({
      configPath: 'C:\\temp\\config.json',
      ledgerPath: CONFIG.ledgerPath,
    }),
  } as unknown as Runtime;
}

/**
 * A runtime whose sign-in simply works, which is the only way a test reaches
 * the done event at all: the real one wants a browser and a Google account.
 */
function runtimeThatSignsIn(): Runtime {
  return {
    runWizard: async () => CONFIG,
    createClient: async () =>
      ({
        async ensureAuth(): Promise<void> {},
      }) as unknown as GPhotosClient,
    pigeonPaths: async () => ({
      configPath: 'C:\\temp\\config.json',
      ledgerPath: CONFIG.ledgerPath,
    }),
  } as unknown as Runtime;
}

describe('a setup run signing in on the machine channel', () => {
  it('hands the client the stderr speaker, so no prose can reach the event stream', async () => {
    const seen: { speaking?: SpeakingOptions } = {};
    const io = fakeIo();
    // Cancel as soon as sign-in is reached, so the test does not wait on a
    // consent screen. What is being asserted is what the client was given.
    const runtime = runtimeWaitingForConsent(seen);
    const run = runSetup({ events: 'ndjson' }, runtime, undefined, io);
    await new Promise((resolve) => setTimeout(resolve, 10));
    io.end();
    await run;

    expect(seen.speaking?.logger, 'the client was built with no logger, so it writes to stdout').toBeDefined();
    expect(seen.speaking?.signal, 'the client was built with no signal, so a cancel cannot reach it').toBeDefined();
  });

  it('stops on the cancel instead of waiting out the consent screen', async () => {
    const seen: { speaking?: SpeakingOptions } = {};
    const io = fakeIo();
    const run = runSetup({ events: 'ndjson' }, runtimeWaitingForConsent(seen), undefined, io);

    await new Promise((resolve) => setTimeout(resolve, 10));
    // The parent's pipe closing IS the cancel. Nothing else is.
    io.end();

    // Without the signal this await never returns.
    const code = await run;
    expect(code).toBe(0);

    const types = io.lines.map((line) => (JSON.parse(line) as { type: string }).type);
    expect(types).toContain('signing-in');
    expect(types.at(-1)).toBe('stopped');
  });

  it('carries the moment it finished on the done event, for the postmark to read', async () => {
    // The done screen draws a postmark with a date on it, and it used to be the
    // page's own `new Date()` at render time: the machine's date when the window
    // got round to drawing, which is not the same fact. The moment is the
    // envelope's `at`, sampled by `emit` when the event is true, and this is the
    // first test to reach the done event at all, because reaching it means
    // signing in.
    //
    // Honest about what this is: a pin, not a red test. `at` has been on every
    // event since the channel was written, so nothing core-side had to change
    // for the postmark to be right. What was missing was a page reading it, and
    // that half is red in `ui-pages.test.ts` against the old code.
    const io = fakeIo();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-30T18:41:07.000Z'));
    try {
      expect(await runSetup({ events: 'ndjson' }, runtimeThatSignsIn(), undefined, io)).toBe(0);
    } finally {
      vi.useRealTimers();
    }

    const events = io.lines.map((line) => JSON.parse(line) as { type: string; at?: string });
    const done = events.find((event) => event.type === 'setup-done');
    expect(done, 'the run never reached the done event').toBeDefined();
    expect(done?.at).toBe('2026-07-30T18:41:07.000Z');
    // And it is a moment a front end can really turn into a date, rather than
    // a string that only looks like one.
    expect(Number.isNaN(new Date(done!.at!).getTime())).toBe(false);
    expect(events.at(-1)?.type).toBe('stopped');
  });

  it('says every line it says as JSON, because stdout belongs to the stream', async () => {
    const seen: { speaking?: SpeakingOptions } = {};
    const io = fakeIo();
    const run = runSetup({ events: 'ndjson' }, runtimeWaitingForConsent(seen), undefined, io);
    await new Promise((resolve) => setTimeout(resolve, 10));
    io.end();
    await run;

    expect(io.lines.length).toBeGreaterThan(0);
    for (const line of io.lines) {
      expect(() => JSON.parse(line), `not JSON: ${line}`).not.toThrow();
    }
  });
});
