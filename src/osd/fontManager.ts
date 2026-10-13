import { FileLogger } from '../utils/logger';
import { GLYPH_H, GLYPH_W } from './lz4';

const TAG = 'FontManager';
const NUM_CHARS = 256;
const CACHED_FONT_STORAGE_KEY = 'wtfview_goggles_font_cache_b64';
const CACHED_FONT_NAME_KEY = 'wtfview_goggles_font_name';

export class FontManager {
  private fontPixels: Uint32Array = new Uint32Array(0);
  private fontWidth = 128;
  private fontHeight = 12288;
  private currentFontName = 'default';
  private customCached = false;

  public static hasCachedFont(): boolean {
    try {
      const cached = localStorage.getItem(CACHED_FONT_STORAGE_KEY);
      return cached !== null && cached.length > 1000;
    } catch {
      return false;
    }
  }

  public isCustomCached(): boolean {
    return this.customCached;
  }

  public getFontPixels(): Uint32Array {
    return this.fontPixels;
  }

  public getFontWidth(): number {
    return this.fontWidth;
  }

  public getFontHeight(): number {
    return this.fontHeight;
  }

  public getCurrentFontName(): string {
    return this.currentFontName;
  }

  public async initialize(): Promise<void> {
    if (FontManager.hasCachedFont()) {
      const b64 = localStorage.getItem(CACHED_FONT_STORAGE_KEY);
      const name = localStorage.getItem(CACHED_FONT_NAME_KEY) || 'cached_goggles_font.png';
      if (b64) {
        const ok = await this.loadFontFromDataUrl(`data:image/png;base64,${b64}`, `cached:${name}`);
        if (ok) {
          this.customCached = true;
          FileLogger.log(TAG, `Initialized using cached goggles font: ${name}`);
          return;
        }
      }
    }

    const ok = await this.loadFontFromUrl('/font_btfl.png', 'font_btfl.png');
    if (!ok) {
      await this.loadFontFromUrl('/font_btfl_hd.png', 'font_btfl_hd.png');
    }
  }

  public async loadFontForFc(fc: string): Promise<boolean> {
    if (this.customCached) {
      return true;
    }
    const variant = (fc || 'BTFL').toLowerCase();
    let assetName = 'font_btfl.png';
    if (variant === 'inav') {
      assetName = 'font_inav.png';
    } else if (variant === 'ardu' || variant === 'ardupilot') {
      assetName = 'font_ardu.png';
    } else if (variant === 'quic' || variant === 'quicksilver') {
      assetName = 'font_quic.png';
    } else if (variant === 'ultr') {
      assetName = 'font_ultr.png';
    }

    if (assetName === this.currentFontName) {
      return true;
    }

    let ok = await this.loadFontFromUrl(`/${assetName}`, assetName);
    if (!ok) {
      const hdName = assetName.replace('.png', '_hd.png');
      ok = await this.loadFontFromUrl(`/${hdName}`, hdName);
    }
    return ok;
  }

  public async saveAndApplyFontBytes(data: Uint8Array, fontName: string): Promise<boolean> {
    if (!data || data.length < 1000) return false;
    let binary = '';
    for (let i = 0; i < data.length; i++) {
      binary += String.fromCharCode(data[i]);
    }
    const b64 = btoa(binary);
    const dataUrl = `data:image/png;base64,${b64}`;

    const ok = await this.loadFontFromDataUrl(dataUrl, fontName);
    if (!ok) return false;

    this.customCached = true;
    try {
      localStorage.setItem(CACHED_FONT_STORAGE_KEY, b64);
      localStorage.setItem(CACHED_FONT_NAME_KEY, fontName);
      FileLogger.log(TAG, `Saved font to browser cache: ${fontName} (${data.length} bytes)`);
    } catch (e) {
      FileLogger.logError(TAG, 'Failed to persist font in localStorage', e);
    }
    return true;
  }

  public async loadFontFromUrl(url: string, name: string): Promise<boolean> {
    return this.loadFontFromDataUrl(url, name);
  }

  private loadFontFromDataUrl(srcUrl: string, name: string): Promise<boolean> {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const rawW = img.naturalWidth;
          const rawH = img.naturalHeight;
          const rawGlyphH = Math.floor(rawH / NUM_CHARS);
          const rawGlyphW = rawGlyphH === 54 ? 36 : rawGlyphH === 36 ? 24 : Math.floor(rawW / 4);
          const detectedPages = Math.min(4, Math.max(1, Math.floor(rawW / Math.max(1, rawGlyphW))));

          const targetW = detectedPages * GLYPH_W;
          const targetH = NUM_CHARS * GLYPH_H;

          const canvas = document.createElement('canvas');
          canvas.width = targetW;
          canvas.height = targetH;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            resolve(false);
            return;
          }

          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.clearRect(0, 0, targetW, targetH);
          ctx.drawImage(img, 0, 0, rawW, rawH, 0, 0, targetW, targetH);

          const imgData = ctx.getImageData(0, 0, targetW, targetH);
          this.fontPixels = new Uint32Array(imgData.data.buffer);
          this.fontWidth = targetW;
          this.fontHeight = targetH;
          this.currentFontName = name;

          FileLogger.log(
            TAG,
            `Loaded font ${name} (original ${rawW}x${rawH} -> native 1080p: ${targetW}x${targetH}), pages=${detectedPages}`
          );
          resolve(true);
        } catch (err) {
          FileLogger.logError(TAG, `Failed to process font image ${name}`, err);
          resolve(false);
        }
      };
      img.onerror = () => {
        FileLogger.log(TAG, `Failed to load font image: ${name}`);
        resolve(false);
      };
      img.src = srcUrl;
    });
  }
}
