#!/usr/bin/env node
/**
 * photo-pigeon.
 *
 * Point it at a folder. Anything that lands there arrives in Google Photos.
 * One direction, upload only, using credentials that belong to you.
 */

import { createRequire } from 'node:module';

import { Command } from 'commander';

import { registerCommands } from './commands/index.js';
import { EXIT, messageOf } from './commands/errors.js';
import { STDIN_WORDS, STORAGE_HONESTY } from './commands/watch.js';

const requireFromHere = createRequire(import.meta.url);
const pkg = requireFromHere('../package.json') as { version: string };

const program = new Command();

program
  .name('photo-pigeon')
  .description('Watches your folders and delivers every new photo to Google Photos.')
  .version(pkg.version, '-v, --version', 'print the version and exit')
  .option('-c, --config <path>', 'read this config file instead of the usual one')
  .showHelpAfterError('(run photo-pigeon --help to see the commands)')
  .addHelpText(
    'after',
    [
      '',
      STORAGE_HONESTY,
      'photo-pigeon only ever uploads. It cannot delete or change anything in your library.',
      '',
      'First time here? Run: photo-pigeon setup',
      'Scheduling it instead of leaving it open? Run: photo-pigeon watch --once',
      'Driving it from another program? Run: photo-pigeon watch --events ndjson',
      `In that mode it also reads one bare word to a line on stdin: ${STDIN_WORDS.join(', ')}.`,
      '',
      'Exit codes, for a scheduled task or a script:',
      '  0  everything it was asked to do, it did',
      '  1  it could not finish',
      '  2  no setup yet, run photo-pigeon setup',
      '  3  it ran, and something needs looking at: doctor found problems, a --once',
      '     pass finished with files that did not make it, or a folders change was',
      '     refused and nothing was written',
      '  4  not in this build',
      '  5  another photo-pigeon is already watching those folders',
      '  130  interrupted twice, so it left without finishing',
      '',
      'While watch runs it keeps a plain text log next to the ledger, in the same',
      'folder as your config. Run photo-pigeon status to see where that is.',
      '',
    ].join('\n'),
  );

registerCommands(program, pkg.version);

try {
  await program.parseAsync(process.argv);
} catch (error) {
  process.stderr.write(`${messageOf(error)}\n`);
  process.exitCode = EXIT.FAILED;
}
