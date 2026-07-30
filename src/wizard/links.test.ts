import fsp from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import {
  CONSOLE_LINKS,
  consoleLink,
  containsGoogle,
  isPlausibleProjectId,
  withProject,
} from './links.js';

/** PROBE.md sends people through the same console walk, so it has to agree with this file. */
const PROBE_MD = new URL('../../PROBE.md', import.meta.url);

/** A markdown autolink, which is the form PROBE.md uses for a page it wants opened. */
const autolink = (url: string): string => `<${url}>`;

describe('console deep links', () => {
  it('points at the pages that were verified on 28-Jul-2026', () => {
    expect(CONSOLE_LINKS.projectCreate).toBe('https://console.cloud.google.com/projectcreate');
    expect(CONSOLE_LINKS.enablePhotosApi).toBe(
      'https://console.cloud.google.com/apis/library/photoslibrary.googleapis.com',
    );
    expect(CONSOLE_LINKS.authOverview).toBe('https://console.cloud.google.com/auth/overview');
    expect(CONSOLE_LINKS.branding).toBe('https://console.cloud.google.com/auth/branding');
    expect(CONSOLE_LINKS.audience).toBe('https://console.cloud.google.com/auth/audience');
    expect(CONSOLE_LINKS.createClient).toBe('https://console.cloud.google.com/auth/clients/create');
  });

  it('never links anywhere but Google over https', () => {
    for (const url of Object.values(CONSOLE_LINKS)) {
      expect(url.startsWith('https://console.cloud.google.com/')).toBe(true);
    }
  });
});

/**
 * The consent screen link had two candidates and the wizard and PROBE.md had
 * picked different ones. /auth/overview is the one that carries the Get started
 * button on a project that has never been configured, which is Google's own
 * documented behaviour, so it wins for a first setup. /auth/branding is the
 * page the same fields live on afterwards. This block is the guard against the
 * two files drifting apart again.
 */
describe('the consent screen link, canon in one place', () => {
  it('sends a first setup to the overview page, where Get started lives', () => {
    expect(CONSOLE_LINKS.authOverview).toBe('https://console.cloud.google.com/auth/overview');
  });

  it('PROBE.md walks people to the same page the wizard opens', async () => {
    const probe = await fsp.readFile(PROBE_MD, 'utf8');
    expect(probe).toContain(autolink(CONSOLE_LINKS.authOverview));
    expect(probe).not.toContain(autolink(CONSOLE_LINKS.branding));
  });
});

describe('withProject', () => {
  it('adds the project parameter', () => {
    expect(withProject('https://example.test/page', 'photo-pigeon-4f2c')).toBe(
      'https://example.test/page?project=photo-pigeon-4f2c',
    );
  });

  it('keeps an existing query string intact', () => {
    expect(withProject('https://example.test/page?a=1', 'proj-1')).toBe(
      'https://example.test/page?a=1&project=proj-1',
    );
  });

  it('leaves the url alone when there is no project id', () => {
    expect(withProject('https://example.test/page')).toBe('https://example.test/page');
    expect(withProject('https://example.test/page', '   ')).toBe('https://example.test/page');
  });

  it('escapes anything odd in the id', () => {
    expect(withProject('https://example.test/p', 'a b&c')).toBe('https://example.test/p?project=a%20b%26c');
  });
});

describe('consoleLink', () => {
  it('scopes the auth platform pages to the project', () => {
    expect(consoleLink('audience', 'photo-pigeon-uploads')).toBe(
      'https://console.cloud.google.com/auth/audience?project=photo-pigeon-uploads',
    );
  });

  it('never scopes project creation, there is no project yet', () => {
    expect(consoleLink('projectCreate', 'photo-pigeon-uploads')).toBe(
      'https://console.cloud.google.com/projectcreate',
    );
  });
});

describe('project id sanity', () => {
  it('accepts real looking ids', () => {
    expect(isPlausibleProjectId('photo-pigeon-uploads')).toBe(true);
    expect(isPlausibleProjectId('pigeon-4f2c')).toBe(true);
    expect(isPlausibleProjectId('  pigeon-4f2c  ')).toBe(true);
  });

  it('rejects what the console would reject', () => {
    expect(isPlausibleProjectId('Photo-Pigeon')).toBe(false);
    expect(isPlausibleProjectId('short')).toBe(false);
    expect(isPlausibleProjectId('trailing-')).toBe(false);
    expect(isPlausibleProjectId('9leading')).toBe(false);
    expect(isPlausibleProjectId('has space')).toBe(false);
  });
});

describe('containsGoogle', () => {
  it('catches the word in any case, because Google refuses those names', () => {
    expect(containsGoogle('my google uploader')).toBe(true);
    expect(containsGoogle('GOOGLE photos helper')).toBe(true);
    expect(containsGoogle('photo-pigeon-uploads')).toBe(false);
  });
});
