/** Deterministic, local PNG rendering from the saved boundary and network. @module */
import { deflateSync } from 'node:zlib';
import { AreaFeature, FeatureCollection, Position } from '../models/walkAudit.js';

const SIZE = 384;
function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, 'ascii'), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

/** Draw an aspect-preserving map without a basemap, network call or browser. */
export function renderWalkAuditThumbnail(area: AreaFeature, segments: FeatureCollection): Buffer {
  const ring = area.geometry.coordinates[0];
  const meanLat = ring.reduce((sum, p) => sum + p[1], 0) / ring.length;
  const cosine = Math.max(0.000001, Math.cos(meanLat * Math.PI / 180));
  const xs = ring.map(p => p[0] * cosine), ys = ring.map(p => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const scale = (SIZE - 40) / Math.max(maxX - minX, maxY - minY);
  const offsetX = (SIZE - (maxX - minX) * scale) / 2, offsetY = (SIZE - (maxY - minY) * scale) / 2;
  const map = (p: Position): [number, number] => [Math.round(offsetX + (p[0] * cosine - minX) * scale), Math.round(SIZE - offsetY - (p[1] - minY) * scale)];
  const pixels = Buffer.alloc(SIZE * SIZE * 4);
  for (let i = 0; i < pixels.length; i += 4) { pixels[i] = 247; pixels[i + 1] = 246; pixels[i + 2] = 240; pixels[i + 3] = 255; }
  const draw = (a: Position, b: Position, color: [number, number, number], width: number): void => {
    let [x, y] = map(a); const [x2, y2] = map(b);
    const dx = Math.abs(x2 - x), sx = x < x2 ? 1 : -1, dy = -Math.abs(y2 - y), sy = y < y2 ? 1 : -1;
    let error = dx + dy;
    while (true) {
      for (let yy = y - width; yy <= y + width; yy++) for (let xx = x - width; xx <= x + width; xx++) {
        if (xx < 0 || xx >= SIZE || yy < 0 || yy >= SIZE) continue;
        const at = (yy * SIZE + xx) * 4; pixels[at] = color[0]; pixels[at + 1] = color[1]; pixels[at + 2] = color[2];
      }
      if (x === x2 && y === y2) break;
      const twice = 2 * error;
      if (twice >= dy) { error += dy; x += sx; }
      if (twice <= dx) { error += dx; y += sy; }
    }
  };
  for (const feature of segments.features) if (feature.geometry.type === 'LineString') {
    for (let i = 1; i < feature.geometry.coordinates.length; i++) draw(feature.geometry.coordinates[i - 1], feature.geometry.coordinates[i], [72, 139, 180], 1);
  }
  for (let i = 1; i < ring.length; i++) draw(ring[i - 1], ring[i], [12, 35, 64], 1);
  const scanlines = Buffer.alloc((SIZE * 4 + 1) * SIZE);
  for (let y = 0; y < SIZE; y++) pixels.copy(scanlines, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  const header = Buffer.alloc(13); header.writeUInt32BE(SIZE, 0); header.writeUInt32BE(SIZE, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(scanlines)), chunk('IEND', Buffer.alloc(0))]);
}
