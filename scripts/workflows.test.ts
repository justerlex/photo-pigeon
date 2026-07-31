/**
 * The two workflows, parsed rather than eyeballed.
 *
 * A workflow is the one file in this repo whose first real execution is on a
 * hosted runner, at the moment it matters most, with a tag already pushed. There
 * is no local run of it and there is no type checker over it, so everything about
 * it that can be checked at the desk is checked here.
 *
 * Three kinds of thing, and only the first is about YAML:
 *
 * 1. It parses, with a real parser, and carries no tab and no em dash.
 * 2. The ordering facts TRAY-DESIGN says CI cannot guess. Section 5: the sidecar
 *    has to be staged BEFORE the Rust build, because tauri.conf.json names
 *    binaries/ and resources/ and a fresh clone has neither. A comment saying so
 *    is a comment; this is the assertion.
 * 3. The two laws that are policy rather than mechanics: the release is created
 *    as a DRAFT, because publishing is a human click, and nothing on the tag road
 *    publishes to npm, which cannot be undrafted once done.
 *
 * The e2e rig is deliberately absent from both files, and that is asserted too:
 * it is Windows PowerShell that launches real trays and waits on a tray icon, a
 * Run key and a pair of eyes. A hosted runner has no session to put a tray in, so
 * a green rig there would mean nothing. It is walked by hand, per
 * app/e2e/CHECKLIST.md.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..');
const WORKFLOWS = join(REPO_ROOT, '.github', 'workflows');

/** U+2014. Named rather than pasted, so this file does not contain one. */
const EM_DASH = String.fromCharCode(0x2014);

/** The Node that ships inside the installer. One pin, read from the contract. */
const PINNED_NODE = JSON.parse(
  readFileSync(join(REPO_ROOT, 'app', 'scripts', 'sidecar-layout.json'), 'utf8'),
).nodeVersion.replace(/^v/, '');

/**
 * The minisign id of the throwaway updater key the repository ships today.
 *
 * It was generated in the m5-updater lane so the plugin could be wired, built
 * and tested before the real signing key existed, and step 2 of docs/RELEASE.md
 * is the swap. It is named here as a literal rather than read out of
 * `tauri.conf.json`, because the assertion below has to keep meaning something
 * after the swap: this id is a denylist of one dead keypair, for ever.
 */
const THROWAWAY_KEY_ID = 'E17F8D75CFB8611F';

type Step = { name?: string; uses?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, string>; if?: string };
type Job = { 'runs-on'?: string; steps?: Step[]; permissions?: Record<string, string>; if?: string; env?: Record<string, string> };
type Workflow = {
  name?: string;
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  jobs: Record<string, Job>;
};

function workflow(file: string): { text: string; doc: Workflow } {
  const text = readFileSync(join(WORKFLOWS, file), 'utf8');
  return { text, doc: parse(text) as Workflow };
}

/** Index of the first step whose run line or action mentions a thing. */
function stepIndex(job: Job, needle: string): number {
  return (job.steps ?? []).findIndex(
    (step) => (step.run ?? '').includes(needle) || (step.uses ?? '').includes(needle),
  );
}

/**
 * The node-version every setup-node asks for, with a workflow level `env`
 * reference followed through, because that indirection is the point: one pin per
 * file, named where a reader will find it.
 */
function nodeVersionsIn(doc: Workflow): string[] {
  return Object.values(doc.jobs)
    .flatMap((job) => job.steps ?? [])
    .filter((step) => (step.uses ?? '').startsWith('actions/setup-node'))
    .map((step) => String(step.with?.['node-version'] ?? ''))
    .map((asked) => {
      const reference = asked.match(/^\$\{\{\s*env\.([A-Za-z_][\w]*)\s*\}\}$/);
      return reference ? (doc.env?.[reference[1]!] ?? `${reference[1]} is not in the workflow env`) : asked;
    });
}

describe('both workflows', () => {
  const files = () => readdirSync(WORKFLOWS).filter((name) => name.endsWith('.yml'));

  it('are exactly the two roads: every push, and a tag', () => {
    expect(files().sort()).toEqual(['ci.yml', 'release.yml']);
  });

  it('parse', () => {
    for (const file of files()) {
      const { doc } = workflow(file);
      expect(doc.name, file).toBeTypeOf('string');
      expect(doc.jobs, file).toBeTypeOf('object');
      expect(Object.keys(doc.jobs).length, file).toBeGreaterThan(0);
    }
  });

  it('carry no tab, which is not YAML indentation and is invisible in a diff', () => {
    for (const file of files()) expect(workflow(file).text, file).not.toContain('\t');
  });

  it('give every step something to do', () => {
    for (const file of files()) {
      for (const [name, job] of Object.entries(workflow(file).doc.jobs)) {
        for (const step of job.steps ?? []) {
          expect(Boolean(step.run) !== Boolean(step.uses), `${file} ${name}: ${step.name}`).toBe(true);
        }
      }
    }
  });

  it('pin every action they use to a version', () => {
    for (const file of files()) {
      for (const job of Object.values(workflow(file).doc.jobs)) {
        for (const step of job.steps ?? []) {
          if (!step.uses) continue;
          expect(step.uses, file).toMatch(/@[\w.-]+$/);
        }
      }
    }
  });

  it('run the pinned Node and not whatever the runner ships', () => {
    // build-sidecar.mjs stages the Node that RUNS it as the sidecar, and refuses
    // any version other than the pin. A runner default of the day would fail the
    // build with a message about durability guarantees, three steps later.
    for (const file of files()) {
      const versions = nodeVersionsIn(workflow(file).doc);
      expect(versions.length, file).toBeGreaterThan(0);
      for (const version of versions) expect(String(version), file).toBe(PINNED_NODE);
    }
  });

  it('never run the e2e rig, which launches trays and needs a person', () => {
    for (const file of files()) {
      expect(workflow(file).text, file).not.toMatch(/\.ps1/);
      expect(workflow(file).text, file).not.toMatch(/run-e2e|run-m3|run-m4|rig-selftest/);
    }
  });
});

describe('everything under .github', () => {
  function filesIn(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? filesIn(join(dir, entry.name)) : [join(dir, entry.name)],
    );
  }

  it('carries no em dash, release notes included, because the Release page is copy', () => {
    const files = filesIn(join(REPO_ROOT, '.github'));
    expect(files.length).toBeGreaterThan(2);

    const offenders = files.filter((file) => readFileSync(file, 'utf8').includes(EM_DASH));
    expect(offenders).toEqual([]);
  });

  it('has the release notes the draft is created with', () => {
    const notes = readFileSync(join(REPO_ROOT, '.github', 'release-notes.md'), 'utf8');

    // The unsigned wall, pre-warned rather than explained afterwards, and the two
    // words in the order the user meets them. TRAY-DESIGN section 5.
    expect(notes).toContain('More info');
    expect(notes).toContain('Run anyway');
    expect(notes.indexOf('More info')).toBeLessThan(notes.indexOf('Run anyway'));
    expect(notes).toMatch(/upload only|Upload only/);
  });
});

describe('ci.yml', () => {
  const { text, doc } = workflow('ci.yml');
  const job = Object.values(doc.jobs)[0]!;

  it('runs on a push to main and on pull requests', () => {
    expect(doc.on).toBeTypeOf('object');
    expect((doc.on as { push: { branches: string[] } }).push.branches).toContain('main');
    expect(Object.keys(doc.on as object)).toContain('pull_request');
  });

  it('is one job on windows, because the product is a Windows tray', () => {
    expect(Object.keys(doc.jobs)).toHaveLength(1);
    expect(job['runs-on']).toBe('windows-latest');
  });

  it('asks for no more than it needs', () => {
    expect(doc.permissions?.contents).toBe('read');
  });

  it('runs both suites and the lockstep check', () => {
    expect(stepIndex(job, 'npm ci')).toBeGreaterThanOrEqual(0);
    expect(stepIndex(job, 'npm test')).toBeGreaterThanOrEqual(0);
    expect(stepIndex(job, 'check-versions.mjs')).toBeGreaterThanOrEqual(0);
    expect(stepIndex(job, 'cargo test')).toBeGreaterThanOrEqual(0);
  });

  it('stages the sidecar before the Rust build, which is the ordering CI cannot guess', () => {
    const staged = stepIndex(job, 'build-sidecar.mjs');
    const rust = stepIndex(job, 'cargo test');

    expect(staged).toBeGreaterThanOrEqual(0);
    expect(rust).toBeGreaterThan(staged);
  });

  it('fails on version drift before it spends four minutes on a suite', () => {
    expect(stepIndex(job, 'check-versions.mjs')).toBeLessThan(stepIndex(job, 'npm test'));
  });

  it('never builds an installer, because a push is not a release', () => {
    expect(text).not.toContain('tauri-action');
    expect(text).not.toContain('gh release');
    expect(text).not.toContain('npm publish');
  });

  it('never asks the release-key question, because a push is not a release', () => {
    // The gate asserted over in release.yml is deliberately tag-only. Here it
    // would fail every push on every branch until the swap is done, which is a
    // gate that gets commented out rather than obeyed.
    expect(text).not.toContain(THROWAWAY_KEY_ID);
  });
});

describe('release.yml', () => {
  const { text, doc } = workflow('release.yml');

  const installer = Object.values(doc.jobs).find((job) => stepIndex(job, 'tauri-action') >= 0)!;
  const npmJob = Object.values(doc.jobs).find((job) => stepIndex(job, 'npm publish') >= 0)!;

  it('runs on a v tag', () => {
    expect((doc.on as { push: { tags: string[] } }).push.tags).toContain('v*');
  });

  it('checks the tag against the manifest, which is the third thing that can disagree', () => {
    const step = (installer.steps ?? []).find((one) => (one.run ?? '').includes('check-versions.mjs'));

    expect(step?.run).toContain('--tag');
  });

  it('runs both suites before it builds anything shippable', () => {
    const build = stepIndex(installer, 'tauri-action');

    expect(stepIndex(installer, 'npm test')).toBeLessThan(build);
    expect(stepIndex(installer, 'cargo test')).toBeLessThan(build);
  });

  it('stages the sidecar before the Rust build and before the bundle', () => {
    const staged = stepIndex(installer, 'build-sidecar.mjs');

    expect(staged).toBeGreaterThanOrEqual(0);
    expect(stepIndex(installer, 'cargo test')).toBeGreaterThan(staged);
    expect(stepIndex(installer, 'tauri-action')).toBeGreaterThan(staged);
  });

  it('hands the bundler both signing secrets, by the names the plugin reads', () => {
    const build = (installer.steps ?? []).find((step) => (step.uses ?? '').includes('tauri-action'));

    expect(build?.env?.TAURI_SIGNING_PRIVATE_KEY).toContain('secrets.TAURI_SIGNING_PRIVATE_KEY');
    expect(build?.env?.TAURI_SIGNING_PRIVATE_KEY_PASSWORD).toContain(
      'secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
    );
  });

  it('refuses the whole road in its first minute if no update could be signed', () => {
    // The alternative is a 20 minute build that fails at the assemble step, for a
    // fix that is one config line or one secret.
    const preflight = stepIndex(installer, 'createUpdaterArtifacts');

    expect(preflight).toBeGreaterThanOrEqual(0);
    expect(preflight).toBeLessThan(stepIndex(installer, 'npm ci'));
    expect(stepIndex(installer, 'TAURI_SIGNING_PRIVATE_KEY')).toBeGreaterThanOrEqual(0);
  });

  it('asks which key, and refuses the tag if it is still the throwaway', () => {
    // The one state on this road where every other gate stays green while the
    // release is already broken. The maintainer sets both signing secrets, step 3 of
    // docs/RELEASE.md, and step 2's swap is forgotten or half done. The preflight
    // above asks only whether a signing key exists, never which one. The shell
    // suite asks the opposite question on purpose: its
    // the_pubkey_in_the_shipped_config_is_still_the_throwaway asserts the
    // throwaway IS still there, so it is green in exactly this case and red when
    // the swap is done right. So the tag builds, tauri-action signs with the real
    // private key, latest.json assembles, and the draft looks perfect.
    //
    // What ships is a copy that trusts a key nobody signs with. Every daily check
    // after it downloads an update and fails verification, and supervisor.rs
    // answers a failed check with one log line and no attention state: silent,
    // permanent, and unfixable without a hand-downloaded installer.
    //
    // Four lines of pwsh turn the ordering guard in the runbook into a machine
    // one. The two assertions are the two halves of the shell test, so the
    // runbook can go on saying "delete it" without the tag road losing anything.
    const gate = (installer.steps ?? []).find((step) => (step.run ?? '').includes(THROWAWAY_KEY_ID));

    expect(gate, 'no step on the tag road names the throwaway key id').toBeDefined();
    expect(gate?.run).toContain('pubkey');
    expect(gate?.run).toContain('minisign public key');
    expect(gate?.run).toContain('exit 1');
  });

  it('asks it before it spends a minute on anything, like the other refusals', () => {
    const gate = stepIndex(installer, THROWAWAY_KEY_ID);

    expect(gate).toBeGreaterThanOrEqual(0);
    expect(gate).toBeLessThan(stepIndex(installer, 'npm ci'));
    expect(gate).toBeLessThan(stepIndex(installer, 'tauri-action'));
  });

  it('clears the bundle directory before the build, so one build means one installer', () => {
    // Row 13. rust-cache restores a target directory, so an installer from an
    // earlier tag could otherwise be sitting there when the assembler looks.
    const swept = stepIndex(installer, 'target/release/bundle');

    expect(swept).toBeGreaterThanOrEqual(0);
    expect(stepIndex(installer, 'tauri-action')).toBeGreaterThan(swept);
  });

  it('assembles latest.json before it creates the release', () => {
    const manifest = stepIndex(installer, 'make-latest-json.mjs');
    const release = stepIndex(installer, 'gh release create');

    expect(manifest).toBeGreaterThanOrEqual(0);
    expect(release).toBeGreaterThan(manifest);
  });

  it('creates the release as a draft, and never undrafts it', () => {
    // The publish gate. A draft is a release nobody can download by accident,
    // and the click that ends it is a person's.
    expect(text).toContain('--draft');
    expect(text).not.toContain('release edit');
    expect(text).not.toContain('--draft=false');
    expect(text).not.toContain('draft: false');
  });

  it('needs write access only where it writes', () => {
    expect(doc.permissions?.contents).toBe('read');
    expect(installer.permissions?.contents).toBe('write');
  });

  it('never publishes to npm on the tag, because npm publish cannot be undrafted', () => {
    expect(stepIndex(installer, 'npm publish')).toBe(-1);
    expect(npmJob.if ?? '').toContain('release');
  });

  /**
   * The npm half ran on a stored token until 2026-08-01, when the first real
   * attempt died with EOTP. npm revoked classic tokens in November 2025, and the
   * classic Automation type was the one that skipped the one-time password. What
   * is left collides with 2FA on writes, so the token was never going to work
   * here: it stood in for a person, and a person is exactly what the account
   * insists on. Trusted publishing removes the stand-in instead of hardening it.
   */
  it('publishes over OIDC, with no token anywhere to leak or expire', () => {
    const publish = (npmJob.steps ?? []).find((step) => (step.run ?? '').includes('npm publish'));

    expect(publish?.run).toContain('--provenance');
    expect(npmJob.permissions?.['id-token']).toBe('write');
    expect(text).not.toContain('NPM_TOKEN');
    expect(text).not.toContain('NODE_AUTH_TOKEN');
  });

  it('upgrades npm first, because trusted publishing needs 11.5.1 and the pin ships 10', () => {
    const upgrade = stepIndex(npmJob, 'npm install -g npm@');
    const publish = stepIndex(npmJob, 'npm publish');

    expect(upgrade).toBeGreaterThanOrEqual(0);
    expect(upgrade).toBeLessThan(publish);
  });

  /**
   * A publish can fail for reasons that have nothing to do with the build, as
   * the EOTP one did. Without this the only retry is a new version number, so
   * the npm half gets a door that needs an existing tag and never builds or
   * releases anything.
   */
  it('can retry the npm half on an existing tag without cutting a version', () => {
    expect(doc.on).toHaveProperty('workflow_dispatch');
    expect(npmJob.if ?? '').toContain('workflow_dispatch');
    expect(installer.if ?? '').toContain("github.event_name == 'push'");
  });
});
