export const OSD_COLS = 60;
export const OSD_ROWS = 22;
export const GLYPH_W = 32;
export const GLYPH_H = 48;
export const CANVAS_W = 1920;
export const CANVAS_H = 1080;
export const TOP_PAD = 12;
export const UNCOMPRESSED_SIZE = OSD_COLS * OSD_ROWS * 2;

const decompBuffer = new Uint8Array(UNCOMPRESSED_SIZE);

export function decompressWithDict(
  src: Uint8Array,
  srcOffset: number,
  srcLen: number,
  dst: Uint8Array,
  maxDstLen: number,
  dict: Uint8Array
): number {
  let sIdx = srcOffset;
  const sEnd = srcOffset + srcLen;
  let dIdx = 0;
  const dictLen = dict.length;

  while (sIdx < sEnd) {
    const token = src[sIdx++];
    let litLen = token >>> 4;

    if (litLen === 15) {
      let b = 255;
      while (b === 255 && sIdx < sEnd) {
        b = src[sIdx++];
        litLen += b;
      }
    }

    if (sIdx + litLen > sEnd || dIdx + litLen > maxDstLen) {
      return -1;
    }

    for (let i = 0; i < litLen; i++) {
      dst[dIdx++] = src[sIdx++];
    }

    if (sIdx >= sEnd) {
      break;
    }

    if (sIdx + 2 > sEnd) {
      return -2;
    }

    const offset = src[sIdx] | (src[sIdx + 1] << 8);
    sIdx += 2;
    if (offset === 0) {
      return -3;
    }

    let matchLen = token & 0x0f;
    if (matchLen === 15) {
      let b = 255;
      while (b === 255 && sIdx < sEnd) {
        b = src[sIdx++];
        matchLen += b;
      }
    }
    matchLen += 4;

    if (dIdx + matchLen > maxDstLen) {
      return -4;
    }

    const matchPos = dIdx - offset;
    if (matchPos < 0) {
      const dictPos = dictLen + matchPos;
      if (dictPos < 0) {
        return -5;
      }
      const fromDict = Math.min(matchLen, -matchPos);
      for (let i = 0; i < fromDict; i++) {
        dst[dIdx++] = dict[dictPos + i];
      }
      const remaining = matchLen - fromDict;
      for (let i = 0; i < remaining; i++) {
        dst[dIdx++] = dst[i];
      }
    } else {
      for (let i = 0; i < matchLen; i++) {
        dst[dIdx++] = dst[matchPos + i];
      }
    }
  }

  return dIdx;
}

export function renderOsdPacketToBuffer(
  payload: Uint8Array,
  offset: number,
  length: number,
  dictionary: Uint8Array,
  fontPixels: Uint32Array,
  fontW: number,
  fontH: number,
  targetPixels: Uint32Array
): number {
  if (length <= 4) return -2;
  if (fontPixels.length === 0) return -3;

  const compOffset = offset + 4;
  const compLen = length - 4;

  const decompRes = decompressWithDict(
    payload,
    compOffset,
    compLen,
    decompBuffer,
    UNCOMPRESSED_SIZE,
    dictionary
  );

  if (decompRes !== UNCOMPRESSED_SIZE) {
    return decompRes;
  }

  for (let x = 0; x < OSD_COLS; x++) {
    for (let y = 0; y < OSD_ROWS; y++) {
      const byteIdx = (x * OSD_ROWS + y) * 2;
      const c = decompBuffer[byteIdx] | (decompBuffer[byteIdx + 1] << 8);
      const dstX = x * GLYPH_W;
      const dstY = TOP_PAD + y * GLYPH_H;

      if (c === 0) {
        for (let r = 0; r < GLYPH_H; r++) {
          const dstRowOffset = (dstY + r) * CANVAS_W + dstX;
          targetPixels.fill(0, dstRowOffset, dstRowOffset + GLYPH_W);
        }
      } else {
        let page = (c & 0x300) >> 8;
        if (page >= 4) page = 0;
        const charCode = c & 0xff;

        const srcX = page * GLYPH_W;
        const srcY = charCode * GLYPH_H;

        if (srcY + GLYPH_H <= fontH && srcX + GLYPH_W <= fontW) {
          for (let r = 0; r < GLYPH_H; r++) {
            const srcRowOffset = (srcY + r) * fontW + srcX;
            const dstRowOffset = (dstY + r) * CANVAS_W + dstX;
            for (let k = 0; k < GLYPH_W; k++) {
              targetPixels[dstRowOffset + k] = fontPixels[srcRowOffset + k];
            }
          }
        }
      }
    }
  }

  return 0;
}

export function getOsdText(): string {
  const lines: string[] = [];
  for (let y = 0; y < OSD_ROWS; y++) {
    let row = '';
    for (let x = 0; x < OSD_COLS; x++) {
      const byteIdx = (x * OSD_ROWS + y) * 2;
      const c = decompBuffer[byteIdx] | (decompBuffer[byteIdx + 1] << 8);
      const ch = c & 0xff;
      if (ch >= 32 && ch <= 126) {
        row += String.fromCharCode(ch);
      } else {
        row += ' ';
      }
    }
    lines.push(row);
  }
  return lines.join('\n');
}
