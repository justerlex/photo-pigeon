/**
 * Tests for the wizard screens that do not ask questions.
 *
 * showOutro is the last thing anyone reads, and it carries the one instruction
 * the wizard cannot carry out itself: the downloaded client JSON is a password
 * and it is still lying in Downloads. So the wording is asserted, not assumed.
 */

import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Ask, InputQuestion } from './ask.js';
import type { FsLike } from './fs-like.js';
import { SUGGESTED_PROJECT_NAME } from './links.js';
import { showIntro, showOutro, stepCreateProject, type StepContext } from './steps.js';
import type { WizardIo } from './ui.js';

/** An fs that would throw if anything reached for it. These screens never do. */
const unusedFs: FsLike = {
  mkdir: () => Promise.reject(new Error('showOutro must not touch the file system')),
  readdir: () => Promise.reject(new Error('showOutro must not touch the file system')),
  stat: () => Promise.reject(new Error('showOutro must not touch the file system')),
  readFile: () => Promise.reject(new Error('showOutro must not touch the file system')),
  writeFile: () => Promise.reject(new Error('showOutro must not touch the file system')),
  rename: () => Promise.reject(new Error('showOutro must not touch the file system')),
};

function recordingContext(): { ctx: StepContext; text: () => string } {
  const lines: string[] = [];
  const io: WizardIo = {
    log(line = '') {
      lines.push(line);
    },
    async openUrl() {
      return false;
    },
  };
  const refusingAsk: Ask = {
    confirm: () => Promise.reject(new Error('this screen must not ask anything')),
    input: () => Promise.reject(new Error('this screen must not ask anything')),
  };
  return {
    ctx: { io, ask: refusingAsk, openLinks: false, fs: unusedFs },
    text: () => lines.join('\n'),
  };
}

const CONFIG_PATH = path.join('/home/casey/.photo-pigeon', 'config.json');
const DOWNLOAD = path.join('/home/casey/Downloads', 'client_secret_1234.apps.googleusercontent.com.json');

/**
 * Step 1 asks one question, so a fake Ask that answers it and hands back the
 * validator is the whole harness. Every confirm is a yes, because the screen
 * under test is the id question and not the loop above it.
 */
function askHarness(answer: string): { ask: Ask; validate: () => InputQuestion['validate'] } {
  let captured: InputQuestion['validate'];
  return {
    ask: {
      confirm: () => Promise.resolve(true),
      input: (question) => {
        captured = question.validate;
        return Promise.resolve(answer);
      },
    },
    validate: () => captured,
  };
}

describe('stepCreateProject, and the id that is not the name', () => {
  /**
   * The first stranger walk, 31-Jul-2026: the suggested name is also a real
   * project id owned by the maintainer, so pasting it aimed every later console
   * link at somebody else's project. The console answered with missing IAM
   * permissions and advice about Firebase, none of which names the real mistake.
   */
  it('refuses the suggested name pasted as an id, and says which is which', async () => {
    const { ctx } = recordingContext();
    const harness = askHarness('');
    ctx.ask = harness.ask;

    await stepCreateProject(ctx);
    const verdict = await harness.validate()?.(SUGGESTED_PROJECT_NAME);

    expect(typeof verdict).toBe('string');
    expect(verdict).toMatch(/name/i);
    expect(verdict).toMatch(/id/i);
  });

  it('still accepts the derived id that person actually has', async () => {
    const { ctx } = recordingContext();
    const harness = askHarness('');
    ctx.ask = harness.ask;

    await stepCreateProject(ctx);

    expect(await harness.validate()?.(`${SUGGESTED_PROJECT_NAME}-473829`)).toBe(true);
  });

  it('tells the reader the id is not the name before asking for it', async () => {
    const { ctx, text } = recordingContext();
    ctx.ask = askHarness('').ask;

    await stepCreateProject(ctx);

    const output = text();
    expect(output).toMatch(/is not the id/i);
    expect(output).toMatch(/ID column/i);
  });
});

describe('showOutro', () => {
  it('suggests deleting the downloaded client JSON, by its exact path', () => {
    const { ctx, text } = recordingContext();

    showOutro(ctx, CONFIG_PATH, ['/photos'], 'photo-pigeon-uploads', DOWNLOAD);

    const output = text();
    expect(output).toContain(DOWNLOAD);
    expect(output).toMatch(/password/);
    expect(output).toMatch(/deleting/i);
  });

  it('says photo-pigeon will not do the deleting, because it deletes nothing', () => {
    const { ctx, text } = recordingContext();

    showOutro(ctx, CONFIG_PATH, ['/photos'], undefined, DOWNLOAD);

    expect(text()).toMatch(/photo-pigeon will not/);
  });

  it('never suggests deleting the copy inside photo-pigeon\'s own folder', () => {
    const { ctx, text } = recordingContext();
    const ourOwnCopy = path.join('/home/casey/.photo-pigeon', 'credentials.json');

    showOutro(ctx, CONFIG_PATH, ['/photos'], undefined, ourOwnCopy);

    expect(text()).not.toContain(ourOwnCopy);
  });

  it('still prints the client warning and the config path when no source is known', () => {
    const { ctx, text } = recordingContext();

    showOutro(ctx, CONFIG_PATH, ['/photos']);

    const output = text();
    expect(output).toContain(CONFIG_PATH);
    expect(output).toMatch(/Keep that client/);
    expect(output).not.toMatch(/Worth deleting/);
  });
});

describe('showIntro', () => {
  it('says what uploads cost in storage before anyone spends time on setup', () => {
    const { ctx, text } = recordingContext();

    showIntro(ctx);

    const output = text();
    expect(output).toMatch(/original quality/);
    expect(output).toMatch(/Storage Saver does not apply/);
    expect(output).toMatch(/Nothing is ever deleted/);
  });
});
