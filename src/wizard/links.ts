/**
 * Google Cloud console deep links.
 *
 * Client creation cannot be automated, so the wizard's whole job is removal plus
 * deep linking: every screen the user has to touch is one click away, landed in
 * the right project. All of these were checked against the live console and the
 * Google help pages on 28-Jul-2026. Google moves furniture, so re-verify before
 * a release.
 */

/** Base host for every console link. The old console.developers.google.com host still redirects here. */
const CONSOLE = 'https://console.cloud.google.com';

/**
 * The console pages the wizard sends people to, in the order the wizard uses them.
 *
 * Step 3 is /auth/overview and not /auth/branding, and that choice is the one
 * worth writing down because both pages exist and both look plausible. Google's
 * own help for the Auth Platform says the Get started button lives on the
 * overview page: "To create a new application, click on the GET STARTED button
 * on the overview page of the Google Auth Platform". /auth/branding is the page
 * those same fields live on afterwards, once the project has an app at all, so
 * it is the right link for editing and the wrong one for a first setup. PROBE.md
 * points at the same overview page for the same reason.
 */
export const CONSOLE_LINKS = {
  /** Step 1: create the Cloud project. Takes no project parameter, it is making one. */
  projectCreate: `${CONSOLE}/projectcreate`,
  /** Step 2: the Photos Library API card, with its Enable button. */
  enablePhotosApi: `${CONSOLE}/apis/library/photoslibrary.googleapis.com`,
  /** Step 3: Google Auth Platform overview. A project that has never been set up shows Get started here. */
  authOverview: `${CONSOLE}/auth/overview`,
  /** Google Auth Platform, Branding. Where the app name and support email live once the app exists. Not the first-setup link. */
  branding: `${CONSOLE}/auth/branding`,
  /** Step 4: Google Auth Platform, Audience. The Publish app button lives here. */
  audience: `${CONSOLE}/auth/audience`,
  /** Step 5: Google Auth Platform, Create client. Application type: Desktop app. */
  createClient: `${CONSOLE}/auth/clients/create`,
  /** The client list, for re-downloading nothing and checking a client is still alive. */
  clients: `${CONSOLE}/auth/clients`,
  /** Enabled API list, used by doctor when someone doubts step 2 took. */
  apiDashboard: `${CONSOLE}/apis/dashboard`,
} as const;

/** Name of a console page in CONSOLE_LINKS. */
export type ConsoleLinkName = keyof typeof CONSOLE_LINKS;

/**
 * Adds ?project=ID to a console link so it opens against the right project.
 * A blank or missing id gives the plain link back: the console then uses
 * whatever project the user last had selected.
 */
export function withProject(url: string, projectId?: string): string {
  const id = projectId?.trim();
  if (!id) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}project=${encodeURIComponent(id)}`;
}

/** A console link by name, scoped to a project when we know its id. */
export function consoleLink(name: ConsoleLinkName, projectId?: string): string {
  // Creating a project cannot be scoped to a project.
  if (name === 'projectCreate') return CONSOLE_LINKS.projectCreate;
  return withProject(CONSOLE_LINKS[name], projectId);
}

/**
 * Cloud project ids: 6 to 30 characters, lowercase letters, digits and hyphens,
 * starting with a letter and not ending with a hyphen. Used only to keep a typo
 * from silently sending every later link to the wrong place.
 */
const PROJECT_ID_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

/** True when the string looks like a Cloud project id. */
export function isPlausibleProjectId(value: string): boolean {
  return PROJECT_ID_RE.test(value.trim());
}

/**
 * Google refuses app and project names containing "Google", so we catch it here
 * rather than letting the console reject the user two screens later.
 */
export function containsGoogle(value: string): boolean {
  return /google/i.test(value);
}

/** The name the wizard suggests: no "Google" in it, npm-safe, obvious in a consent screen. */
export const SUGGESTED_PROJECT_NAME = 'photo-pigeon-uploads';
