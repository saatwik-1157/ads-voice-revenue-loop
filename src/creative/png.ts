import { deflateSync } from 'node:zlib';

/**
 * A minimal raster canvas and PNG encoder.
 *
 * Node has no built-in rasterizer and this project has one runtime dependency,
 * which is worth keeping. PNG is simple enough to emit directly: zlib is built
 * in, and the rest is four chunks and a CRC. Text uses an embedded 5x7 bitmap
 * font rather than a real font stack - legible when scaled up, and honest about
 * what it is.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function rgb(hex: string): Rgb {
  const value = hex.replace('#', '');
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

export class Bitmap {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array; // RGB, 3 bytes per pixel

  constructor(width: number, height: number, background: Rgb) {
    this.width = width;
    this.height = height;
    this.pixels = new Uint8Array(width * height * 3);
    this.fillRect(0, 0, width, height, background);
  }

  /** Reads back a pixel, so compositing passes can blend with what is there. */
  get(x: number, y: number): Rgb {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return { r: 0, g: 0, b: 0 };
    const offset = (y * this.width + x) * 3;
    return { r: this.pixels[offset]!, g: this.pixels[offset + 1]!, b: this.pixels[offset + 2]! };
  }

  set(x: number, y: number, color: Rgb): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const offset = (y * this.width + x) * 3;
    this.pixels[offset] = color.r;
    this.pixels[offset + 1] = color.g;
    this.pixels[offset + 2] = color.b;
  }

  fillRect(x: number, y: number, w: number, h: number, color: Rgb): void {
    const x1 = Math.max(0, x);
    const y1 = Math.max(0, y);
    const x2 = Math.min(this.width, x + w);
    const y2 = Math.min(this.height, y + h);
    for (let py = y1; py < y2; py += 1) {
      for (let px = x1; px < x2; px += 1) this.set(px, py, color);
    }
  }

  /** Draw one line of text. Returns the width consumed. */
  drawText(text: string, x: number, y: number, scale: number, color: Rgb): number {
    let cursor = x;
    for (const char of text.toUpperCase()) {
      const glyph = FONT[char] ?? FONT['?']!;
      for (let row = 0; row < GLYPH_HEIGHT; row += 1) {
        const bits = glyph[row]!;
        for (let col = 0; col < GLYPH_WIDTH; col += 1) {
          if (bits[col] !== '#') continue;
          this.fillRect(cursor + col * scale, y + row * scale, scale, scale, color);
        }
      }
      cursor += (GLYPH_WIDTH + 1) * scale;
    }
    return cursor - x;
  }

  toPng(): Buffer {
    return encodePng(this.width, this.height, this.pixels);
  }
}

export const GLYPH_WIDTH = 5;
export const GLYPH_HEIGHT = 7;

/** Advance width of one character at a given scale, including letter spacing. */
export function charAdvance(scale: number): number {
  return (GLYPH_WIDTH + 1) * scale;
}

export function textWidth(text: string, scale: number): number {
  return text.length * charAdvance(scale);
}

/** Greedy word wrap to a pixel width. Long words are broken rather than clipped. */
export function wrapText(text: string, scale: number, maxWidth: number): string[] {
  const maxChars = Math.max(1, Math.floor(maxWidth / charAdvance(scale)));
  const lines: string[] = [];
  let line = '';

  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= maxChars) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    if (word.length <= maxChars) {
      line = word;
      continue;
    }
    let rest = word;
    while (rest.length > maxChars) {
      lines.push(rest.slice(0, maxChars));
      rest = rest.slice(maxChars);
    }
    line = rest;
  }
  if (line) lines.push(line);
  return lines;
}

// --- PNG encoding ---------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function encodePng(width: number, height: number, rgbPixels: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2 = truecolour RGB
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Each scanline is prefixed with its filter byte; 0 means "none", which
  // compresses well enough for the flat colour blocks this draws.
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgbPixels.buffer, rgbPixels.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buffer: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// --- 5x7 bitmap font ------------------------------------------------------

function glyph(...rows: string[]): string[] {
  return rows;
}

export const FONT: Record<string, string[]> = {
  ' ': glyph('.....', '.....', '.....', '.....', '.....', '.....', '.....'),
  A: glyph('.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'),
  B: glyph('####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'),
  C: glyph('.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'),
  D: glyph('####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'),
  E: glyph('#####', '#....', '#....', '####.', '#....', '#....', '#####'),
  F: glyph('#####', '#....', '#....', '####.', '#....', '#....', '#....'),
  G: glyph('.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.###.'),
  H: glyph('#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'),
  I: glyph('#####', '..#..', '..#..', '..#..', '..#..', '..#..', '#####'),
  J: glyph('..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'),
  K: glyph('#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'),
  L: glyph('#....', '#....', '#....', '#....', '#....', '#....', '#####'),
  M: glyph('#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'),
  N: glyph('#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'),
  O: glyph('.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'),
  P: glyph('####.', '#...#', '#...#', '####.', '#....', '#....', '#....'),
  Q: glyph('.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'),
  R: glyph('####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'),
  S: glyph('.####', '#....', '#....', '.###.', '....#', '....#', '####.'),
  T: glyph('#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'),
  U: glyph('#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'),
  V: glyph('#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'),
  W: glyph('#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'),
  X: glyph('#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'),
  Y: glyph('#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'),
  Z: glyph('#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'),
  '0': glyph('.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'),
  '1': glyph('..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'),
  '2': glyph('.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'),
  '3': glyph('#####', '...#.', '..#..', '...#.', '....#', '#...#', '.###.'),
  '4': glyph('...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'),
  '5': glyph('#####', '#....', '####.', '....#', '....#', '#...#', '.###.'),
  '6': glyph('..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'),
  '7': glyph('#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'),
  '8': glyph('.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'),
  '9': glyph('.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'),
  '.': glyph('.....', '.....', '.....', '.....', '.....', '.##..', '.##..'),
  ',': glyph('.....', '.....', '.....', '.....', '.##..', '.##..', '##...'),
  '!': glyph('..#..', '..#..', '..#..', '..#..', '..#..', '.....', '..#..'),
  '?': glyph('.###.', '#...#', '....#', '...#.', '..#..', '.....', '..#..'),
  "'": glyph('..#..', '..#..', '.#...', '.....', '.....', '.....', '.....'),
  '-': glyph('.....', '.....', '.....', '#####', '.....', '.....', '.....'),
  ':': glyph('.....', '.##..', '.##..', '.....', '.##..', '.##..', '.....'),
  ';': glyph('.....', '.##..', '.##..', '.....', '.##..', '.##..', '##...'),
  '/': glyph('....#', '...#.', '...#.', '..#..', '.#...', '.#...', '#....'),
  '&': glyph('.##..', '#..#.', '#.#..', '.#...', '#.#.#', '#..#.', '.##.#'),
  '%': glyph('##..#', '##.#.', '...#.', '..#..', '.#...', '#.##.', '#..##'),
  '(': glyph('...#.', '..#..', '.#...', '.#...', '.#...', '..#..', '...#.'),
  ')': glyph('.#...', '..#..', '...#.', '...#.', '...#.', '..#..', '.#...'),
  '+': glyph('.....', '..#..', '..#..', '#####', '..#..', '..#..', '.....'),
  '"': glyph('.#.#.', '.#.#.', '.....', '.....', '.....', '.....', '.....'),
};
