/**
 * The wizard's screens.
 *
 * Creating an OAuth client cannot be automated, Google closed the last
 * programmatic path in March 2026. So the value here is removal: the console
 * walk that every tutorial writes as ten steps is five, each one deep linked
 * and opened for you, and only two of them need real thought.
 *
 * Two steps that every tutorial includes are deliberately gone:
 *   · declaring scopes, which only matters if you submit for verification
 *   · adding test users, which stops mattering the moment the app is published
 */

import path from 'node:path';
import type { Ask } from './ask.js';
import {
  consoleLink,
  containsGoogle,
  isPlausibleProjectId,
  isTheSuggestedName,
  SUGGESTED_PROJECT_NAME,
} from './links.js';
import { dirExists, fileExists, type FsLike } from './fs-like.js';
import {
  CredentialsError,
  installCredentials,
  newestCandidate,
  type ParsedClientCredentials,
  scanForClientSecrets,
  watchForClientSecret,
} from './credentials.js';
import { humanizeDuration } from './time.js';
import { good, heading, note, openAndShow, problem, say, showLink, step, type WizardIo } from './ui.js';
import { checkWatchDir, cleanTypedPath } from './watch-dirs.js';

/** How many console screens the user actually visits. */
export const TOTAL_STEPS = 5;

/** What the screens need to do their work. */
export interface StepContext {
  /** Where output goes and how links get opened. */
  io: WizardIo;
  /**
   * How the screens ask a question.
   *
   * The output seam has been here since the first version; this is the other
   * half, added at M4 so the terminal wizard and the tray's first-run window
   * are two front ends over one state machine rather than two wizards. The
   * screens below never import a prompt library and never test for a TTY.
   */
  ask: Ask;
  /** False when links should only be printed, never launched. */
  openLinks: boolean;
  /** File system, injectable for tests. */
  fs: FsLike;
}

/** Loops a yes or no question until the answer is yes, offering the link again each time round. */
async function confirmDone(
  ctx: StepContext,
  message: string,
  url: string,
  retryLine = 'No rush. Here is that link again:',
): Promise<void> {
  for (;;) {
    const done = await ctx.ask.confirm({ message, default: true });
    if (done) return;
    say(ctx.io);
    say(ctx.io, `  ${retryLine}`);
    await openAndShow(ctx.io, url, ctx.openLinks);
  }
}

// ---------------------------------------------------------------------------
// Intro
// ---------------------------------------------------------------------------

/** The honesty screen. Everything expensive about this tool is said before anyone spends time on it. */
export function showIntro(ctx: StepContext): void {
  const { io } = ctx;
  say(io);
  say(io, 'photo-pigeon watches a folder and delivers every new photo to Google Photos.');
  say(io);
  say(io, 'Two things worth knowing before you spend ten minutes here:');
  say(io);
  step(io, 'Uploads through the API are always original quality and they count');
  say(io, '    against your Google account storage. Storage Saver does not apply to');
  say(io, '    them and cannot be turned on from here. If Drive for Desktop was');
  say(io, '    compressing your backups, this will use more space than that did.');
  step(io, 'Nothing is ever deleted. photo-pigeon uploads, in one direction, and');
  say(io, '    that is the whole of it. It cannot read your existing library and it');
  say(io, '    cannot remove anything from it. There is no code in it that could.');
  say(io);
  say(io, `Setup is ${TOTAL_STEPS} screens in your browser, most of them one button. You end up`);
  say(io, 'with your own Google Cloud project, which means your own daily quota that');
  say(io, 'nobody else shares, and credentials that live only on this machine.');
  say(io);
}

// ---------------------------------------------------------------------------
// Step 1: the Cloud project
// ---------------------------------------------------------------------------

/** Creates the Cloud project and, if the user pastes it, learns the project id so later links land in it. */
export async function stepCreateProject(ctx: StepContext): Promise<string | undefined> {
  const { io } = ctx;
  heading(io, 1, TOTAL_STEPS, 'Create a Google Cloud project');
  say(io, '  A project is the container Google hangs the API and your sign-in client');
  say(io, '  on. It is free, it is yours, and having your own is the point: the daily');
  say(io, '  upload quota belongs to the project, so you never share it with anyone.');
  await openAndShow(ctx.io, consoleLink('projectCreate'), ctx.openLinks);
  step(io, `Name it ${SUGGESTED_PROJECT_NAME}, or anything you like with one rule below.`);
  step(io, 'Leave organisation and location alone. Click Create and wait a moment.');
  say(io);
  note(io, 'The name you type is not the id you are asked for below. Google makes a');
  say(io, '       globally unique id out of it, and when the plain form is already taken');
  say(io, `       it adds digits, so yours may read ${SUGGESTED_PROJECT_NAME}-473829 rather`);
  say(io, '       than what you typed. The create screen prints it under the name box');
  say(io, '       with an Edit link beside it, and afterwards it is the ID column in the');
  say(io, '       project picker at the top of the console.');
  say(io);
  note(io, 'Do not put the word Google in the name. Google rejects names containing');
  say(io, '       it, and the console only tells you at the very last screen.');
  say(io);

  await confirmDone(ctx, 'Project created?', consoleLink('projectCreate'));

  const projectId = await ctx.ask.input({
    message: 'Paste the project id, not the name (or press Enter to skip):',
    validate: (value) => {
      const trimmed = value.trim();
      if (!trimmed) return true;
      if (containsGoogle(trimmed)) {
        return 'That has the word Google in it, which Google does not allow. Check the id again.';
      }
      if (isTheSuggestedName(trimmed)) {
        return `That is the name this wizard suggested, not the id Google made from it. The two are different strings, and that one is somebody else's project, so every link after this would open a project you cannot see. Read the id off the console: it is the ID column in the project picker, and it probably has digits on the end.`;
      }
      return isPlausibleProjectId(trimmed)
        ? true
        : 'That does not look like a project id. It is lowercase letters, digits and hyphens, often with four random characters on the end.';
    },
  });

  const trimmed = projectId.trim();
  if (trimmed) {
    good(io, 'Every link from here on will open straight into that project.');
    say(io, '       If a later screen says you need additional access to a project, or');
    say(io, '       lists permissions you are missing, then this id was not yours. Nothing');
    say(io, '       is broken: run setup again and paste the right one.');
  } else {
    note(io, 'Skipped. The links will open whichever project you last had selected,');
    say(io, '       so glance at the project name in the console header each time.');
  }
  return trimmed || undefined;
}

// ---------------------------------------------------------------------------
// Step 2: the API
// ---------------------------------------------------------------------------

/** Turns the Photos Library API on for the project. */
export async function stepEnableApi(ctx: StepContext, projectId?: string): Promise<void> {
  const { io } = ctx;
  const url = consoleLink('enablePhotosApi', projectId);
  heading(io, 2, TOTAL_STEPS, 'Turn on the Photos Library API');
  say(io, '  One button on this one.');
  await openAndShow(ctx.io, url, ctx.openLinks);
  step(io, 'Click Enable. It is done when the button turns into Manage.');
  step(io, 'If it says the API is already enabled, that is also done.');
  say(io);
  await confirmDone(ctx, 'Photos Library API enabled?', url);
}

// ---------------------------------------------------------------------------
// Step 3: branding, the consent screen
// ---------------------------------------------------------------------------

/** Fills in the consent screen with the smallest set of fields that works. */
export async function stepConsentScreen(ctx: StepContext, projectId?: string): Promise<void> {
  const { io } = ctx;
  const url = consoleLink('authOverview', projectId);
  heading(io, 3, TOTAL_STEPS, 'Set up the sign-in screen');
  say(io, '  This is the screen you will see when you sign in, so it only has to make');
  say(io, '  sense to you. Google calls this corner the Google Auth Platform.');
  await openAndShow(ctx.io, url, ctx.openLinks);
  step(io, 'Click Get started. A short form opens, three parts:');
  step(io, 'App Information: name it photo-pigeon, or anything without the word');
  say(io, '    Google in it, and pick your own address as the support email.');
  step(io, 'Audience: External. That word sounds public, and it is not. It means the');
  say(io, '    app can sign in an ordinary gmail.com account, which is yours.');
  step(io, 'Contact Information: your own address again. Then agree and create.');
  say(io);
  note(io, 'Two steps most guides put here are missing on purpose. You do not need');
  say(io, '       to declare scopes: that only matters if you submit the app to Google');
  say(io, '       for review, and you will not. You do not need to add test users');
  say(io, '       either: that stops mattering entirely at the next step.');
  say(io);
  await confirmDone(ctx, 'Sign-in screen saved?', url);
}

// ---------------------------------------------------------------------------
// Step 4: publish. The one click that decides whether this tool keeps working.
// ---------------------------------------------------------------------------

/** Forces the Publish app click. Returns the ISO timestamp of the confirmation. */
export async function stepPublish(ctx: StepContext, projectId?: string): Promise<string> {
  const { io } = ctx;
  const url = consoleLink('audience', projectId);
  heading(io, 4, TOTAL_STEPS, 'Publish the app');
  say(io, '  This is the most important click in the whole setup, and it is the one');
  say(io, '  every guide leaves for later.');
  say(io);
  say(io, '  A new app sits in Testing. In Testing, Google hands out sign-ins that');
  say(io, '  expire after seven days. Everything works, you forget about it, and next');
  say(io, '  week the uploads stop with a message about invalid_grant. Publishing now');
  say(io, '  costs one click and removes that entirely.');
  say(io);
  say(io, '  Before you click, here is what happens afterwards, so it does not read as');
  say(io, '  something going wrong:');
  say(io);
  step(io, 'The first time you sign in, Google shows a full page saying');
  say(io, '    "Google hasn\'t verified this app". You click Advanced, then the');
  say(io, '    "Go to ... (unsafe)" link underneath.');
  step(io, 'That screen is expected and it appears exactly once. It is there because');
  say(io, '    the app is new and unreviewed, and review is a paid process meant for');
  say(io, '    apps with strangers as users. Here the app is yours, the account is');
  say(io, '    yours, and the only thing it can do is add photos.');
  await openAndShow(ctx.io, url, ctx.openLinks);
  step(io, 'On the Audience page, click Publish app and confirm.');
  step(io, 'Publishing status should end up saying In production.');
  say(io);

  for (;;) {
    const published = await ctx.ask.confirm({
      message: 'Publishing status now says In production?',
      default: false,
    });
    if (published) {
      good(io, 'That is the failure mode of this whole category of tool, gone.');
      return new Date().toISOString();
    }
    say(io);
    problem(io, 'This one has no skip. An app left in Testing works for a week and then');
    say(io, '       quietly stops, and the fix is this same click anyway. Take your time:');
    await openAndShow(ctx.io, url, ctx.openLinks);
  }
}

// ---------------------------------------------------------------------------
// Step 5: the client, and its JSON
// ---------------------------------------------------------------------------

/** Walks the user through creating a Desktop client and downloading its JSON. */
export async function stepCreateClient(ctx: StepContext, projectId?: string): Promise<void> {
  const { io } = ctx;
  const url = consoleLink('createClient', projectId);
  heading(io, 5, TOTAL_STEPS, 'Create your sign-in client');
  say(io, '  Last screen. This makes the credentials that let photo-pigeon ask you for');
  say(io, '  permission. They stay on this machine and go nowhere else.');
  await openAndShow(ctx.io, url, ctx.openLinks);
  step(io, 'Application type: Desktop app. This matters: the sign-in happens on an');
  say(io, '    address on your own machine, and only a Desktop client is allowed to.');
  step(io, 'Name: anything, only you ever see it.');
  step(io, 'Click Create, then Download JSON in the panel that pops up.');
  say(io);
  note(io, 'Download it now, while that panel is open. Google shows a client secret');
  say(io, '       exactly once, at creation. If the panel closes, the only way forward is');
  say(io, '       to create another client.');
  say(io);
}

// ---------------------------------------------------------------------------
// Credentials intake
// ---------------------------------------------------------------------------

/** Where the credentials came from, worth knowing only for the confirmation line. */
export type CredentialsSource = 'downloads' | 'typed' | 'existing';

/** The result of getting the user's client JSON onto disk in our own folder. */
export interface CredentialsIntake {
  /** Where the file was picked up from. */
  source: CredentialsSource;
  /** The path it was picked up from. The original is left untouched. */
  sourcePath: string;
  /** What the JSON said. */
  parsed: ParsedClientCredentials;
}

/** Options for the credentials intake screen. */
export interface CredentialsIntakeOptions {
  /** Folders to watch and scan, most likely first. */
  downloadsDirs: string[];
  /** Where the client JSON gets copied to. */
  destPath: string;
}

/**
 * Picks up the downloaded client JSON.
 *
 * Three ways in, in this order: a matching file already sitting in Downloads,
 * one that lands while we watch, or a path typed by hand. The watching is event
 * driven, and the typed prompt stays live the whole time so nobody is ever
 * stuck waiting on a browser that saved somewhere unexpected.
 */
export async function intakeCredentials(
  ctx: StepContext,
  options: CredentialsIntakeOptions,
): Promise<CredentialsIntake> {
  const { io } = ctx;
  const { downloadsDirs, destPath } = options;

  const watchable: string[] = [];
  for (const dir of downloadsDirs) {
    if (await dirExists(dir, ctx.fs)) watchable.push(dir);
  }

  say(io);
  if (watchable.length > 0) {
    say(io, '  Watching for the download:');
    for (const dir of watchable) say(io, `    ${dir}`);
  } else {
    say(io, '  I could not find a Downloads folder to watch on this machine.');
  }
  say(io);

  // Already there? Offer the newest one first.
  const existing = newestCandidate(await scanForClientSecrets(watchable, ctx.fs));
  if (existing) {
    const age = humanizeDuration(Date.now() - existing.mtimeMs);
    const useIt = await ctx.ask.confirm({
      message: `Found ${path.basename(existing.path)}, saved ${age}. Use it?`,
      default: true,
    });
    if (useIt) {
      const intake = await tryInstall(ctx, existing.path, destPath, 'existing');
      if (intake) return intake;
    }
  }

  for (;;) {
    const picked = await waitForFile(ctx, watchable);
    const intake = await tryInstall(ctx, picked.path, destPath, picked.source);
    if (intake) return intake;
  }
}

interface PickedFile {
  path: string;
  source: CredentialsSource;
}

/** Races the Downloads watcher against a prompt for a typed path. First one wins, the other is called off. */
async function waitForFile(ctx: StepContext, watchable: string[]): Promise<PickedFile> {
  const controller = new AbortController();

  const detected = watchForClientSecret(watchable, controller.signal).then(
    (found): PickedFile => ({ path: found, source: 'downloads' }),
  );
  detected.catch(() => undefined);

  const typed = (async (): Promise<PickedFile> => {
    for (;;) {
      const answer = await ctx.ask.input({
        message: 'Waiting for the download. Or paste the full path to the JSON:',
        signal: controller.signal,
      });
      const cleaned = cleanTypedPath(answer);
      if (!cleaned) continue;
      const resolved = path.resolve(cleaned);
      if (await fileExists(resolved, ctx.fs)) return { path: resolved, source: 'typed' };
      problem(ctx.io, `Nothing at ${resolved}`);
    }
  })();
  typed.catch(() => undefined);

  try {
    return await Promise.race([detected, typed]);
  } finally {
    controller.abort();
  }
}

/** Copies the file in, or explains what is wrong with it and hands back undefined so the caller keeps waiting. */
async function tryInstall(
  ctx: StepContext,
  sourcePath: string,
  destPath: string,
  source: CredentialsSource,
): Promise<CredentialsIntake | undefined> {
  try {
    const parsed = await installCredentials(sourcePath, destPath, ctx.fs);
    say(ctx.io);
    good(ctx.io, `Credentials saved to ${destPath}`);
    say(ctx.io, `       Your copy in ${path.dirname(sourcePath)} was left where it is.`);
    return { source, sourcePath, parsed };
  } catch (error) {
    say(ctx.io);
    if (error instanceof CredentialsError) {
      problem(ctx.io, error.message);
      return undefined;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// What to watch
// ---------------------------------------------------------------------------

/** The folder question and the optional album, asked after the browser work is done. */
export interface WatchChoices {
  watchDirs: string[];
  albumName?: string;
}

/** Asks which folders to watch and whether new photos should land in an album. */
export async function askWatchChoices(ctx: StepContext, defaultDir?: string): Promise<WatchChoices> {
  const { io } = ctx;
  say(io);
  say(io, '  Last question, and this one is about your machine, not Google.');
  say(io);

  const watchDirs: string[] = [];
  for (;;) {
    const answer = await ctx.ask.input({
      message: watchDirs.length === 0 ? 'Which folder should the pigeon watch?' : 'Path of the next folder:',
      ...(watchDirs.length === 0 && defaultDir !== undefined ? { default: defaultDir } : {}),
      // The rule itself lives in `./watch-dirs.ts` because the status window's
      // Watching list applies it too, through the `folders` command. It used to
      // live here and compare with `includes`, an exact string match, while the
      // writer collapses two spellings of one Windows folder into one entry: so
      // `D:\Photos` and then `d:\photos` was accepted, acknowledged, and then
      // dropped on the way to disk.
      validate: async (value) => {
        const verdict = await checkWatchDir(value, watchDirs, ctx.fs);
        return verdict.ok ? true : verdict.why;
      },
    });
    watchDirs.push(path.resolve(cleanTypedPath(answer)));
    say(io, '       Subfolders are included.');
    const another = await ctx.ask.confirm({ message: 'Add another folder?', default: false });
    if (!another) break;
  }

  const wantsAlbum = await ctx.ask.confirm({
    message: 'Put everything into one album in Google Photos?',
    default: false,
  });
  let albumName: string | undefined;
  if (wantsAlbum) {
    const name = await ctx.ask.input({
      message: 'Album name:',
      default: 'photo-pigeon',
      validate: (value) => (value.trim() ? true : 'An album needs a name.'),
    });
    albumName = name.trim();
    note(io, 'The album is created by this app, so this app can add to it. Albums you');
    say(io, '       made yourself in Google Photos are invisible to it, by Google\'s design.');
  }

  const result: WatchChoices = { watchDirs };
  if (albumName) result.albumName = albumName;
  return result;
}

// ---------------------------------------------------------------------------
// Closing
// ---------------------------------------------------------------------------

/**
 * True when the file we copied from is somewhere the user chose, rather than
 * inside photo-pigeon's own folder. Suggesting someone delete our own
 * credentials.json would be a fine way to break their setup.
 */
function isOutsidePigeonFolder(sourcePath: string, configPath: string): boolean {
  const pigeonDir = path.resolve(path.dirname(configPath));
  return path.resolve(path.dirname(sourcePath)) !== pigeonDir;
}

/**
 * The leftover client JSON.
 *
 * It is a password, it is sitting in Downloads where everything else in
 * Downloads can see it, and photo-pigeon has its own copy now. So we say the
 * exact path and suggest getting rid of it. We do not do it: this tool deletes
 * nothing, on disk or at Google, and a folder the user chose is not ours to
 * tidy up.
 */
function suggestRemovingTheDownload(ctx: StepContext, sourcePath: string, configPath: string): void {
  const { io } = ctx;
  if (!isOutsidePigeonFolder(sourcePath, configPath)) return;
  say(io);
  note(io, 'That downloaded client file is a password, and it is still sitting where');
  say(io, '       your browser put it. photo-pigeon has its own copy now, so nothing here');
  say(io, '       needs the original any more. Worth deleting:');
  say(io);
  say(io, `         ${sourcePath}`);
  say(io);
  say(io, '       Delete it yourself when you are ready. photo-pigeon will not: it does');
  say(io, '       not delete anything, here or in your library.');
}

/** The finish screen: what was written, what happens next, and the one warning worth repeating. */
export function showOutro(
  ctx: StepContext,
  configPath: string,
  watchDirs: string[],
  projectId?: string,
  credentialsSourcePath?: string,
): void {
  const { io } = ctx;
  say(io);
  good(io, `Setup written to ${configPath}`);
  for (const dir of watchDirs) say(io, `       watching ${dir}`);
  say(io);
  say(io, '  Next photo-pigeon opens a browser once, you sign in, and you get the');
  say(io, '  "Google hasn\'t verified this app" screen we talked about. Advanced, then');
  say(io, '  the link underneath. That is the last time you see it.');
  if (credentialsSourcePath) suggestRemovingTheDownload(ctx, credentialsSourcePath, configPath);
  say(io);
  note(io, 'Keep that client. Google Photos only ever shows uploads back to the exact');
  say(io, '       client id that made them, so if you ever delete this client and make a');
  say(io, '       new one, everything already uploaded becomes invisible to the tool and');
  say(io, '       it would deliver it all again. The client list, for when that day comes:');
  showLink(io, consoleLink('clients', projectId));
}

/**
 * Refuse early if the front end holding the questions cannot work here.
 *
 * This used to be a bare `process.stdin.isTTY` check and it was the single
 * thing that made the wizard unreusable from a window: a sidecar spawned by
 * the tray is never a TTY, so setup threw on its own first screen. The check
 * itself was right and only ever applied to one front end, so it moved onto
 * that front end. `terminalAsk` still throws the same sentence; the NDJSON
 * channel has a pipe of its own and answers here without a terminal anywhere.
 */
export function requireInteractive(ask: Ask): void {
  ask.ensureUsable?.();
}
