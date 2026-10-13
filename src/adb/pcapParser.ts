import { FileLogger } from '../utils/logger';

const TAG = 'PcapParser';

export interface PacketListener {
  onTelemetryPacket(temp: number, voltage: number, fcVariant: string): void;
  onCompressedOsdPacket(payload: Uint8Array, offset: number, length: number): void;
  onGogglesTelemetryPacket(temp: number, voltage: number): void;
}

const MODE_DETECT = 0;
const MODE_WTFV = 1;
const MODE_PCAP = 2;
const INITIAL_BUFFER_CAPACITY = 65536;

function readUInt16LE(b: Uint8Array, offset: number): number {
  return (b[offset] & 0xff) | ((b[offset + 1] & 0xff) << 8);
}

function readUInt16BE(b: Uint8Array, offset: number): number {
  return ((b[offset] & 0xff) << 8) | (b[offset + 1] & 0xff);
}

function readInt32LE(b: Uint8Array, offset: number): number {
  return (
    (b[offset] & 0xff) |
    ((b[offset + 1] & 0xff) << 8) |
    ((b[offset + 2] & 0xff) << 16) |
    ((b[offset + 3] & 0xff) << 24)
  );
}

export class PcapParser {
  private listener: PacketListener;
  private buffer: Uint8Array = new Uint8Array(INITIAL_BUFFER_CAPACITY);
  private bufferLength = 0;
  private streamMode = MODE_DETECT;
  private headerParsed = false;
  private totalPktCount = 0;
  private lastLogTime = Date.now();
  private lastFc = 'BTFL';

  constructor(listener: PacketListener) {
    this.listener = listener;
  }

  public reset(): void {
    this.bufferLength = 0;
    this.streamMode = MODE_DETECT;
    this.headerParsed = false;
    this.totalPktCount = 0;
    this.lastFc = 'BTFL';
    FileLogger.log(TAG, 'PcapParser reset');
  }

  public feedData(data: Uint8Array, offset: number, length: number): void {
    if (!data || length <= 0) return;

    if (this.bufferLength + length > this.buffer.length) {
      const newCap = Math.max(this.buffer.length * 2, this.bufferLength + length);
      const newBuf = new Uint8Array(newCap);
      newBuf.set(this.buffer.subarray(0, this.bufferLength), 0);
      this.buffer = newBuf;
    }

    this.buffer.set(data.subarray(offset, offset + length), this.bufferLength);
    this.bufferLength += length;

    let pos = 0;

    if (this.streamMode === MODE_DETECT) {
      if (this.bufferLength < 4) return;

      const scanLimit = Math.min(this.bufferLength - 3, 2048);
      for (let i = 0; i < scanLimit; i++) {
        if (
          this.buffer[i] === 0x57 &&
          this.buffer[i + 1] === 0x54 &&
          this.buffer[i + 2] === 0x46 &&
          this.buffer[i + 3] === 0x56
        ) {
          this.streamMode = MODE_WTFV;
          pos = i;
          FileLogger.log(TAG, `Stream detected: WTFV native micro-daemon! Offset: ${i}`);
          break;
        }
        const magicLe = readInt32LE(this.buffer, i) >>> 0;
        if (magicLe === 0xa1b2c3d4 || magicLe === 0xd4c3b2a1 || magicLe === 0xa1b23c4d) {
          this.streamMode = MODE_PCAP;
          pos = i;
          FileLogger.log(TAG, `Stream detected: PCAP (magic: 0x${magicLe.toString(16)})! Offset: ${i}`);
          break;
        }
      }

      if (this.streamMode === MODE_DETECT) {
        if (this.bufferLength > 4096) {
          this.buffer.copyWithin(0, this.bufferLength - 4, this.bufferLength);
          this.bufferLength = 4;
        }
        return;
      }
    }

    if (this.streamMode === MODE_WTFV) {
      while (pos + 8 <= this.bufferLength) {
        if (
          this.buffer[pos] !== 0x57 ||
          this.buffer[pos + 1] !== 0x54 ||
          this.buffer[pos + 2] !== 0x46 ||
          this.buffer[pos + 3] !== 0x56
        ) {
          pos++;
          continue;
        }

        const port = readUInt16LE(this.buffer, pos + 4);
        const payloadLen = readUInt16LE(this.buffer, pos + 6);

        if (payloadLen < 0 || payloadLen > 65535) {
          pos += 4;
          continue;
        }

        if (pos + 8 + payloadLen > this.bufferLength) {
          break;
        }

        const payloadOffset = pos + 8;
        this.totalPktCount++;
        this.dispatchPayload(port, this.buffer, payloadOffset, payloadLen);
        pos = payloadOffset + payloadLen;

        this.logProgress('WTFV');
      }
    } else if (this.streamMode === MODE_PCAP) {
      if (!this.headerParsed) {
        if (pos + 24 > this.bufferLength) return;
        const magic = readInt32LE(this.buffer, pos) >>> 0;
        this.headerParsed = true;
        pos += 24;
        FileLogger.log(TAG, `PCAP global header parsed! Magic: 0x${magic.toString(16)}`);
      }

      while (pos + 16 <= this.bufferLength) {
        const caplen = readInt32LE(this.buffer, pos + 8);
        if (caplen < 0 || caplen > 65535) {
          FileLogger.log(TAG, `PCAP frame out of sync, caplen=${caplen}, resetting buffer`);
          this.headerParsed = false;
          this.streamMode = MODE_DETECT;
          this.bufferLength = 0;
          return;
        }

        if (pos + 16 + caplen > this.bufferLength) {
          break;
        }

        const pktStart = pos + 16;
        this.totalPktCount++;
        this.parsePcapPacket(this.buffer, pktStart, caplen);
        pos = pktStart + caplen;

        this.logProgress('PCAP');
      }
    }

    const remaining = this.bufferLength - pos;
    if (remaining > 0 && pos > 0) {
      this.buffer.copyWithin(0, pos, pos + remaining);
    }
    this.bufferLength = remaining;
  }

  private logProgress(type: string): void {
    const now = Date.now();
    if (now - this.lastLogTime > 10000) {
      FileLogger.log(TAG, `Parsed ${type} packets total: ${this.totalPktCount}`);
      this.lastLogTime = now;
    }
  }

  private parsePcapPacket(data: Uint8Array, offset: number, length: number): void {
    if (length < 16 + 20 + 8) return;

    const ipOffset = offset + 16;
    const ipHeaderLen = (data[ipOffset] & 0x0f) * 4;
    const udpOffset = ipOffset + ipHeaderLen;

    if (udpOffset + 8 > offset + length) return;

    const dstPort = readUInt16BE(data, udpOffset + 2);
    const udpLen = readUInt16BE(data, udpOffset + 4);

    const payloadOffset = udpOffset + 8;
    const payloadLen = udpLen - 8;
    if (payloadOffset + payloadLen > offset + length || payloadLen <= 0) return;

    this.dispatchPayload(dstPort, data, payloadOffset, payloadLen);
  }

  private dispatchPayload(port: number, data: Uint8Array, payloadOffset: number, payloadLen: number): void {
    if (port === 7655) {
      if (payloadLen >= 6) {
        const temp = readUInt16LE(data, payloadOffset);
        const voltRaw = readUInt16LE(data, payloadOffset + 4);
        const voltage = voltRaw / 64.0;

        let fc = this.lastFc;
        if (payloadLen >= 10) {
          const c0 = data[payloadOffset + 6];
          const c1 = data[payloadOffset + 7];
          const c2 = data[payloadOffset + 8];
          const c3 = data[payloadOffset + 9];
          if (c0 > 32 || c1 > 32 || c2 > 32 || c3 > 32) {
            fc = String.fromCharCode(c0, c1, c2, c3).trim();
            this.lastFc = fc;
          }
        }

        this.listener.onTelemetryPacket(temp, voltage, fc);
      }
    } else if (port === 7656) {
      if (payloadLen > 4) {
        this.listener.onCompressedOsdPacket(data, payloadOffset, payloadLen);
      }
    } else if (port === 7650) {
      if (payloadLen >= 4) {
        const mv = readInt32LE(data, payloadOffset);
        let temp = 0;
        if (payloadLen >= 8) {
          temp = readInt32LE(data, payloadOffset + 4);
        }
        if (mv > 0 || temp > 0) {
          this.listener.onGogglesTelemetryPacket(temp, mv / 1000.0);
        }
      }
    }
  }
}
