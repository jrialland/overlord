import { fileTypeFromBuffer } from 'file-type';
import { readFile } from 'fs/promises';

/**
 * Known MIME types that are text-based despite not starting with "text/"
 */
const TEXT_MIME_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'application/xml',
  'application/xhtml+xml',
  'application/javascript',
  'application/typescript',
  'application/x-sh',
  'application/x-yaml',
  'application/graphql',
  'application/toml',
  'application/x-httpd-php',
]);

/**
 * Known MIME types that are definitively binary
 */
const BINARY_MIME_TYPES = new Set([
  'application/pdf',
  'application/zip',
  'application/x-tar',
  'application/gzip',
  'application/x-bzip2',
  'application/x-7z-compressed',
  'application/x-rar-compressed',
  'application/octet-stream',
  'application/wasm',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif',
  'audio/mpeg', 'audio/ogg', 'audio/wav',
  'video/mp4', 'video/webm', 'video/ogg',
  'font/woff', 'font/woff2', 'font/ttf',
]);

/**
 * Heuristic byte analysis on a sample of the buffer.
 * Mimics what Git does internally to detect binary files.
 */
function isBinaryByByteAnalysis(buffer: Buffer) {
  // Sample up to 8KB (same as Git's heuristic)
  const sample = buffer.subarray(0, 8192);

  // Presence of NULL bytes is a strong binary signal
  if (sample.includes(0x00)) return true;

  let nonPrintable = 0;
  for (const byte of sample) {
    // Allow: tab (9), newline (10), carriage return (13), normal ASCII (32–126)
    // Allow: UTF-8 high bytes (128+) — they're valid in UTF-8 encoded text
    if (byte < 8 || (byte >= 14 && byte < 32 && byte !== 27)) {
      nonPrintable++;
    }
  }

  // If >10% of sampled bytes are non-printable control chars → binary
  return nonPrintable / sample.length > 0.10 ;
}

/**
 * Detects whether a file should be treated as text or binary.
 *
 * Strategy:
 * - First, use magic-byte MIME detection (high confidence when available).
 * - Then, fall back to byte-level heuristics for plain text-like files.
 */
export async function detectFileType(filePath:string) {
  const buffer = await readFile(filePath); // accepts a file path too

  // --- Step 1: Magic-byte detection via file-type ---
  const detected = await fileTypeFromBuffer(buffer);

  if (detected) {
    if (BINARY_MIME_TYPES.has(detected.mime)) {
      return { isText: false, confidence: 'high', mimeType: detected.mime, reason: 'magic bytes match known binary type' };
    }
    if (TEXT_MIME_TYPES.has(detected.mime) || detected.mime.startsWith('text/')) {
      return { isText: true, confidence: 'high', mimeType: detected.mime, reason: 'magic bytes match known text type' };
    }
  }

  // --- Step 2: file-type didn't recognise it — use byte heuristic ---
  // (This is the common case for plain .txt, .md, source code, etc.
  //  because they have no magic bytes.)
  const binary = isBinaryByByteAnalysis(buffer);

  return {
    isText: !binary,
    confidence: 'medium',
    mimeType: detected?.mime ?? null,
    reason: binary
      ? 'byte analysis detected non-printable / null bytes'
      : 'no magic bytes found and byte analysis looks clean',
  };
}