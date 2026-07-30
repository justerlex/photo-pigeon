/**
 * login: sign in, on its own, without starting a watch.
 *
 * Two audiences need this. The first is anyone whose refresh token stopped
 * working, because doctor and the transport both end their advice with "run
 * photo-pigeon login" and that sentence has to lead somewhere. The second is the
 * headless case: the Photos API allows loopback OAuth only, so a machine with no
 * browser cannot sign itself in. The documented path is to run this on a desktop
 * and copy the token file across, which needs a command that does the sign in
 * and nothing else.
 *
 * It never writes the token itself. The transport owns that file.
 */

import { EXIT } from './errors.js';
import { createLogger, type Logger } from './log.js';
import { defaultRuntime, type Runtime } from './runtime.js';

/** Flags the login command accepts. */
export interface LoginOptions {
  /** Explicit config file. */
  config?: string;
}

/**
 * Runs the consent flow, or refreshes quietly when the stored token still works.
 * Resolves with the exit code.
 */
export async function runLogin(
  options: LoginOptions = {},
  runtime: Runtime = defaultRuntime,
  log: Logger = createLogger(),
): Promise<number> {
  const config = await runtime.loadConfig(options.config);
  const client = await runtime.createClient(config);

  log.info('signing in with your own Google credentials');
  await client.ensureAuth();

  log.ok('signed in.');
  log.muted(`token: ${config.tokenPath}`);
  log.plain();
  log.plain('That token belongs to your client id and to this machine.');
  log.plain('For a machine with no browser, copy that file there: the Photos API');
  log.plain('has no device flow, so signing in has to happen where a browser can open.');
  log.plain();
  log.plain('Next: photo-pigeon watch');
  return EXIT.OK;
}
