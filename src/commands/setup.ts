/**
 * setup: the wizard, then the first sign in.
 *
 * The wizard owns the Google Cloud walkthrough and writes the config. This
 * command's own job is small: run it, then prove the credentials work by
 * actually authorizing, so nobody discovers a broken consent screen at 2am
 * during their first real upload.
 *
 * ## The machine channel, added at M4
 *
 * `--events ndjson` makes this the same kind of process `watch --events ndjson`
 * already was: one JSON line per event on stdout, human prose on stderr, and a
 * tiny stdin vocabulary. It exists so the tray's first-run window can run the
 * real wizard instead of a second copy of it, and the whole contract is in
 * `docs/ASK-PROTOCOL.md`.
 *
 * Two things about it are laws rather than choices:
 *
 * * **Consent still opens in the system browser.** `ensureAuth` hands the URL
 *   to the `open` package from this process, exactly as it does for a terminal
 *   user. No sign-in URL ever travels on the event stream, so there is nothing
 *   for a window to render even if somebody tried.
 * * **The vocabulary grew by one form and no words.** `stop` and `quit` are the
 *   two bare words setup answers, and `answer {"id":...,"value":...}` is the
 *   single payload-carrying line M4 was allowed to add.
 */

import pc from 'picocolors';

import { EXIT } from './errors.js';
import { createLogger, createStderrLogger, type Logger } from './log.js';
import { defaultRuntime, type Runtime } from './runtime.js';
import { createSetupChannel, SetupCancelled, type SetupChannel } from './setup-channel.js';

/** Flags the setup command accepts. */
export interface SetupOptions {
  /** Version string, printed on the closing screen. */
  version?: string;
  /**
   * Write the setup beside this config file instead of under the home folder.
   *
   * Same flag and same meaning as every other command's `-c`. Here it decides
   * where the whole `~/.photo-pigeon` folder's worth of files goes, which is
   * what makes a real setup runnable in a temp directory by a test or by the
   * E2E rig without the production install being reachable at all.
   */
  config?: string;
  /** The machine channel. One JSON line per event on stdout. */
  events?: 'ndjson';
  /** False to print the console links instead of handing them to a browser. */
  openLinks?: boolean;
}

/** Where a setup run reads and writes when it is speaking to a parent process. */
export interface SetupIo {
  /** One JSON line per event. */
  out(line: string): void;
  /** Lines arriving from the parent, already split. */
  onLine(handler: (line: string) => void): void;
  /** The parent's pipe closed. */
  onEnd(handler: () => void): void;
  /**
   * Let go of stdin.
   *
   * Load bearing rather than tidy: a resumed stdin is a live libuv handle, so
   * a run that has said `stopped` and has nothing left to do would sit there
   * forever with the tray waiting on an exit that never comes. Every exit path
   * calls this.
   */
  close(): void;
}

/** The real process, wired for NDJSON. */
function processIo(): SetupIo {
  // The same guard the watch channel puts on stdout and for the same reason: a
  // parent that leaves takes the pipe with it, and an error event with no
  // listener takes this process down mid write.
  process.stdout.on('error', () => {});
  process.stderr.on('error', () => {});
  return {
    out(line) {
      try {
        process.stdout.write(`${line}\n`);
      } catch {
        /* the parent is gone; the run still finishes for the log's sake */
      }
    },
    onLine(handler) {
      let buffer = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk: string) => {
        buffer += chunk;
        for (;;) {
          const newline = buffer.indexOf('\n');
          if (newline < 0) break;
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          handler(line);
        }
        // A parent sending something that is not lines must not grow this
        // forever. The answer form is one line and a generous one at that.
        if (buffer.length > 64 * 1024) buffer = '';
      });
      process.stdin.resume();
    },
    onEnd(handler) {
      process.stdin.on('end', handler);
      process.stdin.on('close', handler);
    },
    close() {
      process.stdin.pause();
      process.stdin.removeAllListeners('data');
      process.stdin.removeAllListeners('end');
      process.stdin.removeAllListeners('close');
    },
  };
}

/** The folder a `-c` path puts the whole setup in. */
function configDirOf(configPath: string | undefined): string | undefined {
  if (!configPath || configPath.trim() === '') return undefined;
  const path = configPath.trim();
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut > 0 ? path.slice(0, cut) : '.';
}

/** Runs the wizard and the first authorization. Resolves with the exit code. */
export async function runSetup(
  options: SetupOptions = {},
  runtime: Runtime = defaultRuntime,
  log: Logger = createLogger(),
  io: SetupIo = processIo(),
): Promise<number> {
  const configDir = configDirOf(options.config);
  const openLinks = options.openLinks !== false;

  if (options.events === 'ndjson') {
    return runSetupOnChannel(options, runtime, io, configDir, openLinks);
  }

  const config = await runtime.runWizard({
    ...(configDir ? { configDir } : {}),
    openLinks,
  });

  log.info('signing you in for the first time');
  const client = await runtime.createClient(config);
  await client.ensureAuth();
  log.ok('signed in, your credentials work');

  // The wizard has already covered the storage cost, the one direction rule and
  // the client id lock, in its own words and at the right moment. This screen
  // only says the thing the wizard could not know yet: the credentials work.
  const version = options.version ? ` ${options.version}` : '';
  log.plain();
  log.plain(pc.bold(`photo-pigeon${version} is ready`));
  log.plain();
  log.plain(`Ledger: ${config.ledgerPath}`);
  log.plain(pc.dim('  the record of what has been delivered, and what never needs sending twice'));
  log.plain();
  log.plain(`Start it with: ${pc.bold('photo-pigeon watch')}`);
  log.plain(pc.dim('Anything already in your folders goes on the first run.'));
  log.plain();

  return EXIT.OK;
}

/**
 * The same run, said out loud on the event stream.
 *
 * Every exit path ends on `stopped`, including the ones that failed before
 * anything started. That is the promise the watch stream makes and a parent
 * that has learned to trust it there should not have to learn a second rule
 * here.
 */
async function runSetupOnChannel(
  options: SetupOptions,
  runtime: Runtime,
  io: SetupIo,
  configDir: string | undefined,
  openLinks: boolean,
): Promise<number> {
  const speaker = createStderrLogger();
  const channel: SetupChannel = createSetupChannel({
    out: (line) => io.out(line),
    err: (line) => speaker.warn(line),
    ...(openLinks
      ? {
          openUrl: async (url: string): Promise<boolean> => {
            const { consoleIo } = await import('../wizard/ui.js');
            return consoleIo.openUrl(url);
          },
        }
      : {}),
  });

  let cancelled = false;
  // The wizard's cancel only fails a question that is open. Past the last
  // question there is no question to fail, and the run sits in the consent wait
  // holding a loopback listener that keeps this process alive for the full five
  // minute timeout. This is the same cancel reaching that wait.
  const signingIn = new AbortController();
  const cancel = (): void => {
    if (cancelled) return;
    cancelled = true;
    channel.cancel();
    signingIn.abort();
  };
  io.onLine((line) => {
    if (!channel.line(line)) cancel();
  });
  io.onEnd(cancel);

  const paths = await runtime.pigeonPaths(configDir);
  channel.emit({
    type: 'setup-started',
    pid: process.pid,
    ...(options.version ? { version: options.version } : {}),
    configPath: paths.configPath,
    steps: 5,
  });

  try {
    const config = await runtime.runWizard({
      io: channel.io,
      ask: channel.ask,
      openLinks,
      ...(configDir ? { configDir } : {}),
    });
    channel.emit({
      type: 'setup-written',
      configPath: paths.configPath,
      watchDirs: config.watchDirs,
      ...(config.albumName ? { album: config.albumName } : {}),
    });

    // The OAuth law, and the one place a reader will look for it: the URL goes
    // to the system browser from this process. The event says only that it is
    // happening, so there is nothing on the wire a window could render even by
    // accident.
    //
    // The speaker is what makes that last sentence true, and it was missing.
    // The gphotos module writes `info` to `console.log` by default, and the
    // consent flow says "paste this into any browser" followed by the URL. So
    // this channel really was putting an accounts.google.com link on the same
    // stdout the setup window reads, alongside three other lines of prose that
    // are not JSON and would break any parser reading the stream strictly.
    // Handing the stderr speaker in is the whole fix: the terminal still sees
    // every word, because stderr is where this run's prose has always gone.
    channel.emit({ type: 'signing-in' });
    const client = await runtime.createClient(config, {
      logger: speaker,
      signal: signingIn.signal,
    });
    await client.ensureAuth();

    channel.emit({
      type: 'setup-done',
      configPath: paths.configPath,
      ledgerPath: config.ledgerPath,
    });
    channel.emit({ type: 'stopping', reason: 'done' });
    channel.emit({ type: 'stopped', exitCode: EXIT.OK });
    return EXIT.OK;
  } catch (error) {
    if (error instanceof SetupCancelled || cancelled) {
      channel.emit({ type: 'stopping', reason: 'stdin' });
      channel.emit({ type: 'stopped', exitCode: EXIT.OK });
      return EXIT.OK;
    }
    const message = error instanceof Error ? error.message : String(error);
    channel.emit({ type: 'failed', error: message });
    channel.emit({ type: 'stopping', reason: 'done' });
    channel.emit({ type: 'stopped', exitCode: EXIT.FAILED });
    speaker.error(message);
    return EXIT.FAILED;
  } finally {
    io.close();
  }
}
