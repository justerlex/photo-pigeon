/**
 * doctor: hand over to the wizard's own health check.
 *
 * The wizard knows what a healthy Google Cloud project looks like: API enabled,
 * consent screen published rather than left in Testing, client not idle long
 * enough for Google to delete it, same client id as at setup. It looks in its
 * own home folder and reports for itself, including the case where setup never
 * ran, so this command only prints the verdict and turns it into an exit code.
 *
 * `--json` is the health window's backing, added at M4. It is deliberately a
 * passthrough and not a second report: `DoctorReport` has carried `checks` with
 * a level each since the first version, and the only thing that ever flattened
 * it was `formatDoctorReport` on the way to a terminal. A page gets the shape
 * the checker already produces, so the window and the terminal can never
 * disagree about what is wrong.
 */

import { EXIT } from './errors.js';
import { createLogger, type Logger } from './log.js';
import { defaultRuntime, type Runtime } from './runtime.js';

/** Flags the doctor command accepts. */
export interface DoctorOptions {
  /** Write the structured report as one JSON line instead of a screen. */
  json?: boolean;
  /**
   * Report on the setup beside this config file instead of the usual one.
   *
   * Added at M4 with `--json`, and for the same reason: the health window is
   * opened by a tray that may itself be running against an override. Without
   * this, a shell pointed at a throwaway config would ask about the folder it
   * is not watching, and every development and rig run would read the
   * machine's real `~/.photo-pigeon`, which the safety rules forbid. `watch`, `status`,
   * `login` and `setup` have all taken the same flag since M1; doctor was the
   * odd one out on the grounds that it "checks the setup the wizard made", and
   * the wizard makes one wherever `-c` says.
   */
  config?: string;
}

/** The folder a `-c` path puts the whole setup in. The same rule setup uses. */
function configDirOf(configPath: string | undefined): string | undefined {
  if (!configPath || configPath.trim() === '') return undefined;
  const path = configPath.trim();
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut > 0 ? path.slice(0, cut) : '.';
}

/** Runs the health check. Resolves with the exit code: nonzero when something needs fixing. */
export async function runDoctor(
  options: DoctorOptions = {},
  runtime: Runtime = defaultRuntime,
  log: Logger = createLogger(),
): Promise<number> {
  const configDir = configDirOf(options.config);
  if (options.json) {
    const report = await runtime.runDoctorReport(configDir);
    // Straight to the descriptor, not through the logger: under --json stdout
    // carries one JSON line and nothing else, which is the same guarantee the
    // watch channel makes and the same reason. The logger handed in here is
    // already the stderr one.
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return report.ok ? EXIT.OK : EXIT.PROBLEMS;
  }

  const report = await runtime.runDoctor(configDir);
  log.plain();
  log.plain(report.text);
  log.plain();
  return report.ok ? EXIT.OK : EXIT.PROBLEMS;
}
