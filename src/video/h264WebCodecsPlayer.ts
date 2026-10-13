import { FileLogger } from '../utils/logger';

const TAG = 'VideoPlayer';
const MAGIC_RMVT = new Uint8Array([0x52, 0x4d, 0x56, 0x54]);
const START_CODE_4 = new Uint8Array([0x00, 0x00, 0x00, 0x01]);

export interface VideoPlayerCallbacks {
  onPlaying: () => void;
  onFpsCalculated: (fps: number) => void;
  onVideoSizeChanged?: (width: number, height: number) => void;
  onDisconnected?: () => void;
}

function readExpGolomb(data: Uint8Array, bitOffsetRef: { bitOffset: number }): number {
  let leadingZeroBits = 0;
  const maxBits = data.length * 8;
  while (bitOffsetRef.bitOffset < maxBits) {
    const byteIdx = bitOffsetRef.bitOffset >>> 3;
    const bitIdx = 7 - (bitOffsetRef.bitOffset & 7);
    const bit = (data[byteIdx] >>> bitIdx) & 1;
    bitOffsetRef.bitOffset++;
    if (bit === 1) break;
    leadingZeroBits++;
    if (leadingZeroBits > 24) return 0;
  }
  if (leadingZeroBits === 0) return 0;
  let val = 0;
  for (let i = 0; i < leadingZeroBits; i++) {
    if (bitOffsetRef.bitOffset >= maxBits) break;
    const byteIdx = bitOffsetRef.bitOffset >>> 3;
    const bitIdx = 7 - (bitOffsetRef.bitOffset & 7);
    const bit = (data[byteIdx] >>> bitIdx) & 1;
    bitOffsetRef.bitOffset++;
    val = (val << 1) | bit;
  }
  return (1 << leadingZeroBits) - 1 + val;
}

function isIntraSlice(nal: Uint8Array): boolean {
  if (nal.length < 2) return false;
  const ref = { bitOffset: 8 };
  readExpGolomb(nal, ref);
  const sliceType = readExpGolomb(nal, ref);
  return sliceType === 2 || sliceType === 7 || sliceType === 4 || sliceType === 9;
}

function wrapAnnexB(nal: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + nal.length);
  out.set(START_CODE_4, 0);
  out.set(nal, 4);
  return out;
}

export class H264WebCodecsPlayer {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private callbacks: VideoPlayerCallbacks;

  private device: USBDevice | null = null;
  private inEndpointNumber = 0;
  private outEndpointNumber = 0;
  private running = false;

  private decoder: VideoDecoder | null = null;
  private decoderConfigured = false;
  private sentFirstKeyframe = false;
  private preferSoftware = false;

  private latestSps: Uint8Array | null = null;
  private latestPps: Uint8Array | null = null;
  private codecString = 'avc1.640028';

  private streamBuffer = new Uint8Array(262144);
  private streamBufferLen = 0;

  private currentAuNals: Uint8Array[] = [];
  private currentAuHasVcl = false;
  private currentAuIsKey = false;
  private currentAuHasSpsPps = false;
  private timestampUs = 0;

  private frameCount = 0;
  private totalDecodedFrames = 0;
  private lastFpsCalcTimeMs = 0;
  private lastFrameRenderTimeMs = 0;
  private fpsTimerId: number | null = null;

  constructor(callbacks: VideoPlayerCallbacks) {
    this.callbacks = callbacks;
  }

  public setCanvas(canvas: HTMLCanvasElement | null): void {
    this.canvas = canvas;
    this.ctx = canvas ? canvas.getContext('2d') : null;
  }

  public clearCanvas(): void {
    if (this.canvas && this.ctx) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  public async start(device: USBDevice): Promise<boolean> {
    if (!device || !device.opened || !device.configuration) return false;

    const videoIface = device.configuration.interfaces.find((i) => i.interfaceNumber === 3);
    if (!videoIface) {
      FileLogger.logError(TAG, 'Device does not have interface 3');
      return false;
    }

    try {
      await device.claimInterface(3);
    } catch (err) {
      FileLogger.logError(TAG, 'Failed to claim interface 3', err);
      return false;
    }

    const alt = videoIface.alternates[0];
    let inEp: USBEndpoint | null = null;
    let outEp: USBEndpoint | null = null;
    for (const ep of alt.endpoints) {
      if (ep.direction === 'in') inEp = ep;
      else if (ep.direction === 'out') outEp = ep;
    }

    if (!inEp || !outEp) {
      FileLogger.logError(TAG, 'Failed to find IN/OUT endpoints on interface 3');
      return false;
    }

    this.device = device;
    this.inEndpointNumber = inEp.endpointNumber;
    this.outEndpointNumber = outEp.endpointNumber;
    this.running = true;

    this.resetParserState();
    this.initDecoder();

    try {
      await device.transferOut(this.outEndpointNumber, MAGIC_RMVT);
      FileLogger.log(TAG, 'Interface 3 claimed and RMVT sent successfully!');
    } catch (err) {
      FileLogger.logError(TAG, 'Failed to send RMVT magic packet', err);
    }

    this.lastFpsCalcTimeMs = performance.now();
    this.lastFrameRenderTimeMs = performance.now();
    if (this.fpsTimerId !== null) {
      window.clearInterval(this.fpsTimerId);
    }
    this.fpsTimerId = window.setInterval(() => {
      if (performance.now() - this.lastFrameRenderTimeMs > 1500) {
        this.callbacks.onFpsCalculated(0);
      }
    }, 1000);

    void this.readLoop();
    return true;
  }

  private resetParserState(): void {
    this.streamBufferLen = 0;
    this.currentAuNals = [];
    this.currentAuHasVcl = false;
    this.currentAuIsKey = false;
    this.currentAuHasSpsPps = false;
    this.decoderConfigured = false;
    this.sentFirstKeyframe = false;
    this.frameCount = 0;
    this.totalDecodedFrames = 0;
  }

  private initDecoder(): void {
    if (this.decoder) {
      try {
        if (this.decoder.state !== 'closed') {
          this.decoder.close();
        }
      } catch {
        this.decoder = null;
      }
    }

    if (typeof VideoDecoder === 'undefined') {
      FileLogger.logError(TAG, 'WebCodecs VideoDecoder API is not available in this browser');
      return;
    }

    this.decoder = new VideoDecoder({
      output: (frame: VideoFrame) => {
        if (!this.running) {
          frame.close();
          return;
        }
        this.handleDecodedFrame(frame);
      },
      error: (err: DOMException) => {
        if (!this.running) return;
        FileLogger.logError(TAG, 'VideoDecoder error, resetting decoder', err);
        this.preferSoftware = true;
        this.decoderConfigured = false;
        this.sentFirstKeyframe = false;
        setTimeout(() => {
          if (this.running) {
            this.initDecoder();
          }
        }, 100);
      },
    });
  }

  private configureDecoderIfNeeded(): boolean {
    if (this.decoderConfigured && this.decoder && this.decoder.state === 'configured') {
      return true;
    }
    if (!this.latestSps || !this.latestPps) {
      return false;
    }
    if (!this.decoder || this.decoder.state === 'closed') {
      this.initDecoder();
    }
    if (!this.decoder) return false;

    try {
      this.decoder.configure({
        codec: this.codecString,
        optimizeForLatency: true,
        hardwareAcceleration: this.preferSoftware ? 'prefer-software' : 'no-preference',
      });
      this.decoderConfigured = true;
      this.sentFirstKeyframe = false;
      FileLogger.log(
        TAG,
        `Configured VideoDecoder with codec=${this.codecString} (sw=${this.preferSoftware})`
      );
      return true;
    } catch (err) {
      FileLogger.logError(TAG, `Failed to configure codec ${this.codecString}, falling back to avc1.640028`, err);
      try {
        this.decoder.configure({
          codec: 'avc1.640028',
          optimizeForLatency: true,
          hardwareAcceleration: 'prefer-software',
        });
        this.decoderConfigured = true;
        this.sentFirstKeyframe = false;
        return true;
      } catch (err2) {
        FileLogger.logError(TAG, 'Fallback decoder configure failed', err2);
        return false;
      }
    }
  }

  private handleDecodedFrame(frame: VideoFrame): void {
    try {
      const w = frame.displayWidth || frame.codedWidth;
      const h = frame.displayHeight || frame.codedHeight;

      if (this.canvas && this.ctx && w > 0 && h > 0) {
        if (this.canvas.width !== w || this.canvas.height !== h) {
          this.canvas.width = w;
          this.canvas.height = h;
          if (this.callbacks.onVideoSizeChanged) {
            this.callbacks.onVideoSizeChanged(w, h);
          }
        }
        this.ctx.drawImage(frame, 0, 0, w, h);
      }

      if (this.totalDecodedFrames === 0) {
        FileLogger.log(TAG, `Rendered first video frame! (${w}x${h})`);
        this.callbacks.onPlaying();
      }
      this.totalDecodedFrames++;

      const now = performance.now();
      this.lastFrameRenderTimeMs = now;
      this.frameCount++;
      if (now - this.lastFpsCalcTimeMs >= 1000) {
        const fps = Math.round((this.frameCount * 1000) / (now - this.lastFpsCalcTimeMs));
        this.frameCount = 0;
        this.lastFpsCalcTimeMs = now;
        this.callbacks.onFpsCalculated(fps);
      }
    } finally {
      frame.close();
    }
  }

  private async readLoop(): Promise<void> {
    let totalBytes = 0;
    let lastLogTime = Date.now();
    let consecutiveErrors = 0;

    while (this.running && this.device && this.device.opened) {
      try {
        const res = await this.device.transferIn(this.inEndpointNumber, 32768);
        if (!this.running) break;

        if (res.status === 'ok' && res.data && res.data.byteLength > 0) {
          consecutiveErrors = 0;
          const chunk = new Uint8Array(res.data.buffer, res.data.byteOffset, res.data.byteLength);
          totalBytes += chunk.length;
          this.feedH264Bytes(chunk);

          const now = Date.now();
          if (now - lastLogTime > 10000) {
            FileLogger.log(
              TAG,
              `Video I/O: totalBytes=${(totalBytes / (1024 * 1024)).toFixed(2)} MB, decodedFrames=${this.totalDecodedFrames}`
            );
            lastLogTime = now;
          }
        } else {
          await new Promise((r) => setTimeout(r, 10));
        }
      } catch (err) {
        if (!this.running) break;
        consecutiveErrors++;
        const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
        if (
          !this.device ||
          !this.device.opened ||
          msg.includes('disconnect') ||
          msg.includes('no device') ||
          msg.includes('not found') ||
          msg.includes('transfer error') ||
          consecutiveErrors >= 3
        ) {
          FileLogger.log(TAG, 'USB video stream disconnected');
          this.running = false;
          if (this.callbacks.onDisconnected) {
            this.callbacks.onDisconnected();
          }
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }

  private feedH264Bytes(chunk: Uint8Array): void {
    if (this.streamBufferLen + chunk.length > this.streamBuffer.length) {
      const nextCap = Math.max(this.streamBuffer.length * 2, this.streamBufferLen + chunk.length);
      const nextBuf = new Uint8Array(nextCap);
      nextBuf.set(this.streamBuffer.subarray(0, this.streamBufferLen), 0);
      this.streamBuffer = nextBuf;
    }
    this.streamBuffer.set(chunk, this.streamBufferLen);
    this.streamBufferLen += chunk.length;

    const buf = this.streamBuffer;
    const len = this.streamBufferLen;

    let nalStart = -1;
    let i = 0;

    while (i < len - 3) {
      let startCodeLen = 0;
      if (buf[i] === 0 && buf[i + 1] === 0) {
        if (buf[i + 2] === 1) {
          startCodeLen = 3;
        } else if (i + 3 < len && buf[i + 2] === 0 && buf[i + 3] === 1) {
          startCodeLen = 4;
        }
      }

      if (startCodeLen > 0) {
        if (nalStart >= 0 && i > nalStart) {
          const nal = buf.subarray(nalStart, i);
          this.onNalUnit(nal);
        }
        nalStart = i + startCodeLen;
        i = nalStart;
      } else {
        i++;
      }
    }

    if (nalStart > 0) {
      const keepFrom = Math.max(0, nalStart - 4);
      const remaining = len - keepFrom;
      if (remaining > 0 && keepFrom > 0) {
        this.streamBuffer.copyWithin(0, keepFrom, len);
      }
      this.streamBufferLen = remaining;
    } else if (len > 524288) {
      this.streamBuffer.copyWithin(0, len - 4, len);
      this.streamBufferLen = 4;
    }
  }

  private onNalUnit(nal: Uint8Array): void {
    if (!this.running || nal.length === 0) return;
    const nalType = nal[0] & 0x1f;

    if (nalType === 7) {
      if (this.currentAuHasVcl) {
        this.flushAccessUnit();
      }
      this.latestSps = wrapAnnexB(nal);
      if (nal.length >= 4) {
        const p = nal[1].toString(16).padStart(2, '0');
        const c = nal[2].toString(16).padStart(2, '0');
        const l = nal[3].toString(16).padStart(2, '0');
        this.codecString = `avc1.${p}${c}${l}`;
      }
      this.currentAuHasSpsPps = true;
      return;
    }

    if (nalType === 8) {
      if (this.currentAuHasVcl) {
        this.flushAccessUnit();
      }
      this.latestPps = wrapAnnexB(nal);
      this.currentAuHasSpsPps = true;
      return;
    }

    if (nalType === 9 || nalType === 6) {
      if (this.currentAuHasVcl) {
        this.flushAccessUnit();
      }
      this.currentAuNals.push(wrapAnnexB(nal));
      return;
    }

    if (nalType === 5 || nalType === 1) {
      const firstMbZero = nal.length > 1 && (nal[1] & 0x80) !== 0;
      if (this.currentAuHasVcl && firstMbZero) {
        this.flushAccessUnit();
      }

      this.currentAuNals.push(wrapAnnexB(nal));
      this.currentAuHasVcl = true;
      if (nalType === 5 || this.currentAuHasSpsPps || isIntraSlice(nal)) {
        this.currentAuIsKey = true;
      }
    }
  }

  private flushAccessUnit(): void {
    if (!this.running || !this.currentAuHasVcl || this.currentAuNals.length === 0) {
      this.currentAuNals = [];
      this.currentAuHasVcl = false;
      this.currentAuIsKey = false;
      this.currentAuHasSpsPps = false;
      return;
    }

    if (!this.configureDecoderIfNeeded()) {
      this.currentAuNals = [];
      this.currentAuHasVcl = false;
      this.currentAuIsKey = false;
      this.currentAuHasSpsPps = false;
      return;
    }

    const isKey = this.currentAuIsKey;
    if (!this.sentFirstKeyframe && !isKey) {
      this.currentAuNals = [];
      this.currentAuHasVcl = false;
      this.currentAuIsKey = false;
      this.currentAuHasSpsPps = false;
      return;
    }

    const parts: Uint8Array[] = [];
    if (isKey && this.latestSps && this.latestPps) {
      parts.push(this.latestSps);
      parts.push(this.latestPps);
    }
    for (const p of this.currentAuNals) {
      parts.push(p);
    }

    let totalLen = 0;
    for (const p of parts) totalLen += p.length;
    const payload = new Uint8Array(totalLen);
    let offset = 0;
    for (const p of parts) {
      payload.set(p, offset);
      offset += p.length;
    }

    this.currentAuNals = [];
    this.currentAuHasVcl = false;
    this.currentAuIsKey = false;
    this.currentAuHasSpsPps = false;

    if (this.decoder && this.decoder.state === 'configured') {
      if (this.decoder.decodeQueueSize > 8 && !isKey) {
        return;
      }
      try {
        const chunk = new EncodedVideoChunk({
          type: isKey ? 'key' : 'delta',
          timestamp: this.timestampUs,
          data: payload,
        });
        this.timestampUs += 16667;
        this.decoder.decode(chunk);
        if (isKey) {
          this.sentFirstKeyframe = true;
        }
      } catch (err) {
        FileLogger.logError(TAG, 'Decode chunk error', err);
        this.sentFirstKeyframe = false;
      }
    }
  }

  public async stop(): Promise<void> {
    this.running = false;
    if (this.fpsTimerId !== null) {
      window.clearInterval(this.fpsTimerId);
      this.fpsTimerId = null;
    }
    this.callbacks.onFpsCalculated(0);

    if (this.decoder) {
      try {
        if (this.decoder.state !== 'closed') {
          this.decoder.close();
        }
      } catch {
        this.decoder = null;
      }
      this.decoder = null;
    }

    this.clearCanvas();

    const dev = this.device;
    this.device = null;
    if (dev && dev.opened) {
      try {
        await Promise.race([
          dev.releaseInterface(3),
          new Promise((r) => setTimeout(r, 150)),
        ]);
      } catch {
        return;
      }
    }
  }
}
