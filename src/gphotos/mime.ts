/**
 * Extension to media type, plus which size ceiling applies.
 *
 * The uploads endpoint wants an honest X-Goog-Upload-Content-Type, and the two
 * size ceilings differ by an order of magnitude (200 MB for photos, 20 GB for
 * videos), so the kind has to be decided before a single byte goes out.
 */

/** Which of the API's two size ceilings a file falls under. */
export type MediaKind = 'photo' | 'video' | 'unknown';

/** What the transport needs to know about a file before it uploads it. */
export interface MediaType {
  /** Value for the X-Goog-Upload-Content-Type header. */
  mime: string;
  /** Which ceiling applies. Unknown files get the generous one and let Google decide. */
  kind: MediaKind;
}

const PHOTO_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jpe': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.avif': 'image/avif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.ico': 'image/x-icon',
  '.dng': 'image/x-adobe-dng',
  '.cr2': 'image/x-canon-cr2',
  '.cr3': 'image/x-canon-cr3',
  '.nef': 'image/x-nikon-nef',
  '.nrw': 'image/x-nikon-nrw',
  '.arw': 'image/x-sony-arw',
  '.srf': 'image/x-sony-srf',
  '.sr2': 'image/x-sony-sr2',
  '.orf': 'image/x-olympus-orf',
  '.rw2': 'image/x-panasonic-rw2',
  '.raf': 'image/x-fuji-raf',
  '.srw': 'image/x-samsung-srw',
  '.pef': 'image/x-pentax-pef',
  '.raw': 'image/x-panasonic-raw',
};

const VIDEO_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.divx': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.mts': 'video/mp2t',
  '.m2ts': 'video/mp2t',
  '.m2t': 'video/mp2t',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.mpe': 'video/mpeg',
  '.mod': 'video/mpeg',
  '.tod': 'video/mpeg',
  '.wmv': 'video/x-ms-wmv',
  '.mmv': 'video/x-ms-wmv',
  '.asf': 'video/x-ms-asf',
  '.3gp': 'video/3gpp',
  '.3g2': 'video/3gpp2',
  '.flv': 'video/x-flv',
  '.ogv': 'video/ogg',
};

/**
 * Every photo extension the tool recognises, lowercase with a leading dot.
 *
 * These three lists are the single source of truth for which files photo-pigeon
 * is willing to send. The config defaults, the watcher's filter and the size
 * ceiling all read them from here, so a new format is one line in the tables
 * above and nowhere else. Keeping a second copy anywhere is how .tod ends up
 * with a 200 MB ceiling in one file and a 20 GB ceiling in another.
 *
 * Treat them as read only. They are shared, and sorting one in place would
 * reorder it for every other reader. Copy before you sort.
 */
export const PHOTO_EXTENSIONS: string[] = Object.keys(PHOTO_TYPES);

/** Every video extension the tool recognises, lowercase with a leading dot. */
export const VIDEO_EXTENSIONS: string[] = Object.keys(VIDEO_TYPES);

/** Photos and videos together, photos first, in the order the tables declare them. */
export const ALL_SUPPORTED_EXTENSIONS: string[] = [...PHOTO_EXTENSIONS, ...VIDEO_EXTENSIONS];

/** The extension of a path, lowercase and dotted, or an empty string when it has none. */
export function extensionOf(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  if (dot === -1) return '';
  const ext = filePath.slice(dot).toLowerCase();
  // A dot in a folder name is not an extension: C:/holiday.2026/IMG_1 has none.
  return /[\\/]/.test(ext) ? '' : ext;
}

/** Looks a path up by its extension. Case does not matter. */
export function mediaTypeFor(filePath: string): MediaType {
  const ext = extensionOf(filePath);

  const photo = PHOTO_TYPES[ext];
  if (photo) return { mime: photo, kind: 'photo' };

  const video = VIDEO_TYPES[ext];
  if (video) return { mime: video, kind: 'video' };

  return { mime: 'application/octet-stream', kind: 'unknown' };
}

/** Which size ceiling a file falls under, without needing its mime type. */
export function mediaKindFor(filePath: string): MediaKind {
  return mediaTypeFor(filePath).kind;
}

/** Every extension the tool recognises, sorted, for the wizard's default filter list. */
export function knownExtensions(): string[] {
  return [...ALL_SUPPORTED_EXTENSIONS].sort();
}
