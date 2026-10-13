import { AdbWebUsbClient } from '../adb/adbWebUsbClient';
import { type PacketListener, PcapParser } from '../adb/pcapParser';
import { FileLogger } from '../utils/logger';
import { FontManager } from './fontManager';
import { CANVAS_H, CANVAS_W, renderOsdPacketToBuffer } from './lz4';

const TAG = 'OsdManager';

export interface TelemetryListener {
  onTelemetryUpdate: (temp: number, voltage: number, fcVariant: string) => void;
  onGogglesTelemetryUpdate: (temp: number, voltage: number) => void;
}

export class OsdManager implements PacketListener {
  private fontManager: FontManager;
  private pcapParser: PcapParser;
  private lz4Dict: Uint8Array | null = null;
  private currentFc = 'BTFL';
  private hasCustomSyncedFont = false;
  private telemetryListener: TelemetryListener | null = null;
  private osdCtx: CanvasRenderingContext2D | null = null;
  private osdImageData: ImageData | null = null;
  private targetPixels: Uint32Array | null = null;

  private lastTelemLogTime = 0;
  private lastOsdLogTime = 0;
  private totalOsdFrames = 0;

  constructor(fontManager: FontManager) {
    this.fontManager = fontManager;
    this.pcapParser = new PcapParser(this);
  }

  public async initialize(): Promise<void> {
    try {
      const resp = await fetch('/dictionary_1.bin');
      const buf = await resp.arrayBuffer();
      this.lz4Dict = new Uint8Array(buf);
      FileLogger.log(TAG, `Loaded LZ4 dictionary: ${this.lz4Dict.length} bytes`);
    } catch (err) {
      FileLogger.logError(TAG, 'Failed to load dictionary_1.bin', err);
    }
  }

  public setCanvas(canvas: HTMLCanvasElement | null): void {
    if (canvas) {
      canvas.width = CANVAS_W;
      canvas.height = CANVAS_H;
      this.osdCtx = canvas.getContext('2d');
      if (this.osdCtx) {
        this.osdImageData = this.osdCtx.createImageData(CANVAS_W, CANVAS_H);
        this.targetPixels = new Uint32Array(this.osdImageData.data.buffer);
      }
    } else {
      this.osdCtx = null;
      this.osdImageData = null;
      this.targetPixels = null;
    }
  }

  public clearCanvas(): void {
    if (this.targetPixels && this.osdCtx && this.osdImageData) {
      this.targetPixels.fill(0);
      this.osdCtx.putImageData(this.osdImageData, 0, 0);
    }
  }

  public getPcapParser(): PcapParser {
    return this.pcapParser;
  }

  public setTelemetryListener(listener: TelemetryListener): void {
    this.telemetryListener = listener;
  }

  public async syncGogglesFont(adbClient: AdbWebUsbClient | null): Promise<boolean> {
    if (!adbClient) return false;
    FileLogger.log(TAG, 'Syncing OSD font from goggles (/blackbox/fonts, /opt/fonts)...');
    const fc = this.currentFc ? this.currentFc.toLowerCase() : 'btfl';
    const pathsToTry: string[] = [];

    const lsBytes = await adbClient.executeCommandGetOutput(
      'exec:ls -1 /blackbox/fonts/*.png /opt/fonts/*.png /blackbox/*.png 2>/dev/null',
      2500
    );

    if (lsBytes && lsBytes.length > 0) {
      const lsOutput = new TextDecoder().decode(lsBytes).trim();
      FileLogger.log(TAG, `Goggles font files found:\n${lsOutput}`);
      const lines = lsOutput.split('\n');
      for (const l of lines) {
        const path = l.trim();
        if (!path) continue;
        if (path.includes(fc) && path.includes('_hd')) {
          pathsToTry.unshift(path);
        } else {
          pathsToTry.push(path);
        }
      }
    }

    const fallbackPaths = [
      `/blackbox/fonts/font_${fc}_hd.png`,
      '/blackbox/fonts/font_btfl_hd.png',
      '/blackbox/fonts/font_hd.png',
      `/blackbox/fonts/font_${fc}.png`,
      '/blackbox/fonts/font_btfl.png',
      '/blackbox/fonts/font.png',
      `/opt/fonts/font_${fc}_hd.png`,
      '/opt/fonts/font_btfl_hd.png',
      '/opt/fonts/font.png',
    ];

    for (const p of fallbackPaths) {
      if (!pathsToTry.includes(p)) {
        pathsToTry.push(p);
      }
    }

    for (const path of pathsToTry) {
      FileLogger.log(TAG, `Attempting to pull font from goggles: ${path}`);
      const fontBytes = await adbClient.executeCommandGetOutput(`exec:cat ${path} 2>/dev/null`, 4000);
      if (fontBytes && fontBytes.length > 1000) {
        if (
          fontBytes[0] === 0x89 &&
          fontBytes[1] === 0x50 &&
          fontBytes[2] === 0x4e &&
          fontBytes[3] === 0x47
        ) {
          FileLogger.log(TAG, `Downloaded active font from goggles: ${path} (${fontBytes.length} bytes)`);
          const ok = await this.fontManager.saveAndApplyFontBytes(fontBytes, path);
          if (ok) {
            this.hasCustomSyncedFont = true;
            return true;
          }
        } else {
          FileLogger.log(TAG, `File at ${path} is not a valid PNG (${fontBytes.length} bytes)`);
        }
      }
    }

    FileLogger.log(TAG, 'No valid custom font found on goggles');
    return false;
  }

  public onGogglesTelemetryPacket(temp: number, voltage: number): void {
    if (this.telemetryListener) {
      this.telemetryListener.onGogglesTelemetryUpdate(temp, voltage);
    }
  }

  public onTelemetryPacket(temp: number, voltage: number, fcVariant: string): void {
    if (fcVariant && fcVariant !== this.currentFc) {
      this.currentFc = fcVariant;
      if (!this.hasCustomSyncedFont) {
        void this.fontManager.loadFontForFc(this.currentFc);
      }
    }
    const now = Date.now();
    if (now - this.lastTelemLogTime > 5000) {
      FileLogger.log(
        TAG,
        `Telemetry update: temp=${temp}°C, voltage=${voltage.toFixed(2)}V, fc=${this.currentFc}`
      );
      this.lastTelemLogTime = now;
    }
    if (this.telemetryListener) {
      this.telemetryListener.onTelemetryUpdate(temp, voltage, this.currentFc);
    }
  }

  public onCompressedOsdPacket(payload: Uint8Array, offset: number, length: number): void {
    if (!this.lz4Dict || !this.targetPixels || !this.osdCtx || !this.osdImageData) {
      return;
    }
    if (length <= 4) return;

    const res = renderOsdPacketToBuffer(
      payload,
      offset,
      length,
      this.lz4Dict,
      this.fontManager.getFontPixels(),
      this.fontManager.getFontWidth(),
      this.fontManager.getFontHeight(),
      this.targetPixels
    );

    if (res === 0) {
      this.osdCtx.putImageData(this.osdImageData, 0, 0);
      this.totalOsdFrames++;
      const now = Date.now();
      if (this.totalOsdFrames === 1 || now - this.lastOsdLogTime > 4000) {
        FileLogger.log(TAG, `OSD rendered frame #${this.totalOsdFrames} (len=${length})`);
        this.lastOsdLogTime = now;
      }
    }
  }
}
