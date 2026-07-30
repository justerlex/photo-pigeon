/**
 * The one rule about a watched folder path, and the two front ends that apply it.
 *
 * Setup asks for a folder and validates the answer. The status window's Watching
 * list adds and removes folders and has to validate them the same way, or the
 * two disagree about what a folder is and the window's list stops matching the
 * file. So the rule lives in one module and both callers reach for it, which is
 * what these tests are actually about.
 *
 * The case-insensitive half of the rule is not a nicety. It was a real defect
 * before this module existed: `askWatchChoices` refused a duplicate with
 * `watchDirs.includes(resolved)`, an exact string match, while the writer
 * (`dedupePaths` in `wizard/config.ts`) collapses two spellings of one Windows
 * folder into one entry. So typing `D:\Photos` and then `d:\photos` was accepted,
 * printed "Subfolders are included." as though it had taken, and then vanished
 * on the way to disk.
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { Ask } from './ask.js';
import { nodeFs } from './fs-like.js';
import { askWatchChoices, type StepContext } from './steps.js';
import type { WizardIo } from './ui.js';
import {
  ALREADY_ON_THE_LIST,
  checkWatchDir,
  NEEDS_A_PATH,
  sameWatchDir,
} from './watch-dirs.js';

/** Windows paths are case insensitive. Somewhere else they are not. */
const CASE_BLIND = process.platform === 'win32';

let work: string | undefined;

async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'pigeon-watchdirs-'));
  work = dir;
  return dir;
}

afterEach(async () => {
  if (work) await rm(work, { recursive: true, force: true });
  work = undefined;
});

/**
 * A front end that answers from a queue and re-asks on a refusal, which is what
 * both real front ends do: inquirer loops internally, and the NDJSON channel
 * re-emits the same ask carrying the core's sentence.
 *
 * A confirm reached with a string still in the queue means a typed question was
 * accepted that should have been refused, so it fails by name rather than by
 * type error three lines later.
 */
function scriptedAsk(script: (string | boolean)[]): { ask: Ask; refusals: () => string[] } {
  const queue = [...script];
  const refusals: string[] = [];
  const next = (): string | boolean => {
    if (queue.length === 0) throw new Error('the wizard asked one question more than the script has answers');
    return queue.shift()!;
  };
  return {
    refusals: () => refusals,
    ask: {
      async confirm(question) {
        const answer = next();
        if (typeof answer !== 'boolean') {
          throw new Error(
            `${question.message} is a yes or no question and the next scripted answer is ${JSON.stringify(answer)}, which means a typed answer was accepted that should have been refused`,
          );
        }
        return answer;
      },
      async input(question) {
        for (;;) {
          const answer = next();
          if (typeof answer !== 'string') {
            throw new Error(`${question.message} wants a line of text and the script offered ${JSON.stringify(answer)}`);
          }
          if (!question.validate) return answer;
          const verdict = await question.validate(answer);
          if (verdict === true) return answer;
          refusals.push(typeof verdict === 'string' ? verdict : 'refused');
        }
      },
    },
  };
}

function quietContext(ask: Ask): StepContext {
  const io: WizardIo = {
    log() {
      /* the screens' prose is not what these tests are about */
    },
    async openUrl() {
      return false;
    },
  };
  return { io, ask, openLinks: false, fs: nodeFs };
}

describe('the one rule about a watched folder', () => {
  it('refuses a blank answer in the words setup has always used', async () => {
    const verdict = await checkWatchDir('   ', [], nodeFs);
    expect(verdict).toEqual({ ok: false, why: NEEDS_A_PATH });
  });

  it('names the path it could not find', async () => {
    const dir = await scratch();
    const missing = path.join(dir, 'not-here');
    const verdict = await checkWatchDir(missing, [], nodeFs);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.why).toContain(missing);
  });

  it('strips the quotes Copy as path adds, and answers with the resolved folder', async () => {
    const dir = await scratch();
    const photos = path.join(dir, 'photos');
    await mkdir(photos);
    expect(await checkWatchDir(`"${photos}"`, [], nodeFs)).toEqual({ ok: true, dir: photos });
  });

  it('refuses a folder already on the list', async () => {
    const dir = await scratch();
    const photos = path.join(dir, 'photos');
    await mkdir(photos);
    expect(await checkWatchDir(photos, [photos], nodeFs)).toEqual({
      ok: false,
      why: ALREADY_ON_THE_LIST,
    });
  });

  it('reads two spellings of one Windows folder as one folder', async () => {
    // The comparison the writer uses, so a list the window built and a list the
    // wizard wrote can never disagree about how many folders there are.
    const dir = await scratch();
    const photos = path.join(dir, 'Photos');
    await mkdir(photos);
    expect(sameWatchDir(photos, photos.toLowerCase())).toBe(CASE_BLIND);

    const verdict = await checkWatchDir(photos.toLowerCase(), [photos], nodeFs);
    if (CASE_BLIND) {
      expect(verdict).toEqual({ ok: false, why: ALREADY_ON_THE_LIST });
    } else {
      expect(verdict.ok).toBe(true);
    }
  });
});

describe('setup applies exactly that rule', () => {
  it('refuses a second spelling of a folder it is already watching', async () => {
    // Red against the old code on Windows: `includes` said the lowercase form
    // was new, the screen said "Subfolders are included.", and `dedupePaths`
    // then dropped it on the way to disk. So the answer was taken, acknowledged
    // and silently discarded, which is the one thing a wizard may not do.
    if (!CASE_BLIND) return;
    const dir = await scratch();
    const photos = path.join(dir, 'Photos');
    const second = path.join(dir, 'Second');
    await mkdir(photos);
    await mkdir(second);

    const { ask, refusals } = scriptedAsk([photos, true, photos.toLowerCase(), second, false, false]);
    const choices = await askWatchChoices(quietContext(ask));

    expect(refusals()).toContain(ALREADY_ON_THE_LIST);
    expect(choices.watchDirs).toEqual([photos, second]);
  });

  it('refuses a folder that is not there, and takes the next answer', async () => {
    const dir = await scratch();
    const photos = path.join(dir, 'photos');
    await mkdir(photos);

    const { ask, refusals } = scriptedAsk([path.join(dir, 'gone'), photos, false, false]);
    const choices = await askWatchChoices(quietContext(ask));

    expect(refusals()[0]).toContain('No folder at');
    expect(choices.watchDirs).toEqual([photos]);
  });
});
