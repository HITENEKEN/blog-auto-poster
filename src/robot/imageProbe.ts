import * as fs from 'fs';
import * as path from 'path';

/**
 * AI 생성 이미지의 **손상 여부만** 본다 — 적합성(주제에 맞는가)은 사람(승인 카드)이나
 * Judge의 비전 판정이 담당한다(설계 §5-3 이미지 정책). 의존성 추가 없이 PNG/JPEG
 * 헤더만 읽는다.
 */

export const MIN_IMAGE_BYTES = 10 * 1024;
export const MIN_IMAGE_DIMENSION = 256;

export interface ImageProbeResult {
  file: string;
  ok: boolean;
  format: 'png' | 'jpeg' | 'unknown';
  width: number;
  height: number;
  bytes: number;
  reason?: string;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** SOF 마커 — 이 마커들의 세그먼트에 크기가 들어 있다(0xC4/0xC8/0xCC는 제외). */
function isStartOfFrame(marker: number): boolean {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
}

function readPngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null;
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buf.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * JPEG 세그먼트를 순회해 SOF(크기) 마커를 찾는다. 엔트로피 데이터(FF D8 이후 SOS)는
 * 읽지 않고 SOS를 만나면 포기한다 — 크기는 항상 SOS 이전에 나온다.
 */
function readJpegSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4) return null;
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 3 < buf.length) {
    if (buf[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buf[offset + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return null; // SOS/EOI — SOF를 못 찾았다
    const length = buf.readUInt16BE(offset + 2);
    if (length < 2) return null;
    if (isStartOfFrame(marker)) {
      if (offset + 9 > buf.length) return null;
      return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

/** 파일 하나를 검사한다. 파일이 없거나 읽을 수 없으면 ok=false. */
export function probeImageFile(file: string): ImageProbeResult {
  const result: ImageProbeResult = {
    file,
    ok: false,
    format: 'unknown',
    width: 0,
    height: 0,
    bytes: 0,
  };

  let buf: Buffer;
  try {
    result.bytes = fs.statSync(file).size;
    // 헤더 판독에는 앞 64KB면 충분하다(SOF는 항상 앞쪽에 나온다).
    const fd = fs.openSync(file, 'r');
    try {
      const size = Math.min(64 * 1024, result.bytes);
      buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    result.reason = `파일을 읽을 수 없음: ${String(error)}`;
    return result;
  }

  const png = readPngSize(buf);
  const jpeg = png ? null : readJpegSize(buf);
  const size = png ?? jpeg;
  if (!size) {
    result.reason = 'PNG/JPEG 헤더를 해석할 수 없음(손상되었거나 지원하지 않는 형식)';
    return result;
  }

  result.format = png ? 'png' : 'jpeg';
  result.width = size.width;
  result.height = size.height;

  if (result.bytes < MIN_IMAGE_BYTES) {
    result.reason = `파일이 너무 작음 (${result.bytes}B < ${MIN_IMAGE_BYTES}B)`;
    return result;
  }
  if (result.width < MIN_IMAGE_DIMENSION || result.height < MIN_IMAGE_DIMENSION) {
    result.reason = `해상도가 너무 낮음 (${result.width}×${result.height})`;
    return result;
  }

  result.ok = true;
  return result;
}

/** 디렉터리에서 파일명 순으로 검사한다(결정적 순서 — 증거물 비교 가능). */
export function probeImageFiles(files: string[]): ImageProbeResult[] {
  return [...(files || [])].map((file) => probeImageFile(file));
}

/** 사용 가능한 이미지만 남긴다. */
export function pickUsableImages(files: string[]): ImageProbeResult[] {
  return probeImageFiles(files).filter((r) => r.ok);
}

/** 경로 목록의 파일명만 뽑는다(증거 기록용). */
export function imageFileNames(files: string[]): string[] {
  return (files || []).map((f) => path.basename(f));
}
