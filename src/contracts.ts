/**
 * photo-pigeon shared contracts.
 *
 * Every module codes against this file. Read it, never edit it.
 *
 * Two laws are encoded here and must survive every refactor:
 *  1. Upload only, one direction, forever. No shape in this file, and no code
 *     path anywhere in this repo, may delete or mutate media on Google's side.
 *  2. The local sha256 content ledger is the durable record. Content is only
 *     ever visible to the original OAuth client id, so a regenerated client
 *     orphans the history and the ledger is all we have.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Resolved runtime configuration for one photo-pigeon instance: config file plus CLI flags. */
export interface AppConfig {
  /** Absolute paths of the folders being watched, recursively. */
  watchDirs: string[];
  /** Absolute path to the user's OWN OAuth client JSON: this repo ships zero credentials. */
  credentialsPath: string;
  /** Absolute path to the stored refresh token, valid only for the client id that minted it. */
  tokenPath: string;
  /** Absolute path to the sha256 ledger, the durable record of everything delivered. */
  ledgerPath: string;
  /** Lowercase extensions to accept, leading dot included, for example ['.jpg', '.heic', '.mp4']. */
  extensions: string[];
  /** Optional album that new uploads are filed into, created by this app when missing. */
  albumName?: string;
  /** Scan and hash everything, send nothing: no upload, no batchCreate, no ledger write. */
  dryRun?: boolean;
  /** Fall back to interval polling instead of native fs events, for network drives only. */
  pollFallback?: boolean;
}

// ---------------------------------------------------------------------------
// Files and the ledger
// ---------------------------------------------------------------------------

/** A file the watcher has seen settle on disk, offered to the upload queue. */
export interface FileCandidate {
  /** Absolute path on disk at the moment of discovery. */
  path: string;
  /** Size in bytes. */
  size: number;
  /** Last modified time, epoch milliseconds. */
  mtimeMs: number;
}

/** One delivered file, keyed by content hash so moves and renames never re-upload. */
export interface LedgerEntry {
  /** sha256 of the file contents, lowercase hex: the primary key, paths are not identities. */
  hash: string;
  /** Size of the source file on disk, in bytes. */
  size: number;
  /** Bytes actually sent to Google for this entry: what the storage readout sums. */
  bytes: number;
  /** Absolute path this content was first seen at, kept as a breadcrumb only. */
  firstPath: string;
  /** Google Photos media item id, absent if the entry predates a confirmed batchCreate. */
  mediaItemId?: string;
  /** ISO 8601 timestamp of the successful delivery. */
  uploadedAt: string;
}

/** Totals behind the status command: storage honesty is a law, so the tool reports its own footprint. */
export interface LedgerStats {
  /** Number of distinct files delivered by this tool. */
  count: number;
  /** Total bytes this tool has sent, which is what it consumed of the user's Google storage. */
  totalBytes: number;
}

/** The local content-hash record. Lookups are in memory and synchronous, writes reach disk before resolving. */
export interface Ledger {
  /** True when this content hash has already been delivered. */
  has(hash: string): boolean;
  /** The stored entry for a hash, or undefined when the hash is unknown. */
  get(hash: string): LedgerEntry | undefined;
  /** Append an entry and persist it durably before resolving. */
  add(entry: LedgerEntry): Promise<void>;
  /** Count of delivered files and total bytes sent. */
  stats(): LedgerStats;
}

/** Opens and hydrates a ledger from disk, creating an empty one when the file does not exist. */
export type OpenLedger = (ledgerPath: string) => Promise<Ledger>;

// ---------------------------------------------------------------------------
// Upload results
// ---------------------------------------------------------------------------

/** What became of one file on its way to Google. There is no delete status, by law. */
export type UploadStatus = 'uploaded' | 'skipped-duplicate' | 'failed';

/** Per-file result from the queue: one per candidate, success or not. */
export interface UploadOutcome {
  /** Absolute path of the source file. */
  path: string;
  /** sha256 of the file contents, lowercase hex. */
  hash: string;
  /** Outcome of the attempt. */
  status: UploadStatus;
  /** Media item id, present when status is 'uploaded'. */
  mediaItemId?: string;
  /** Human readable failure reason, present when status is 'failed'. */
  error?: string;
  /**
   * True on the one delivery that found the ledger empty. Absent otherwise.
   *
   * This is the whole of "the very first photo ever", and it is core-owned
   * truth because it cannot be worked out anywhere else: the ledger entry is
   * written before the outcome is reported, so anything reading the ledger
   * downstream sees a count of one on the very first delivery of a brand new
   * install and never sees zero again. Sampled immediately before the write,
   * per delivery, so a virgin install taking a twelve file first batch says it
   * once rather than twelve times or not at all.
   */
  firstEver?: boolean;
}

// ---------------------------------------------------------------------------
// Google Photos client
// ---------------------------------------------------------------------------

/** One upload token paired with the name Google should display, ready for batchCreate. */
export interface BatchCreateItem {
  /** Opaque token returned by uploadFile: single use, valid 24 hours. */
  uploadToken: string;
  /** File name shown in Google Photos, normally the basename of the source file. */
  fileName: string;
  /** Optional description attached to the created media item. */
  description?: string;
}

/** Per-item result from batchCreate: the call has no partial success, so every item reports for itself. */
export interface BatchCreateOutcome {
  /** The token this result belongs to, so the failed subset alone can be retried. */
  uploadToken: string;
  /** File name that was submitted with the token. */
  fileName: string;
  /** True when Google created the media item. */
  ok: boolean;
  /** Media item id, present when ok is true. */
  mediaItemId?: string;
  /** Human readable failure reason, present when ok is false. */
  error?: string;
}

/** The Google Photos side of the world: append only, and it can never read the user's existing library. */
export interface GPhotosClient {
  /** Load the user's client, refresh the token or run the loopback consent flow, resolve once authorized. */
  ensureAuth(): Promise<void>;
  /** Upload raw bytes and resolve with the upload token. This does NOT create a media item yet. */
  uploadFile(path: string): Promise<string>;
  /** Create media items from at most 50 tokens, serial per account, one outcome per item, in order. */
  batchCreate(items: BatchCreateItem[], albumId?: string): Promise<BatchCreateOutcome[]>;
  /** Resolve an app-created album by name, creating it when absent, and return its id. */
  ensureAlbum?(name: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// Constants that encode the constraint table. Treat these as law, not defaults.
// ---------------------------------------------------------------------------

/** The only scope this tool ever requests: append only, so reading or deleting is impossible by construction. */
export const OAUTH_SCOPES: readonly string[] = [
  'https://www.googleapis.com/auth/photoslibrary.appendonly',
];

/** Hard limits from the Google Photos Library API, verified 28-Jul-2026. */
export const API_LIMITS = {
  /** batchCreate accepts at most 50 items per call. */
  BATCH_CREATE_MAX_ITEMS: 50,
  /** 429 backoff starts at 30 seconds, not at one second. Exponential with jitter from there. */
  MIN_BACKOFF_MS: 30_000,
  /** An upload token expires 24 hours after it is issued. */
  UPLOAD_TOKEN_TTL_MS: 24 * 60 * 60 * 1000,
  /** A resumable upload session URL expires after 7 days. */
  RESUMABLE_SESSION_TTL_MS: 7 * 24 * 60 * 60 * 1000,
  /** Per Cloud project, per day, shared by uploads and batchCreate. We stay far under it. */
  DAILY_REQUEST_CEILING: 10_000,
  /** Photos above this size are rejected by the API. */
  MAX_PHOTO_BYTES: 200 * 1024 * 1024,
  /** Videos above this size are rejected by the API. */
  MAX_VIDEO_BYTES: 20 * 1024 * 1024 * 1024,
} as const;

/** Milliseconds a file must stop changing before the watcher calls it settled. */
export const WRITE_SETTLE_MS = 2_000;
