/**
 * Command registration.
 *
 * Every action does the same three things: gather flags, call the one function
 * that does the work, and turn whatever comes back into an exit code. The work
 * itself lives in its own file and knows nothing about commander.
 */

import type { Command } from 'commander';

import { CommandError, EXIT, messageOf } from './errors.js';
import { createLogger, createStderrLogger, type Logger } from './log.js';
import { runDoctor } from './doctor.js';
import { FOLDER_ACTIONS, runFolders } from './folders.js';
import { runLogin } from './login.js';
import { runSetup } from './setup.js';
import { runStatus } from './status.js';
import { runWatch } from './watch.js';

interface GlobalFlags {
  config?: string;
}

interface DoctorFlags extends GlobalFlags {
  json?: boolean;
}

interface SetupFlags extends GlobalFlags {
  events?: string;
  /** Commander's shape for `--no-open`: true unless the flag was given. */
  open?: boolean;
}

interface FoldersFlags extends GlobalFlags {
  json?: boolean;
}

interface WatchFlags extends GlobalFlags {
  dir?: string[];
  album?: string;
  dryRun?: boolean;
  poll?: boolean;
  once?: boolean;
  events?: string;
}

/** Repeatable option collector, so -d can be given more than once. */
function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

/** The config path, whether it was given before or after the command name. */
function configOf(local: GlobalFlags, command: Command): string | undefined {
  if (local.config && local.config.trim() !== '') return local.config;
  const parentFlags = command.parent?.opts<GlobalFlags>();
  return parentFlags?.config;
}

/**
 * The channel a command's own words go to.
 *
 * Under `--events` stdout carries one JSON line per event and nothing else, so
 * a parent process can parse it strictly. The swap watch.ts makes internally
 * lives inside the run, and this catch is outside it: a refused lock throws
 * past runWatch and gets printed here, by the caller's logger, whose warn and
 * plain both go to stdout. That put an ANSI coloured English sentence in the
 * middle of the machine channel on the double start path, which is the failure
 * a tray meets most often. So the choice is made once, here, from the flag.
 */
function speakerFor(machine: boolean, log: Logger): Logger {
  return machine ? createStderrLogger() : log;
}

/**
 * Runs one command and settles the exit code.
 *
 * A CommandError is something we expected and can explain, so it prints as a
 * sentence with an optional next step. Anything else is a genuine crash, and
 * the stack is available behind PHOTO_PIGEON_DEBUG rather than in the user's face.
 */
export async function execute(log: Logger, work: () => Promise<number>): Promise<void> {
  try {
    process.exitCode = await work();
  } catch (error) {
    if (error instanceof CommandError) {
      log.error(error.message);
      if (error.hint) log.warn(error.hint);
      process.exitCode = error.code;
      return;
    }
    log.error(messageOf(error));
    if (process.env['PHOTO_PIGEON_DEBUG'] && error instanceof Error && error.stack) {
      log.plain(error.stack);
    }
    process.exitCode = EXIT.FAILED;
  }
}

/** Hangs every command off the program. */
export function registerCommands(program: Command, version: string, log = createLogger()): void {
  program
    .command('setup')
    .alias('init')
    .description('make your own Google credentials, then sign in for the first time')
    .option('-c, --config <path>', 'write the setup beside this config file instead of the usual one')
    // The same machine channel the watch command has had since M1, and the seam
    // the tray's first-run window stands on. Without it, setup_start() spawns a
    // process that dies on an unknown option before it creates a single file.
    // docs/ASK-PROTOCOL.md is the contract.
    .option('--events <format>', 'write one JSON line per event on stdout, for a parent process (ndjson)')
    // Commander turns --no-open into openLinks... no: into `open`, defaulting
    // true. Named for what it does to a browser rather than to a variable.
    .option('--no-open', 'print the console links instead of handing them to a browser')
    .action(async (flags: SetupFlags, command: Command) => {
      // Asked once and used for both, exactly as the watch command does it, so
      // the run and its error path can never disagree about who owns stdout.
      const speaker = speakerFor(flags.events !== undefined, log);
      await execute(speaker, () =>
        runSetup(
          {
            version,
            ...(configOf(flags, command) ? { config: configOf(flags, command) } : {}),
            ...(flags.events ? { events: flags.events as 'ndjson' } : {}),
            ...(flags.open === false ? { openLinks: false } : {}),
          },
          undefined,
          speaker,
        ),
      );
    });

  program
    .command('watch', { isDefault: true })
    .description('watch your folders and deliver every new photo, the default command')
    .option('-c, --config <path>', 'read this config file instead of the usual one')
    .option('-d, --dir <path>', 'watch this folder instead of the configured ones, repeatable', collect)
    .option('--album <name>', 'file new uploads into this album')
    .option('--dry-run', 'say what would be uploaded, upload nothing, write nothing to the ledger')
    .option('--poll', 'poll on a timer instead of watching, for network drives only')
    .option('--once', 'deliver what is on disk now and exit, instead of staying open')
    // The machine channel. A shell that runs this as a child process reads one
    // JSON line per event on stdout, and the human lines move to stderr so the
    // two never mix. Also the mode where a "stop" line on stdin is listened for,
    // because on Windows a parent cannot deliver a signal to a child at all.
    .option('--events <format>', 'write one JSON line per event on stdout, for a parent process (ndjson)')
    .action(async (flags: WatchFlags, command: Command) => {
      // Asked once and used for both, so the error path and the run itself can
      // never disagree about who owns stdout. Set even for an --events value
      // this build does not know, because the refusal is a human sentence too.
      const speaker = speakerFor(flags.events !== undefined, log);
      await execute(speaker, () =>
        runWatch(
          {
            version,
            ...(configOf(flags, command) ? { config: configOf(flags, command) } : {}),
            ...(flags.dir && flags.dir.length > 0 ? { dir: flags.dir } : {}),
            ...(flags.album ? { album: flags.album } : {}),
            ...(flags.dryRun ? { dryRun: true } : {}),
            ...(flags.poll ? { poll: true } : {}),
            ...(flags.once ? { once: true } : {}),
            ...(flags.events ? { events: flags.events as 'ndjson' } : {}),
          },
          undefined,
          speaker,
        ),
      );
    });

  program
    .command('folders')
    .description('add or remove a watched folder, without running setup again')
    .argument('<action>', `what to do to the list: ${FOLDER_ACTIONS.join(' or ')}`)
    .argument('<path>', 'the folder')
    .option('-c, --config <path>', 'edit this config file instead of the usual one')
    // The status window's Watching list reads this line. One JSON line per
    // request, always, including the requests that change nothing: a front end
    // has exactly one reading of silence, that the core did not understand, and
    // it acts on that reading. src/commands/folders.ts is the contract.
    .option('--json', 'write the answer as one JSON line instead of a sentence')
    .action(async (action: string, target: string, flags: FoldersFlags, command: Command) => {
      // Asked once and used for both, exactly as the watch and doctor commands
      // do it, so the answer and its error path can never disagree about who
      // owns stdout.
      const speaker = speakerFor(flags.json === true, log);
      await execute(speaker, () =>
        runFolders(
          {
            // The word is read inside the run, not here, so an action nobody
            // knows is answered on the same channel as everything else instead
            // of thrown past it.
            action,
            path: target,
            ...(configOf(flags, command) ? { config: configOf(flags, command) } : {}),
            ...(flags.json ? { json: true } : {}),
          },
          speaker,
        ),
      );
    });

  // Named login, with auth as an alias, because both names are already printed
  // by the transport and by doctor when a token stops working.
  program
    .command('login')
    .alias('auth')
    .description('sign in again, or sign in on a desktop for a machine with no browser')
    .option('-c, --config <path>', 'read this config file instead of the usual one')
    .action(async (flags: GlobalFlags, command: Command) => {
      await execute(log, () =>
        runLogin(
          { ...(configOf(flags, command) ? { config: configOf(flags, command) } : {}) },
          undefined,
          log,
        ),
      );
    });

  program
    .command('status')
    .description('what this tool has delivered, and what it is set up to watch')
    .option('-c, --config <path>', 'read this config file instead of the usual one')
    .action(async (flags: GlobalFlags, command: Command) => {
      await execute(log, () =>
        runStatus(
          { version, ...(configOf(flags, command) ? { config: configOf(flags, command) } : {}) },
          undefined,
          log,
        ),
      );
    });

  program
    .command('doctor')
    .description('check your Google project and credentials for the usual problems')
    // The health window's whole backing. The structure has always existed in
    // wizard/doctor.ts; only the command layer flattened it into a block of
    // text, so this is a passthrough past the flattening rather than new work.
    .option('--json', 'write the report as one JSON line instead of a screen')
    // `-c` arrived at M4 with the window. It used to be absent on the grounds
    // that doctor checks the setup the wizard made, in the folder the wizard
    // owns; the wizard makes one wherever `-c` says, and a tray running against
    // an override has to be able to ask about the setup it is actually using
    // rather than about the one in the user's home folder.
    .option('-c, --config <path>', 'check the setup beside this config file instead of the usual one')
    .action(async (flags: DoctorFlags, command: Command) => {
      const speaker = speakerFor(flags.json === true, log);
      const config = configOf(flags, command);
      await execute(speaker, () =>
        runDoctor(
          {
            ...(flags.json ? { json: true } : {}),
            ...(config ? { config } : {}),
          },
          undefined,
          speaker,
        ),
      );
    });
}
