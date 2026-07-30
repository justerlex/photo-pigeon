/**
 * watch: the default command, and the whole point of the tool.
 *
 * Banner, one reconciliation scan against the ledger, then live watching until
 * the user stops it. Ctrl+C closes the door and finishes what is already inside.
 *
 * With --once it stops after the scan: deliver what was on disk, drain, print
 * the summary, exit. That is the shape a scheduled task or a cron line wants,
 * and it is the same code up to the point where the live path starts waiting.
 *
 * Since M1 this command is also the engine a tray shell drives as a child
 * process, which added four things and changed none of the old ones:
 *
 *  - a single instance lock on the ledger's folder, so the tray's core and a
 *    hand typed `photo-pigeon watch` cannot both deliver the same photo,
 *  - a WatchEvent stream, offered to a callback in process and as one JSON
 *    line per event on stdout under --events ndjson,
 *  - a stop handle on the returned promise, so a parent can ask for a clean
 *    drain without sending a signal,
 *  - a rotating log file next to the ledger, so "Open log" has something to
 *    open on a machine with no terminal.
 *
 * -------------------------------------------------------------------------
 * THE WINDOWS SIGNAL BENCH, 28-Jul-2026, win32 10.0.22621, node v22.18.0
 * -------------------------------------------------------------------------
 * Measured, not assumed: a parent node process spawned a child that installed
 * handlers for SIGTERM, SIGINT, SIGHUP and SIGBREAK and printed whatever
 * arrived. Nine stop channels were tried against a fresh child each.
 *
 *   child.kill('SIGTERM')      handler NEVER ran. exit signal reported SIGTERM
 *   child.kill('SIGINT')       handler NEVER ran. exit signal reported SIGINT
 *   child.kill('SIGBREAK')     handler NEVER ran. exit signal reported SIGKILL
 *   child.kill('SIGHUP')       handler NEVER ran. exit signal reported SIGKILL
 *   child.kill()               handler NEVER ran. exit signal reported SIGTERM
 *   process.kill(pid,'SIGTERM')handler NEVER ran. exit code 1, no signal
 *   write "stop\n" to stdin    ARRIVED. child chose its own exit code
 *   stdin.end(), so EOF        ARRIVED. child chose its own exit code
 *   IPC channel, send('stop')  ARRIVED. child chose its own exit code
 *
 * The finding: on Windows there is no such thing as delivering a signal to
 * another process. Every kill above is TerminateProcess under a signal shaped
 * name, and the name libuv reports back to the parent is fiction: the child
 * never saw it, ran no handler, flushed nothing and drained nothing. Signals
 * only work on Windows when a process sends them to *itself*, which is why
 * ctrl+c in a terminal still works here and always will: the console driver
 * raises it inside the child.
 *
 * Consequences, all of them acted on in this file:
 *
 *  1. The tray must never stop the core with child.kill for a normal stop.
 *     That would abandon a half filed batch, and the file that was uploaded
 *     but not yet recorded in the ledger gets uploaded again next time.
 *  2. The tray's stop channel is stdin: one line, "stop". stdin EOF means the
 *     same thing, which also covers the parent dying without saying anything.
 *     Both are wired under --events ndjson. child.kill stays as the last resort
 *     after a stop that did not answer, and it is a kill, not a request.
 *  3. Anything that must survive a hard stop has to be on disk at the moment
 *     it is written. That is why the ledger appends and why the log file below
 *     uses synchronous writes.
 *  4. A lock file will therefore be left behind regularly, so stale detection
 *     in state/lock.ts is load bearing rather than defensive.
 *
 * Two smaller facts from the same bench, used by state/lock.ts: process.kill
 * (pid, 0) answers ESRCH for a pid that has exited and EPERM for a live pid
 * owned by somebody else, so it is a usable liveness probe on Windows.
 */

import path from 'node:path';

import pc from 'picocolors';

import type { AppConfig, GPhotosClient, UploadOutcome } from '../contracts.js';
import { CommandError, EXIT, messageOf } from './errors.js';
import { formatBytes, plural } from './format.js';
import { createLogger, createStderrLogger, type Logger } from './log.js';
import { logFilePathFor, openFileLog, redact, withFileLog, type FileLog } from './logfile.js';
import { UploadQueue, type PauseReason, type QueueTotals } from './queue.js';
import { defaultRuntime, type Runtime, type StartResult, type WatchHandle } from './runtime.js';
// One pure sentence builder, imported directly rather than through the runtime
// for the same reason queue.ts imports mediaKindFor that way: it reads no file,
// starts nothing, and only ever turns a record into a line of English.
import { describeHolder } from '../state/lock.js';
import type { Lock, LockLoss } from '../state/lock.js';
import type { SideIndex } from '../state/sideindex.js';

/** The storage truth, in one sentence, every single run. */
export const STORAGE_HONESTY =
  'Uploads are original quality and count against your Google storage. Storage Saver does not apply.';

/** The machine readable formats --events understands. */
export const EVENT_FORMATS = ['ndjson'] as const;

/** What --events was set to. */
export type EventFormat = (typeof EVENT_FORMATS)[number];

// ---------------------------------------------------------------------------
// The event stream
// ---------------------------------------------------------------------------

/** Why the run is stopping. */
export type StopReason =
  /** A signal this process raised on itself, which on Windows means ctrl+c in a console. */
  | 'signal'
  /** Somebody called stop() on the handle, in process. */
  | 'handle'
  /** A "stop" line, or end of file, on stdin. The tray's channel. */
  | 'stdin'
  /**
   * A "detach" line: the parent is leaving and this run finishes the job alone.
   *
   * The drain is identical to a stop. What differs is what silence means
   * afterwards, and that difference is the entire reason the word exists: see
   * the detach note above listenOnStdin.
   */
  | 'detach'
  /** The single instance lock was taken over, so this run has to get out of the way. */
  | 'lock-lost'
  /** A second stop request: leaving without finishing the drain. */
  | 'impatient';

/**
 * One thing that happened, without its timestamp.
 *
 * This is the tray's whole view of the core. It is deliberately small and
 * deliberately boring: a shape here is a shape a shell in another language has
 * to parse, so every member is plain JSON with no nesting worth mentioning.
 *
 * There is no event for deleting or changing anything, here or ever.
 */
export type WatchEventBody =
  /** The run is up. Everything the tray needs to render its menu, once. */
  | {
      type: 'started';
      pid: number;
      version?: string;
      watchDirs: string[];
      album?: string;
      dryRun: boolean;
      once: boolean;
      ledgerPath: string;
      lockPath: string;
      logPath?: string;
    }
  /** A reconciliation walk is running: the one at startup, or one somebody asked for. */
  | { type: 'scanning'; dirs: string[] }
  /** Work is flowing: after a scan, and again when a pause lifts. */
  | { type: 'delivering'; found: number; reason: 'scan' | 'resumed' | 'rescan' }
  /**
   * Google confirmed a media item. The one event that means a photo arrived.
   *
   * `firstEver` is present and true on exactly one delivery in the life of a
   * ledger: the one that found it empty. It is here rather than worked out by
   * the reader because it cannot be worked out by the reader. `UploadQueue`
   * writes the ledger entry and then reports the outcome, so a shell reading
   * the ledger on receipt of this event sees a count of one on a virgin
   * install's very first photo and never sees zero again: the condition would
   * be false on the first delivery and false forever after, and the one happy
   * toast TRAY-DESIGN section 3 promises would be dead for everybody.
   *
   * Absent means not the first, never "unknown". That is what lets a shell
   * deserialize it as a plain defaulted boolean and read an older core as a
   * stream of ordinary deliveries rather than as a stream of maybes.
   */
  | {
      type: 'delivered';
      path: string;
      hash: string;
      bytes: number;
      mediaItemId?: string;
      firstEver?: boolean;
    }
  /** Nothing to do for this file: the ledger already had these bytes. */
  | { type: 'skipped'; path: string; hash: string; reason: 'already-delivered' }
  /** One file did not make it. It is still on disk and the next scan finds it. */
  | { type: 'failed'; path?: string; hash?: string; error: string }
  /**
   * Nothing is being uploaded, and this is why.
   *
   * One shape for both kinds of pause, which is the M3 replacement for two
   * different mechanisms: `reason: "quota"` is the day's request budget being
   * spent and carries `resumesAt`, the moment it comes back; `reason: "user"`
   * is somebody having asked, and carries no time because it lifts when they
   * say so. `detail` is the sentence for the quota case and absent otherwise.
   *
   * This replaces the `paused-quota` event, which said one of the two things
   * and was raised by inferring a pause from the shape of a timer.
   */
  | { type: 'paused'; reason: PauseReason; resumesAt?: string; detail?: string }
  /**
   * The hold named by `reason` is off, with the number of files it released.
   *
   * **One per hold, not one per return to running**, corrected by the M3
   * review. `waiting` is 0 when another hold is still on, and that is the
   * shape a reader has to be ready for: a person resuming into a spent budget,
   * or a budget coming back under somebody's pause. Neither of those releases
   * a file, both of them are the clearing condition for exactly one thing on
   * screen, and the version that only spoke when the queue started running
   * again left both of them silent.
   *
   * A `delivering` with `reason: "resumed"` follows immediately **when the
   * queue is really running again**, so a shell that only ever learned the old
   * way still clears its paused state. It deliberately does not follow a lift
   * that released nothing: a `delivering` claims work is moving.
   */
  | { type: 'resumed'; reason: PauseReason; waiting: number }
  /**
   * The parent asked to be let go and may leave now.
   *
   * Sent the moment the word arrives, before the drain, because the point of
   * detaching is that the parent does not have to wait for anything.
   */
  | { type: 'detached' }
  /** Sign in is needed and cannot be done from here. The tray has to ask the user. */
  | { type: 'auth-needed'; reason: string }
  /**
   * The single instance lock this run was holding is not safely ours any more.
   *
   * 'stolen' means another process judged this one abandoned and took the
   * ledger, so this run stands down and `stopping` is true. 'unverifiable'
   * means the lock file cannot be refreshed, so a start elsewhere may decide
   * the same thing at any moment: a state to show, not a reason to stop.
   */
  | { type: 'lock-lost'; reason: LockLoss; heldBy?: number; stopping: boolean }
  /** A stop was asked for. Intake is closed and the drain has begun. */
  | { type: 'stopping'; reason: StopReason }
  /** The last event of a run, always. */
  | { type: 'stopped'; exitCode: number; totals?: QueueTotals };

type WithTime<T> = T extends unknown ? T & { at: string } : never;

/** A WatchEventBody with the ISO moment it happened. This is what a sink receives. */
export type WatchEvent = WithTime<WatchEventBody>;

/** Where events go. */
export type OnEvent = (event: WatchEvent) => void;

/**
 * The little a control stream has to be able to do.
 *
 * process.stdin satisfies this, and so does a PassThrough, which is what makes
 * the stdin vocabulary testable without a child process. Everything optional is
 * optional because a stream in a test is not obliged to have it.
 */
export interface ControlStream {
  on(event: 'data' | 'end', listener: (chunk?: unknown) => void): unknown;
  off?(event: 'data' | 'end', listener: (chunk?: unknown) => void): unknown;
  setEncoding?(encoding: 'utf8'): unknown;
  resume?(): unknown;
  pause?(): unknown;
  unref?(): unknown;
  destroyed?: boolean;
}

// ---------------------------------------------------------------------------
// Options and the handle
// ---------------------------------------------------------------------------

/** Flags the watch command accepts, plus the seams a parent process needs. */
export interface WatchOptions {
  /** Explicit config file. */
  config?: string;
  /** Scan and hash, send nothing. */
  dryRun?: boolean;
  /** Interval polling instead of native events, for network drives. */
  poll?: boolean;
  /** Folders to watch instead of the ones in the config. */
  dir?: string[];
  /** Album to file new uploads into, instead of the one in the config. */
  album?: string;
  /** One reconciliation pass, deliver what it found, then exit. No live watching. */
  once?: boolean;
  /** Version string for the banner. */
  version?: string;
  /** Quiet period before a part full batch is flushed. Tests use it, users do not. */
  quietMs?: number;
  /**
   * Write every event as one JSON line on stdout, and move the human lines to
   * stderr so the two channels never mix. This is what the tray runs.
   */
  events?: EventFormat;
  /** Every event, in process. Independent of --events: both can be on at once. */
  onEvent?: OnEvent;
  /** Where ndjson lines go. Tests use it, the CLI writes to stdout. */
  emit?: (line: string) => void;
  /** Where human lines go under --events. Tests use it, the CLI writes to stderr. */
  humanLog?: Logger;
  /**
   * Listen for control lines, and treat end of file as a stop.
   *
   * Defaults to on under --events and off otherwise, because the bench above
   * says this is the only stop a Windows parent can actually deliver.
   */
  stdinControl?: boolean;
  /**
   * Where the control lines are read from. The CLI uses process.stdin.
   *
   * A seam and not a feature: the vocabulary in listenOnStdin is the tray's
   * whole way of asking for anything, and testing it against the real stdin of
   * the test runner is not possible. Any readable stream of lines fits.
   */
  stdin?: ControlStream;
  /** Write the rotating log file next to the ledger. On by default. */
  logFile?: boolean;
}

/**
 * What runWatch hands back.
 *
 * It is the same promise it always was, so `await runWatch(...)` still gives an
 * exit code and every existing caller is untouched. Holding on to it instead of
 * awaiting it gets a stop button, which is the thing a parent process has and
 * a signal cannot give it on Windows.
 */
export interface WatchRun extends Promise<number> {
  /**
   * Close intake, finish what is already in the queue, resolve with the exit
   * code. Calling it twice means the caller has stopped being patient, and the
   * second call leaves without waiting, exactly like a second ctrl+c.
   *
   * Safe before the run has started listening: the request is remembered and
   * acted on the moment there is something to stop. A --once run ignores it and
   * finishes its single pass, which is the whole contract of --once.
   */
  stop(): Promise<number>;
}

/** Config plus the flags this invocation overrode. */
export function applyWatchFlags(config: AppConfig, options: WatchOptions): AppConfig {
  const effective: AppConfig = { ...config };
  if (options.dir && options.dir.length > 0) {
    effective.watchDirs = options.dir.map((dir) => path.resolve(dir));
  }
  if (options.album !== undefined && options.album.trim() !== '') {
    effective.albumName = options.album.trim();
  }
  if (options.dryRun === true) effective.dryRun = true;
  if (options.poll === true) effective.pollFallback = true;
  return effective;
}

/**
 * Holds a stop request until there is something able to act on it, and
 * remembers the two facts everything else has to agree about: whether a stop
 * has been asked for at all, and whether the parent has been let go.
 *
 * Without the first half a parent that calls stop() while the run is still
 * signing in would be ignored, and the tray would have to guess when the core
 * is ready. Without the second half a detached run cannot tell the difference
 * between a parent that left as agreed and a parent that died, and it treats
 * the agreed silence as a second stop, which is exactly the abandoned half
 * batch the M2 review found.
 */
class ControlGate {
  private pending: StopReason | null = null;
  private handler: ((reason: StopReason) => void) | null = null;
  private asked = false;
  private letGo = false;

  /** True once anything at all has asked this run to stop. */
  get stopping(): boolean {
    return this.asked;
  }

  /** True once the parent has been let go and this run is finishing alone. */
  get detached(): boolean {
    return this.letGo;
  }

  request(reason: StopReason): void {
    this.asked = true;
    if (this.handler) {
      this.handler(reason);
      return;
    }
    this.pending ??= reason;
  }

  /**
   * The parent is leaving and this run carries on without it.
   *
   * The flag is set before the request, and that order is the whole mechanism:
   * a detach arriving during a drain reaches the same handler a second stop
   * would, and the handler asks this gate whether the run has been let go
   * before it reaches for the impatient path.
   */
  detach(): void {
    this.letGo = true;
    this.request('detach');
  }

  arm(handler: (reason: StopReason) => void): void {
    this.handler = handler;
    const waiting = this.pending;
    this.pending = null;
    if (waiting !== null) handler(waiting);
  }

  disarm(): void {
    this.handler = null;
  }
}

function printBanner(config: AppConfig, options: WatchOptions, log: Logger): void {
  const version = options.version ? ` ${options.version}` : '';
  log.plain();
  log.plain(pc.bold(`photo-pigeon${version}`));
  log.plain(`watching ${plural(config.watchDirs.length, 'folder')}:`);
  for (const dir of config.watchDirs) log.plain(pc.dim(`  ${dir}`));
  log.plain(
    config.albumName
      ? `album: ${config.albumName}`
      : pc.dim('album: none, uploads land in your library'),
  );
  if (config.pollFallback) {
    log.plain(pc.dim('polling instead of watching, as asked'));
  }
  if (config.dryRun) {
    log.plain(pc.yellow('dry run: nothing is uploaded and nothing is written to the ledger'));
  }
  if (options.once) {
    log.plain(pc.dim('one pass: whatever is on disk now, then out'));
  }
  log.plain(STORAGE_HONESTY);
  log.plain();
}

function summarize(queue: UploadQueue, dryRun: boolean, log: Logger): void {
  const totals = queue.totals;
  const parts: string[] = [];
  if (dryRun) {
    parts.push(`${plural(totals.wouldUpload, 'file')} would be uploaded`);
  } else {
    parts.push(`${plural(totals.delivered, 'file')} delivered`);
    if (totals.bytes > 0) parts.push(`${formatBytes(totals.bytes)} sent`);
  }
  if (totals.skipped > 0) parts.push(`${plural(totals.skipped, 'file')} already known`);
  if (totals.failed > 0) parts.push(`${plural(totals.failed, 'file')} failed`);
  const waiting = totals.deferred + totals.dropped;
  if (waiting > 0) parts.push(`${plural(waiting, 'file')} left for the next run`);
  log.info(parts.join(' · '));
}

/** Resolves the album id when the user asked for an album and the client can make one. */
async function resolveAlbumId(
  client: GPhotosClient,
  albumName: string,
  log: Logger,
): Promise<string | undefined> {
  if (typeof client.ensureAlbum !== 'function') {
    log.warn(`this build cannot create albums, so uploads go to your library instead of ${albumName}`);
    return undefined;
  }
  try {
    return await client.ensureAlbum(albumName);
  } catch (error) {
    log.warn(`could not open the album ${albumName} (${messageOf(error)}), uploading to your library instead`);
    return undefined;
  }
}

/**
 * Builds the fan out for events.
 *
 * Every sink is wrapped: a tray that closed its pipe, or a caller whose
 * callback throws, must not be able to take down a run that is mid delivery.
 * Nothing is buffered and nothing is retried, because an event stream is a
 * narration, and the ledger is the record.
 */
function createEmitter(options: WatchOptions): (body: WatchEventBody) => void {
  const sinks: OnEvent[] = [];
  if (options.onEvent) sinks.push(options.onEvent);
  if (options.events === 'ndjson') {
    let write = options.emit;
    if (!write) {
      // A parent that went away leaves a broken pipe behind, and a broken pipe
      // on stdout arrives as an error event rather than a thrown one, which
      // with nobody listening takes the process down. Taking the process down
      // mid batch is how a file gets uploaded twice, so it is swallowed here
      // and the stop arrives a moment later as end of file on stdin.
      process.stdout.on('error', () => {});
      write = (line: string): void => void process.stdout.write(`${line}\n`);
    }
    const toChannel = write;
    sinks.push((event) => {
      toChannel(JSON.stringify(event));
    });
  }
  if (sinks.length === 0) return () => {};

  return (body: WatchEventBody): void => {
    const event = { ...body, at: new Date().toISOString() } as WatchEvent;
    for (const sink of sinks) {
      try {
        sink(event);
      } catch {
        // A narrator that falls over is not a reason to stop delivering.
      }
    }
  };
}

/**
 * The human logger for this run: stderr under --events, so stdout stays machine only.
 *
 * This covers the run. It cannot cover what happens after runWatch throws,
 * because by then the caller's own logger is the one talking, which is why
 * commands/index.ts picks the same channel for the same reason.
 */
function humanLoggerFor(options: WatchOptions, given: Logger): Logger {
  if (options.events !== 'ndjson') return given;
  if (options.humanLog) return options.humanLog;
  // The same guard createEmitter puts on stdout, for the same reason and one
  // milestone later: a detached run outlives the process holding both its
  // pipes, and after that every human line is a write to a broken pipe. A
  // broken pipe arrives as an error event, and an error event with no listener
  // takes the process down, which mid drain is how a file gets uploaded twice.
  process.stderr.on('error', () => {});
  return createStderrLogger();
}

/** Every word the core answers on stdin, in the order a shell meets them. */
export const STDIN_WORDS = [
  'stop',
  'quit',
  'detach',
  'pause',
  'resume',
  'rescan',
] as const;

/** What a control line asks for. One method per word, plus the silence. */
interface Controls {
  /** stop, quit: close intake, drain, exit. */
  stop(): void;
  /** detach: the parent is leaving, this run finishes the job alone. */
  detach(): void;
  /** pause: hold everything, keep collecting. */
  pause(): void;
  /** resume: let it flow again. */
  resume(): void;
  /** rescan: one reconciliation pass, because somebody pressed Deliver now. */
  rescan(): void;
  /** End of file. What it means depends on whether the parent was let go. */
  eof(): void;
}

/**
 * Listens for the only stop a Windows parent can actually deliver, and for the
 * four other things M3 gave it words for.
 *
 * The vocabulary is bare lines, one to a line, case insensitive. There is no
 * JSON command envelope in this build, and a shell written against one would
 * send `{"cmd":"stop"}`, be ignored, time out, and fall back to child.kill,
 * which is the abandoned half batch the bench above exists to forbid. So
 * anything else that arrives is answered on the human channel by name rather
 * than swallowed. Silence is what makes a parent reach for a kill.
 *
 * -------------------------------------------------------------------------
 * WHY `detach` IS NOT A SECOND `stop`
 * -------------------------------------------------------------------------
 * The tray holds the only write handle on this process's stdin, so the tray
 * exiting is an end of file here, and end of file has always meant stop. That
 * is right for a parent that died and wrong for a parent that meant to go: the
 * quit menu's second press promises "leave, it finishes on its own", and until
 * M3 that promise arrived as a second stop, which is the impatient path, which
 * drops the batch that was in flight.
 *
 * So `detach` says the leaving is agreed. The drain that follows is the same
 * drain a stop asks for, uploads and batchCreate and ledger writes and all, and
 * the difference is entirely in what happens next: end of file after a detach
 * is expected and is ignored, and a second stop cannot arrive down a pipe
 * nobody is holding. The receipt goes out first, so the parent does not wait.
 *
 * The stream is unref'd so it can never be the reason this process refuses to
 * exit once the work is done.
 */
function listenOnStdin(
  controls: Controls,
  log: Logger,
  stream: ControlStream | undefined = process.stdin,
): () => void {
  const stdin = stream;
  if (!stdin || stdin.destroyed === true) return () => {};

  const said = (line: string): void => {
    switch (line) {
      case 'stop':
      case 'quit':
        controls.stop();
        return;
      case 'detach':
        controls.detach();
        return;
      case 'pause':
        controls.pause();
        return;
      case 'resume':
        controls.resume();
        return;
      case 'rescan':
        controls.rescan();
        return;
      default: {
        // Quoted and clipped: this is somebody else's input, and it goes in a
        // log file. The sentence names the shape a shell most often gets wrong.
        const heard = JSON.stringify(line.length > 60 ? `${line.slice(0, 60)}...` : line);
        log.warn(
          `${heard} is not a command this build understands on stdin. The words are ${STDIN_WORDS.join(', ')}, one to a line, not a JSON envelope.`,
        );
      }
    }
  };

  let buffer = '';
  const onData = (chunk?: unknown): void => {
    if (chunk === undefined || chunk === null) return;
    buffer += String(chunk);
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim().toLowerCase();
      buffer = buffer.slice(newline + 1);
      if (line === '') continue;
      said(line);
    }
    // A parent sending something that is not lines must not grow this forever.
    if (buffer.length > 4096) buffer = '';
  };
  const onEnd = (): void => {
    controls.eof();
  };

  try {
    stdin.setEncoding?.('utf8');
    stdin.on('data', onData);
    stdin.on('end', onEnd);
    stdin.resume?.();
    stdin.unref?.();
  } catch {
    return () => {};
  }

  return (): void => {
    stdin.off?.('data', onData);
    stdin.off?.('end', onEnd);
    try {
      stdin.pause?.();
    } catch {
      // Already gone. Nothing to do.
    }
  };
}

/**
 * Runs the watcher.
 *
 * Returns the exit code promise it always did, with a stop button attached.
 */
export function runWatch(
  options: WatchOptions = {},
  runtime: Runtime = defaultRuntime,
  log: Logger = createLogger(),
): WatchRun {
  const gate = new ControlGate();
  const finished = execute(options, runtime, log, gate);
  // Nothing is awaited here, so a caller that only ever awaits stop() still
  // gets the same promise and the same rejection.
  const run = finished as WatchRun;
  run.stop = (): Promise<number> => {
    gate.request('handle');
    return finished;
  };
  return run;
}

async function execute(
  options: WatchOptions,
  runtime: Runtime,
  given: Logger,
  gate: ControlGate,
): Promise<number> {
  if (options.events !== undefined && !EVENT_FORMATS.includes(options.events)) {
    throw new CommandError(
      `--events ${String(options.events)} is not a format this build knows.`,
      EXIT.FAILED,
      `The formats are: ${EVENT_FORMATS.join(', ')}.`,
    );
  }

  const emit = createEmitter(options);
  const config = applyWatchFlags(await runtime.loadConfig(options.config), options);
  const dryRun = config.dryRun === true;

  const file: FileLog | null =
    options.logFile === false ? null : openFileLog(logFilePathFor(config.ledgerPath));
  const human = humanLoggerFor(options, given);
  const log = file ? withFileLog(human, file) : human;

  let lock: Lock | null = null;
  let sideIndex: SideIndex | null = null;
  let stopListening: (() => void) | null = null;
  let queue: UploadQueue | null = null;

  try {
    // The lock comes before anything expensive. Two watchers against one ledger
    // both hash the same file, both find it missing, and both upload it, so the
    // duplicate lands at Google while the ledger records it once.
    const attempt = await runtime.acquireLock(config.ledgerPath, {
      // The holder's half of the guard. Taking the lock is a decision made
      // once, at a moment that is over; being robbed of it happens later, and
      // until this callback existed nothing in the run would have noticed. A
      // watcher that keeps delivering after somebody else has taken its ledger
      // is the duplicate upload the lock is for, so it stops.
      onLost: (loss, heldBy) => {
        emit({
          type: 'lock-lost',
          reason: loss,
          ...(heldBy ? { heldBy: heldBy.pid } : {}),
          stopping: loss === 'stolen',
        });
        if (loss === 'stolen') {
          const who = heldBy ? ` (${describeHolder(heldBy)})` : '';
          log.warn(
            `another photo-pigeon has taken over the lock on this folder set${who}, so this one is stopping rather than delivering the same photos twice`,
          );
          gate.request('lock-lost');
          return;
        }
        log.warn(
          'could not refresh the lock file, so another photo-pigeon starting up may read this run as abandoned',
        );
      },
    });
    if (!attempt.ok) {
      const who = describeHolder(attempt.heldBy);
      const problem =
        attempt.reason === 'held'
          ? `photo-pigeon is already watching this folder set (${who}).`
          : `another photo-pigeon is starting up on this folder set (${who}).`;
      // Straight to the file, not through log.error: execute() in index.ts
      // prints every CommandError, so logging it here as well showed the same
      // sentence twice on the console. The log file still needs it, because a
      // refused start is exactly the thing somebody reads the log to explain.
      file?.write(`error: ${problem}`);
      // Its own exit code since M3, and the one code in this program worth
      // branching on from a script: nothing is broken, somebody else is already
      // delivering these folders, and the right answer is to try later rather
      // than to go looking for a fault.
      throw new CommandError(
        problem,
        EXIT.ALREADY_RUNNING,
        'Stop that one first, or run photo-pigeon status to see what it has done.',
      );
    }
    lock = attempt.lock;
    if (lock.stolen) {
      log.muted('the last run left a lock behind and is no longer running, taking it over');
    }

    emit({
      type: 'started',
      pid: process.pid,
      ...(options.version ? { version: options.version } : {}),
      watchDirs: config.watchDirs,
      ...(config.albumName ? { album: config.albumName } : {}),
      dryRun,
      once: options.once === true,
      ledgerPath: config.ledgerPath,
      lockPath: lock.path,
      ...(file ? { logPath: file.path } : {}),
    });

    printBanner(config, options, log);

    const ledger = await runtime.openLedger(config.ledgerPath);

    // The hash cache, and the reason start-at-login is survivable: an unchanged
    // file is recognised by its path, size and mtime and never read again. The
    // content hash stays the authority, because the cache only ever answers for
    // a file whose three numbers all still match; anything new or changed is
    // read for real.
    //
    // A dry run gets the cache too. It was skipped at first on the grounds that
    // a dry run promises to write nothing, but that promise is about the user's
    // library and the ledger, not about the disk: this function has already
    // written a lock file and opened a log by the time it reaches this line. The
    // cache is a record of what a file's bytes hash to, not a record of what was
    // delivered, and it holds no method that could answer "has this been sent".
    // Every delivery decision still runs against the ledger. Skipping it only
    // bought a purity the lock and the log had already spent, and it charged the
    // careful user, the one who dry-runs a large library first, a full re-hash
    // every time.
    sideIndex = await runtime.openSideIndex(config.ledgerPath);

    let client: GPhotosClient | null = null;
    let albumId: string | undefined;
    if (dryRun) {
      log.muted('dry run, so no sign in and no network');
    } else {
      // Same reason as setup's: under `--events` this `log` is already the
      // stderr speaker, and without handing it over the gphotos module's own
      // prose (album ready, upload retries, quota naps) goes to `console.log`,
      // which under a machine channel is the event stream. Watch never reaches
      // the consent flow, because a non-interactive run refuses before it, so
      // this is the quieter half of the same defect rather than the URL one.
      client = await runtime.createClient(config, { logger: log });
      try {
        await client.ensureAuth();
      } catch (error) {
        // The tray cannot open a browser on the core's behalf, so this is the
        // one failure it has to be told about by name rather than as a count.
        emit({ type: 'auth-needed', reason: redact(messageOf(error)) });
        throw error;
      }
      if (config.albumName) {
        albumId = await resolveAlbumId(client, config.albumName, log);
      }
    }

    /**
     * The queue reports one outcome per file. Bytes are not on the outcome, so
     * they are read as the difference in the queue's own byte total, which is
     * exact: the queue runs one serial chain and books the bytes immediately
     * before it reports the delivery.
     */
    let bytesReported = 0;
    const onOutcome = (outcome: UploadOutcome): void => {
      if (outcome.status === 'uploaded') {
        const bytes = Math.max(0, (queue?.totals.bytes ?? 0) - bytesReported);
        bytesReported += bytes;
        emit({
          type: 'delivered',
          path: outcome.path,
          hash: outcome.hash,
          bytes,
          ...(outcome.mediaItemId ? { mediaItemId: outcome.mediaItemId } : {}),
          // Carried, never recomputed. The queue read this immediately before
          // the ledger write, which is the only moment it is true.
          ...(outcome.firstEver ? { firstEver: true } : {}),
        });
        return;
      }
      if (outcome.status === 'skipped-duplicate') {
        emit({
          type: 'skipped',
          path: outcome.path,
          hash: outcome.hash,
          reason: 'already-delivered',
        });
        return;
      }
      emit({
        type: 'failed',
        path: outcome.path,
        hash: outcome.hash,
        error: redact(outcome.error ?? 'the upload did not complete'),
      });
    };

    /**
     * A pause, said out loud, whichever kind it is.
     *
     * Until M3 this was inferred: the watch command wrapped the queue's timer
     * seam and read a quota pause off the shape of the timer it asked for, an
     * unref'd one of at least a minute. That was true of exactly one caller and
     * would have started lying the first time a second long timer appeared
     * anywhere in queue.ts. The queue now says which hold went on and when it
     * expects to lift, so the timer seam is a plain setTimeout again and the
     * user's own pause arrives through the same door as the budget's.
     */
    const onPaused = (reason: PauseReason, resumesAt?: string, detail?: string): void => {
      emit({
        type: 'paused',
        reason,
        ...(resumesAt ? { resumesAt } : {}),
        ...(detail ? { detail: redact(detail) } : {}),
      });
    };
    const onResumed = (reason: PauseReason, waiting: number): void => {
      emit({ type: 'resumed', reason, waiting });
      // One hold lifting is not the same as the queue running, and as of the M3
      // review the queue says so per hold rather than once. Nothing is flowing
      // while another hold is on, so the legacy line stays in its mouth: a
      // `delivering` is a claim that work is moving, and a shell that clears an
      // amber "Google limit reached" on one would be clearing it on a lie.
      if (queue?.isPaused) return;
      // The old way of saying the same thing, kept deliberately: a shell that
      // learned to clear its paused state from this and never heard of the
      // resumed event above still works.
      emit({ type: 'delivering', found: waiting, reason: 'resumed' });
    };

    queue = new UploadQueue({
      ledger,
      client,
      hashFile: (filePath: string) => runtime.hashFile(filePath),
      log,
      dryRun,
      onOutcome,
      onPaused,
      onResumed,
      sideIndex,
      ...(albumId ? { albumId } : {}),
      ...(options.quietMs !== undefined ? { quietMs: options.quietMs } : {}),
    });
    const live = queue;

    // The watcher is armed first and the folders are walked second. That order is
    // the watcher module's, and it is the one with no gap: a file that lands
    // mid walk is caught by the walk or by an event, and a file caught by both is
    // dropped by its hash rather than uploaded twice.
    log.info('checking the folders against the ledger');
    emit({ type: 'scanning', dirs: config.watchDirs });
    let started: StartResult;
    try {
      started = await runtime.start(config, (candidate) => {
        live.offer(candidate);
      });
    } catch (error) {
      throw new CommandError(`could not start watching: ${messageOf(error)}`, EXIT.FAILED);
    }
    emit({ type: 'delivering', found: started.reconciled.length, reason: 'scan' });

    if (options.once === true) {
      const code = await runOnePass(live, started, log);
      summarize(live, dryRun, log);
      // Nothing here should be able to hold the process open. The queue's own
      // timers are unref'd, so this is belt as well as braces, but a scheduled run
      // that does not exit is a scheduled run that stops being scheduled.
      live.dispose();
      emit({ type: 'stopped', exitCode: code, totals: { ...live.totals } });
      return code;
    }

    log.info(
      started.reconciled.length === 0
        ? 'nothing waiting, watching for new files'
        : `${plural(started.reconciled.length, 'file')} to look at, watching for new ones too`,
    );
    log.info('press ctrl+c to stop.');

    const wantsStdin = options.stdinControl ?? options.events === 'ndjson';
    if (wantsStdin) {
      stopListening = listenOnStdin(
        buildControls(config, live, runtime, log, gate, emit),
        log,
        options.stdin,
      );
    }

    const exitCode = await waitForStop(live, started.handle, log, gate, emit);
    summarize(live, dryRun, log);
    live.dispose();
    emit({ type: 'stopped', exitCode, totals: { ...live.totals } });
    return exitCode;
  } catch (error) {
    const code = error instanceof CommandError ? error.code : EXIT.FAILED;
    emit({ type: 'failed', error: redact(messageOf(error)) });
    emit({
      type: 'stopped',
      exitCode: code,
      ...(queue ? { totals: { ...queue.totals } } : {}),
    });
    throw error;
  } finally {
    stopListening?.();
    // Flushed and shut before the lock goes, so whatever we learned about the
    // files on disk is on disk itself before another process may start reading
    // it. Losing it costs a re-read next time and nothing more.
    if (sideIndex) {
      await sideIndex.close().catch(() => undefined);
    }
    // Released before the log closes, so a folder handed back is the last thing
    // written and a support question can see it happened.
    if (lock) {
      await lock.release().catch((error: unknown) => {
        log.muted(`could not remove the lock file: ${messageOf(error)}`);
      });
    }
    file?.close();
  }
}

/**
 * The --once path: no waiting, no signals, no live watching.
 *
 * By the time start resolves, the walk has already offered everything it found,
 * so intake closes here and the watcher is shut immediately. The watcher was
 * armed before the walk all the same, because that is the order with no gap,
 * and arming it costs one handle we then hand straight back.
 *
 * Since M3 the pass has a failure exit of its own: EXIT.PROBLEMS when at least
 * one file did not make it. It is not FAILED, because the pass itself worked,
 * and it is not OK either, because a scheduled task that only ever sees zero
 * has no way to notice that this tool has been failing every night since a
 * folder went read only. Nothing about the files changes: they are still on
 * disk and still absent from the ledger, so the next run tries them again.
 */
async function runOnePass(queue: UploadQueue, started: StartResult, log: Logger): Promise<number> {
  queue.stopIntake();
  log.info(
    started.reconciled.length === 0
      ? 'nothing waiting on disk'
      : `${plural(started.reconciled.length, 'file')} to look at, delivering them now`,
  );

  try {
    await started.handle?.close();
  } catch (error) {
    log.muted(`the watcher did not close cleanly: ${messageOf(error)}`);
  }
  try {
    await queue.drain();
  } catch (error) {
    log.error(`the queue did not finish cleanly: ${messageOf(error)}`);
  }

  const failed = queue.totals.failed;
  if (failed === 0) return EXIT.OK;
  log.warn(
    `${plural(failed, 'file')} did not make it, so this pass exits ${EXIT.PROBLEMS}. they are still on disk and the next run tries again.`,
  );
  return EXIT.PROBLEMS;
}

/**
 * Everything a control line is allowed to do, wired to this run.
 *
 * Kept in one place rather than spread through execute() because these five
 * are the entire remote control surface of this program, and a reader
 * wondering what a tray can make the core do should have one function to read.
 * Every one of them can arrive at any moment, including while the run is
 * already stopping, so every one of them says what it did on the human channel
 * even when the answer is that it did nothing.
 */
function buildControls(
  config: AppConfig,
  queue: UploadQueue,
  runtime: Runtime,
  log: Logger,
  gate: ControlGate,
  emit: (body: WatchEventBody) => void,
): Controls {
  /** One pass at a time. A second Deliver now while the first is walking is a no-op. */
  let rescanning = false;

  const rescan = (): void => {
    if (gate.stopping) {
      log.warn('this run is stopping, so there is nothing a check of the folders could deliver');
      return;
    }
    if (rescanning) {
      log.muted('the folders are already being checked, so this one is not needed');
      return;
    }
    const walk = runtime.reconcile;
    if (typeof walk !== 'function') {
      log.warn('this build cannot check the folders on demand');
      return;
    }

    rescanning = true;
    log.info('checking the folders against the ledger, because you asked');
    emit({ type: 'scanning', dirs: config.watchDirs });

    void (async () => {
      let found = 0;
      try {
        const seen = await walk(config, (candidate) => {
          queue.offer(candidate);
        });
        found = seen.length;
      } catch (error) {
        log.warn(`could not check the folders: ${messageOf(error)}`);
      } finally {
        rescanning = false;
      }
      // Emitted whatever happened, including after a failed walk. A busy state
      // with no clearing condition is the M2 delivering-icon bug, and a scan
      // that ends in silence is exactly that bug with a different trigger.
      emit({ type: 'delivering', found, reason: 'rescan' });
      if (queue.isPaused) {
        log.info(
          found === 0
            ? 'nothing new on disk, and this run is paused in any case'
            : `${plural(found, 'file')} to look at, and this run is paused, so they wait with the rest`,
        );
        return;
      }
      try {
        // The tokens already held go too. Deliver now means now, not at the
        // end of the next quiet spell.
        await queue.flush();
      } catch (error) {
        log.error(`the queue did not finish cleanly: ${messageOf(error)}`);
      }
    })();
  };

  return {
    stop: () => gate.request('stdin'),

    detach: () => {
      // The receipt first and everything else after, because the parent is
      // waiting on this line and nothing below concerns it.
      emit({ type: 'detached' });
      log.info(
        gate.stopping
          ? 'letting go of the process that started this one. still finishing the queue.'
          : 'the process that started this one is leaving. finishing the queue here, then out.',
      );
      gate.detach();
    },

    pause: () => {
      if (gate.stopping) {
        log.warn('this run is already stopping, so there is nothing left to pause');
        return;
      }
      if (queue.pausedFor.includes('user')) {
        log.muted('already paused');
        // Said on the machine channel as well, and this is the one place in
        // here where that needs defending. Nothing changed, so there is no
        // transition to report; what is wrong is the picture held by whoever
        // asked. A shell reads silence as "it did not understand the word" and
        // acts on that reading, so a word that changes nothing still has to
        // come back with the state it found. See the M3 review's first
        // critical, and note that the state is the answer either way: after
        // this line the queue is held for the user, which is what the event
        // says.
        emit({ type: 'paused', reason: 'user' });
        return;
      }
      queue.pause();
      log.info('paused. nothing goes up until this is resumed, and new files are kept.');
    },

    resume: () => {
      if (gate.stopping) {
        log.warn('this run is stopping, so there is nothing left to resume');
        return;
      }
      // Read before the word is acted on, because afterwards there is no way
      // back to it: 'still-held' covers both a user hold that really lifted and
      // a resume sent at a queue only the budget was ever holding, and only one
      // of those two is announced by the queue.
      const wasTheirs = queue.pausedFor.includes('user');
      switch (queue.resume()) {
        case 'still-held':
          log.warn(
            wasTheirs
              ? "resumed, but the day's request budget is still spent, so files keep waiting until it comes back"
              : "nothing of yours was holding this, and the day's request budget is still spent, so files keep waiting until it comes back",
          );
          // When it really was theirs the queue announced the lift itself, with
          // a `resumed` carrying reason user and a waiting of 0, and the
          // budget's own hold stays announced as it was. When it was not, the
          // queue changed nothing and said nothing, so the state is the answer,
          // exactly as in the branch below.
          if (!wasTheirs) emit({ type: 'resumed', reason: 'user', waiting: 0 });
          return;
        case 'not-paused':
          log.muted('nothing was paused');
          // Same reasoning as the already-paused branch above. This is also the
          // recovery path when the two sides have drifted apart for any reason
          // at all, a dropped line included: the second click is how a person
          // says "I do not believe you", and it has to be able to put the
          // picture right rather than confirm it.
          emit({ type: 'resumed', reason: 'user', waiting: 0 });
          return;
        default:
          // The queue says the rest, including how many were waiting.
          return;
      }
    },

    rescan,

    eof: () => {
      if (gate.detached) {
        // Agreed silence. Saying so matters: this line in the log file is the
        // difference between a core that was let go and a core that was
        // orphaned by a crash, and they look identical from outside.
        log.muted('the process that started this one has gone, as agreed. still finishing.');
        return;
      }
      log.muted('the process that started this one closed its end, stopping');
      gate.request('stdin');
    },
  };
}

/**
 * Blocks until somebody asks to stop, then closes intake and drains.
 *
 * Four things can ask, and three of them are treated identically: a signal this
 * process raised on itself, a stop() call from a parent in the same process, a
 * line on stdin, and a detach. Asking twice means the caller has stopped being
 * patient, so we leave without draining and say what that costs.
 *
 * The exception is the whole of M3's detach work, and it is one branch: once
 * the parent has been let go, a second request is not impatience, it is the
 * agreed silence arriving as end of file, and the drain carries on.
 */
async function waitForStop(
  queue: UploadQueue,
  handle: WatchHandle | undefined,
  log: Logger,
  gate: ControlGate,
  emit: (body: WatchEventBody) => void,
): Promise<number> {
  let stopping = false;
  let settle: ((code: number) => void) | undefined;
  const stopped = new Promise<number>((resolve) => {
    settle = resolve;
  });

  const onStop = (reason: StopReason): void => {
    if (stopping) {
      if (gate.detached) {
        // A detach during a drain, or the end of file that follows one. Both
        // are the parent leaving with permission, and neither is a second stop.
        // This branch is the fix for the M2 review's second critical.
        return;
      }
      log.plain();
      log.warn('leaving now, files still in the queue are picked up by the next startup scan');
      emit({ type: 'stopping', reason: 'impatient' });
      // Saying it is not enough. The drain started by the first stop may be
      // parked on a retry nap with fifteen minutes left on it, and a pending
      // timer keeps Node alive no matter what this function returns. This is
      // what makes the sentence above true.
      queue.leaveNow();
      settle?.(EXIT.INTERRUPTED);
      return;
    }
    stopping = true;
    log.plain();
    emit({ type: 'stopping', reason });
    log.info(
      reason === 'signal'
        ? 'stopping. finishing what is already in the queue, press ctrl+c again to leave now.'
        : 'stopping. finishing what is already in the queue.',
    );
    queue.stopIntake();
    void (async () => {
      try {
        await handle?.close();
      } catch (error) {
        log.muted(`the watcher did not close cleanly: ${messageOf(error)}`);
      }
      try {
        await queue.drain();
      } catch (error) {
        log.error(`the queue did not finish cleanly: ${messageOf(error)}`);
      }
      settle?.(EXIT.OK);
    })();
  };

  const onSignal = (): void => onStop('signal');

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  gate.arm(onStop);
  try {
    return await stopped;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    gate.disarm();
  }
}
