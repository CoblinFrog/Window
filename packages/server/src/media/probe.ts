/**
 * Image header probing.
 *
 * The quality gate needs the real pixel dimensions of a source image, because a
 * listing whose best photograph is under 800 px on the short edge is not
 * eligible for the feed. Some sources hand the dimensions over in metadata;
 * many do not. Rather than trust a declared value or — worse — assume one, the
 * bytes are asked directly.
 *
 * Only the header is parsed, so this runs on the first few kilobytes rather
 * than on a decoded bitmap, and it deliberately understands nothing about the
 * pixels themselves.
 */

export interface ImageProbe {
  format: 'jpeg' | 'png' | 'gif' | 'webp' | 'avif';
  width: number;
  height: number;
}

function readUInt32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] as number) << 24) |
    ((bytes[offset + 1] as number) << 16) |
    ((bytes[offset + 2] as number) << 8) |
    (bytes[offset + 3] as number)
  ) >>> 0;
}

function readUInt32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] as number) |
    ((bytes[offset + 1] as number) << 8) |
    ((bytes[offset + 2] as number) << 16) |
    ((bytes[offset + 3] as number) << 24)
  ) >>> 0;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i] as number);
  return out;
}

/** PNG: IHDR is always the first chunk, so width and height sit at a fixed offset. */
function probePng(b: Uint8Array): ImageProbe | null {
  if (b.length < 24) return null;
  if (b[0] !== 0x89 || ascii(b, 1, 3) !== 'PNG') return null;
  return { format: 'png', width: readUInt32BE(b, 16), height: readUInt32BE(b, 20) };
}

function probeGif(b: Uint8Array): ImageProbe | null {
  if (b.length < 10 || ascii(b, 0, 3) !== 'GIF') return null;
  return {
    format: 'gif',
    width: (b[6] as number) | ((b[7] as number) << 8),
    height: (b[8] as number) | ((b[9] as number) << 8),
  };
}

/**
 * JPEG: dimensions live in a start-of-frame marker, which can sit behind any
 * number of variable-length segments, so the marker chain has to be walked.
 */
function probeJpeg(b: Uint8Array): ImageProbe | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;

  let offset = 2;
  while (offset + 9 < b.length) {
    if (b[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = b[offset + 1] as number;

    // Standalone markers carry no length field.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    // Start of scan: the entropy-coded data begins and no SOF will follow.
    if (marker === 0xda) return null;

    const length = ((b[offset + 2] as number) << 8) | (b[offset + 3] as number);
    // SOF0-SOF15, excluding the DHT/JPG/DAC markers interleaved in that range.
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

    if (isStartOfFrame) {
      return {
        format: 'jpeg',
        height: ((b[offset + 5] as number) << 8) | (b[offset + 6] as number),
        width: ((b[offset + 7] as number) << 8) | (b[offset + 8] as number),
      };
    }
    if (length <= 0) return null;
    offset += 2 + length;
  }
  return null;
}

/** WebP has three sub-formats and each stores its size differently. */
function probeWebp(b: Uint8Array): ImageProbe | null {
  if (b.length < 30 || ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WEBP') return null;
  const chunk = ascii(b, 12, 4);

  if (chunk === 'VP8 ') {
    return {
      format: 'webp',
      width: (((b[27] as number) << 8) | (b[26] as number)) & 0x3fff,
      height: (((b[29] as number) << 8) | (b[28] as number)) & 0x3fff,
    };
  }
  if (chunk === 'VP8L') {
    const bits = readUInt32LE(b, 21);
    return {
      format: 'webp',
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }
  if (chunk === 'VP8X') {
    const width =
      1 + ((b[24] as number) | ((b[25] as number) << 8) | ((b[26] as number) << 16));
    const height =
      1 + ((b[27] as number) | ((b[28] as number) << 8) | ((b[29] as number) << 16));
    return { format: 'webp', width, height };
  }
  return null;
}

/**
 * AVIF: an ISOBMFF container. The dimensions are in the `ispe` box, which is
 * nested several levels deep, so the box tree is scanned for it rather than
 * walked properly — `ispe` has a distinctive enough signature that a scan is
 * reliable and a full parser is not worth carrying for one field.
 */
function probeAvif(b: Uint8Array): ImageProbe | null {
  if (b.length < 32 || ascii(b, 4, 4) !== 'ftyp') return null;
  const brand = ascii(b, 8, 4);
  if (brand !== 'avif' && brand !== 'avis' && brand !== 'mif1') return null;

  for (let i = 0; i + 20 < b.length; i++) {
    if (ascii(b, i, 4) === 'ispe') {
      // 4 bytes of version/flags follow the box type, then width and height.
      return { format: 'avif', width: readUInt32BE(b, i + 8), height: readUInt32BE(b, i + 12) };
    }
  }
  return null;
}

/** Returns null when the bytes are not a recognised image. */
export function probeImage(bytes: Uint8Array): ImageProbe | null {
  return (
    probePng(bytes) ??
    probeJpeg(bytes) ??
    probeGif(bytes) ??
    probeWebp(bytes) ??
    probeAvif(bytes)
  );
}

export const CONTENT_TYPES: Record<ImageProbe['format'], string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
};
