import { deflateSync } from 'node:zlib';

/**
 * A minimal PNG encoder.
 *
 * The media pipeline needs to emit real raster bytes at three widths without
 * pulling in a native image codec. PNG is the only format that can be written
 * correctly in a hundred lines against Node's built-in zlib, so it is what the
 * generated pipeline produces. A libvips-backed pipeline implementing the same
 * interface emits AVIF and WebP instead; see `pipeline.ts`.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = (CRC_TABLE[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBytes, Buffer.from(data)]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

export interface RgbImage {
  width: number;
  height: number;
  /** RGB triples, row-major, length = width * height * 3. */
  pixels: Uint8Array;
}

/**
 * Encodes 8-bit RGB as a PNG. Scanlines use the Paeth filter, which predicts
 * well on the smooth gradients this pipeline generates and roughly halves the
 * output against no filtering.
 */
export function encodePng(image: RgbImage): Buffer {
  const { width, height, pixels } = image;
  const bytesPerPixel = 3;
  const stride = width * bytesPerPixel;

  // One extra byte per scanline for the filter type.
  const raw = Buffer.alloc((stride + 1) * height);
  let offset = 0;
  const previous = new Uint8Array(stride);
  const current = new Uint8Array(stride);

  for (let y = 0; y < height; y++) {
    current.set(pixels.subarray(y * stride, y * stride + stride));
    raw[offset++] = 4; // Paeth
    for (let x = 0; x < stride; x++) {
      const a = x >= bytesPerPixel ? (current[x - bytesPerPixel] as number) : 0;
      const b = previous[x] as number;
      const c = x >= bytesPerPixel ? (previous[x - bytesPerPixel] as number) : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      const predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      raw[offset++] = ((current[x] as number) - predictor) & 0xff;
    }
    previous.set(current);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ]);
}
