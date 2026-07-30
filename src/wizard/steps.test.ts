/**
 * Tests for the wizard screens that do not ask questions.
 *
 * showOutro is the last thing anyone reads, and it carries the one instruction
 * the wizard cannot carry out itself: the downloaded client JSON is a password
 * and it is still lying in Downloads. So the wording is asserted, not assumed.
 */

import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { FsLike } from './fs-like.js';
import { showIntro, showOutro, type StepContext } from './steps.js';
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
  return {
    ctx: { io, openLinks: false, fs: unusedFs },
    text: () => lines.join('\n'),
  };
}

const CONFIG_PATH = path.join('/home/casey/.photo-pigeon', 'config.json');
const DOWNLOAD = path.join('/home/casey/Downloads', 'client_secret_1234.apps.googleusercontent.com.json');

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
