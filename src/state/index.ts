/**
 * Local state: content hashing, and the sha256 ledger that makes moves and
 * renames free.
 *
 * Nothing in here talks to the network. It is the tool's memory: what a file's
 * bytes hash to, and what has already been delivered.
 *
 * The config used to live here too, in a second copy nobody called. It has one
 * home now, src/wizard/config.ts, which is where both the wizard and the
 * commands read and write it.
 */

export { hashFile, hashFileWithStats } from './hash.js';
export type { HashedFile } from './hash.js';

export { LedgerError, openLedger } from './ledger.js';
export type { OpenLedgerOptions, WarnFn } from './ledger.js';
