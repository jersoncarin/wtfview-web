import { FileLogger } from '../utils/logger';

const TAG = 'AdbUsbClient';

const A_CNXN = 0x4e584e43;
const A_OPEN = 0x4e45504f;
const A_OKAY = 0x59414b4f;
const A_CLSE = 0x45534c43;
const A_WRTE = 0x45545257;

const A_VERSION = 0x01000000;
const MAX_DATA = 4096;

export interface StreamCallback {
  onData: (data: Uint8Array, offset: number, length: number) => void;
  onClose: () => void;
}

export interface AdbMessage {
  command: number;
  arg0: number;
  arg1: number;
  data: Uint8Array | null;
}

function putInt32LE(b: Uint8Array, offset: number, val: number): void {
  b[offset] = val & 0xff;
  b[offset + 1] = (val >>> 8) & 0xff;
  b[offset + 2] = (val >>> 16) & 0xff;
  b[offset + 3] = (val >>> 24) & 0xff;
}

function readInt32LE(b: Uint8Array, offset: number): number {
  return (
    ((b[offset] & 0xff) |
      ((b[offset + 1] & 0xff) << 8) |
      ((b[offset + 2] & 0xff) << 16) |
      ((b[offset + 3] & 0xff) << 24)) >>>
    0
  );
}

function stringToNullTerminatedBytes(str: string): Uint8Array {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(str);
  const out = new Uint8Array(encoded.length + 1);
  out.set(encoded, 0);
  out[encoded.length] = 0;
  return out;
}

export class AdbWebUsbClient {
  private device: USBDevice;
  private interfaceNumber: number;
  private inEndpointNumber: number;
  private outEndpointNumber: number;
  private running = false;
  private streamRunning = false;
  private deviceDisconnected = false;
  private activeLocalId = 0;
  private activeRemoteId = 0;
  private nextLocalId = 1;
  private pendingReadPromise: Promise<USBInTransferResult> | null = null;
  private streamLoopPromise: Promise<void> | null = null;

  public static async findAndCreate(device: USBDevice): Promise<AdbWebUsbClient | null> {
    if (!device || !device.opened || !device.configuration) return null;

    for (const iface of device.configuration.interfaces) {
      const alt = iface.alternates[0];
      if (!alt) continue;
      if (
        alt.interfaceClass === 0xff &&
        alt.interfaceSubclass === 0x42 &&
        alt.interfaceProtocol === 0x01
      ) {
        try {
          await device.claimInterface(iface.interfaceNumber);
          FileLogger.log(TAG, `Claimed ADB interface ${iface.interfaceNumber}`);
        } catch (err) {
          FileLogger.logError(TAG, `Failed to claim ADB interface ${iface.interfaceNumber}`, err);
          return null;
        }

        let inEp: USBEndpoint | null = null;
        let outEp: USBEndpoint | null = null;
        for (const ep of alt.endpoints) {
          if (ep.direction === 'in') {
            inEp = ep;
          } else if (ep.direction === 'out') {
            outEp = ep;
          }
        }

        if (inEp && outEp) {
          FileLogger.log(
            TAG,
            `Found ADB endpoints: IN=${inEp.endpointNumber}, OUT=${outEp.endpointNumber}`
          );
          return new AdbWebUsbClient(
            device,
            iface.interfaceNumber,
            inEp.endpointNumber,
            outEp.endpointNumber
          );
        }
      }
    }

    FileLogger.log(TAG, 'No ADB interface matching 0xFF/0x42/0x01 found');
    return null;
  }

  constructor(
    device: USBDevice,
    interfaceNumber: number,
    inEndpointNumber: number,
    outEndpointNumber: number
  ) {
    this.device = device;
    this.interfaceNumber = interfaceNumber;
    this.inEndpointNumber = inEndpointNumber;
    this.outEndpointNumber = outEndpointNumber;
  }

  private markDisconnected(): void {
    this.deviceDisconnected = true;
    this.running = false;
    this.streamRunning = false;
    this.pendingReadPromise = null;
  }

  public async connect(): Promise<boolean> {
    if (!this.device.opened) return false;
    FileLogger.log(TAG, 'Sending ADB CNXN handshake...');
    const hostPayload = stringToNullTerminatedBytes('host::wtfview');
    const sent = await this.sendPacket(A_CNXN, A_VERSION, MAX_DATA, hostPayload);
    if (!sent) return false;

    const deadline = Date.now() + 4500;
    while (Date.now() < deadline && !this.deviceDisconnected && this.device.opened) {
      const resp = await this.readPacket(1000);
      if (!resp) continue;

      if (resp.command === A_CNXN) {
        const devInfo = resp.data ? new TextDecoder().decode(resp.data) : '';
        FileLogger.log(TAG, `ADB handshake successful: ${devInfo}`);
        this.running = true;
        return true;
      } else if (resp.command === A_WRTE) {
        FileLogger.log(TAG, `Handling stale WRTE during handshake (remoteId=${resp.arg0})`);
        await this.sendPacket(A_OKAY, resp.arg1, resp.arg0, null);
        await this.sendPacket(A_CLSE, resp.arg1, resp.arg0, null);
      } else {
        FileLogger.log(TAG, `Skipping packet during handshake: cmd=0x${resp.command.toString(16)}`);
      }
    }

    FileLogger.log(TAG, 'ADB handshake timed out');
    return false;
  }

  public async startCommandStream(command: string, callback: StreamCallback): Promise<void> {
    await this.stopStream();
    if (!this.running || this.deviceDisconnected || !this.device.opened) {
      callback.onClose();
      return;
    }
    this.streamRunning = true;

    const runLoop = async () => {
      const localId = this.nextLocalId++;
      if (this.nextLocalId > 0x70000000) this.nextLocalId = 1;
      const serviceCmd =
        command.startsWith('shell:') || command.startsWith('exec:') ? command : `exec:${command}`;
      FileLogger.log(TAG, `Opening ADB stream: ${serviceCmd} (localId=${localId})`);
      const cmdBytes = stringToNullTerminatedBytes(serviceCmd);
      const sent = await this.sendPacket(A_OPEN, localId, 0, cmdBytes);
      if (!sent) {
        callback.onClose();
        return;
      }

      let resp: AdbMessage | null = null;
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline && this.streamRunning && !this.deviceDisconnected) {
        const msg = await this.readPacket(1000);
        if (!msg) continue;
        if (msg.command === A_OKAY && msg.arg1 === localId) {
          resp = msg;
          break;
        } else if (msg.command === A_WRTE) {
          await this.sendPacket(A_OKAY, msg.arg1, msg.arg0, null);
          await this.sendPacket(A_CLSE, msg.arg1, msg.arg0, null);
        } else if (msg.command === A_CLSE) {
          FileLogger.log(TAG, 'Drained stale CLSE while opening stream');
        }
      }

      if (!resp) {
        FileLogger.log(TAG, `Failed to open stream for command: ${serviceCmd}`);
        callback.onClose();
        return;
      }

      const remoteId = resp.arg0;
      this.activeLocalId = localId;
      this.activeRemoteId = remoteId;
      FileLogger.log(TAG, `Opened ADB stream remoteId=${remoteId}, localId=${localId}`);

      let totalBytes = 0;
      let lastLogTime = Date.now();

      while (this.running && this.streamRunning && !this.deviceDisconnected && this.device.opened) {
        const msg = await this.readPacket(500);
        if (!msg) continue;

        if (msg.command === A_WRTE && msg.arg0 === remoteId) {
          const ok = await this.sendPacket(A_OKAY, localId, remoteId, null);
          if (!ok) break;

          if (msg.data && msg.data.length > 0) {
            callback.onData(msg.data, 0, msg.data.length);
            if (totalBytes === 0) {
              FileLogger.log(TAG, `First ADB packet received from goggles! (${msg.data.length} bytes)`);
            }
            totalBytes += msg.data.length;
          }

          if (Date.now() - lastLogTime > 5000) {
            FileLogger.log(TAG, `ADB stream active, received total bytes: ${totalBytes}`);
            lastLogTime = Date.now();
          }
        } else if (msg.command === A_CLSE && msg.arg0 === remoteId) {
          FileLogger.log(TAG, 'Remote closed ADB stream');
          break;
        }
      }

      callback.onClose();
    };

    this.streamLoopPromise = runLoop().catch((err) => {
      FileLogger.logError(TAG, 'ADB stream error', err);
      callback.onClose();
    });
  }

  public async pushFile(remotePath: string, content: Uint8Array, timeoutMs: number): Promise<boolean> {
    if (!this.running || this.deviceDisconnected || !this.device.opened || !content) return false;
    const localId = (Date.now() & 0x7fffffff) || 1;
    const serviceCmd = `exec:cat > ${remotePath}`;
    FileLogger.log(TAG, `pushFile: ${serviceCmd} (${content.length} bytes)`);
    const sent = await this.sendPacket(A_OPEN, localId, 0, stringToNullTerminatedBytes(serviceCmd));
    if (!sent) return false;

    const resp = await this.readPacket(timeoutMs);
    if (!resp || resp.command !== A_OKAY) {
      FileLogger.log(TAG, 'pushFile failed to open remote stream');
      return false;
    }

    const remoteId = resp.arg0;
    let offset = 0;
    while (offset < content.length && !this.deviceDisconnected) {
      const chunkLen = Math.min(content.length - offset, 4096);
      const chunk = content.subarray(offset, offset + chunkLen);
      const ok = await this.sendPacket(A_WRTE, localId, remoteId, chunk);
      if (!ok) break;
      offset += chunkLen;

      const ack = await this.readPacket(timeoutMs);
      if (!ack || ack.command !== A_OKAY) {
        FileLogger.log(TAG, `pushFile write ACK failed at offset ${offset}`);
        break;
      }
    }

    await this.sendPacket(A_CLSE, localId, remoteId, null);
    await this.readPacket(1000);
    return true;
  }

  public async executeCommandGetOutput(command: string, timeoutMs: number): Promise<Uint8Array | null> {
    if (!this.running || this.deviceDisconnected || !this.device.opened) return null;
    const localId = (Date.now() & 0x7fffffff) || 2;
    const serviceCmd =
      command.startsWith('shell:') || command.startsWith('exec:') ? command : `shell:${command}`;
    FileLogger.log(TAG, `executeCommandGetOutput: ${serviceCmd}`);
    const sent = await this.sendPacket(A_OPEN, localId, 0, stringToNullTerminatedBytes(serviceCmd));
    if (!sent) return null;

    let resp: AdbMessage | null = null;
    const openDeadline = Date.now() + timeoutMs;
    while (Date.now() < openDeadline && !this.deviceDisconnected) {
      const msg = await this.readPacket(500);
      if (!msg) continue;
      if (msg.command === A_OKAY && msg.arg1 === localId) {
        resp = msg;
        break;
      } else if (msg.command === A_WRTE) {
        await this.sendPacket(A_OKAY, msg.arg1, msg.arg0, null);
        await this.sendPacket(A_CLSE, msg.arg1, msg.arg0, null);
      }
    }

    if (!resp) {
      FileLogger.log(TAG, `executeCommandGetOutput failed to open: ${serviceCmd}`);
      return null;
    }

    const remoteId = resp.arg0;
    const chunks: Uint8Array[] = [];
    let totalLen = 0;
    let deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline && !this.deviceDisconnected) {
      const msg = await this.readPacket(1000);
      if (!msg) continue;
      if (msg.command === A_WRTE && msg.arg0 === remoteId) {
        if (msg.data && msg.data.length > 0) {
          const copy = new Uint8Array(msg.data.length);
          copy.set(msg.data);
          chunks.push(copy);
          totalLen += copy.length;
        }
        const ok = await this.sendPacket(A_OKAY, localId, remoteId, null);
        if (!ok) break;
        deadline = Date.now() + 3000;
      } else if (msg.command === A_CLSE && msg.arg0 === remoteId) {
        break;
      }
    }

    await this.sendPacket(A_CLSE, localId, remoteId, null);
    const result = new Uint8Array(totalLen);
    let pos = 0;
    for (const c of chunks) {
      result.set(c, pos);
      pos += c.length;
    }
    return result;
  }

  private async sendPacket(
    cmd: number,
    arg0: number,
    arg1: number,
    payload: Uint8Array | null
  ): Promise<boolean> {
    if (this.deviceDisconnected || !this.device.opened) {
      this.markDisconnected();
      return false;
    }

    const len = payload ? payload.length : 0;
    let crc = 0;
    if (payload) {
      for (let i = 0; i < payload.length; i++) {
        crc = (crc + (payload[i] & 0xff)) >>> 0;
      }
    }

    const header = new Uint8Array(24);
    putInt32LE(header, 0, cmd);
    putInt32LE(header, 4, arg0);
    putInt32LE(header, 8, arg1);
    putInt32LE(header, 12, len);
    putInt32LE(header, 16, crc);
    putInt32LE(header, 20, (cmd ^ 0xffffffff) >>> 0);

    try {
      await this.device.transferOut(this.outEndpointNumber, header);
      if (payload && len > 0) {
        await this.device.transferOut(this.outEndpointNumber, new Uint8Array(payload));
      }
      return true;
    } catch {
      this.markDisconnected();
      return false;
    }
  }

  private async transferInWithTimeout(length: number, timeoutMs: number): Promise<Uint8Array | null> {
    if (this.deviceDisconnected || !this.device.opened) {
      this.markDisconnected();
      return null;
    }

    if (!this.pendingReadPromise) {
      this.pendingReadPromise = this.device
        .transferIn(this.inEndpointNumber, length)
        .finally(() => {
          this.pendingReadPromise = null;
        });
    }

    let timerId: number | null = null;
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      timerId = window.setTimeout(() => resolve('timeout'), timeoutMs);
    });

    try {
      const res = await Promise.race([this.pendingReadPromise, timeoutPromise]);
      if (timerId !== null) window.clearTimeout(timerId);
      if (res === 'timeout') {
        return null;
      }
      if (!res || res.status !== 'ok' || !res.data) {
        await new Promise((r) => setTimeout(r, 25));
        return null;
      }
      return new Uint8Array(res.data.buffer, res.data.byteOffset, res.data.byteLength);
    } catch {
      if (timerId !== null) window.clearTimeout(timerId);
      this.markDisconnected();
      return null;
    }
  }

  private async readPacket(timeoutMs: number): Promise<AdbMessage | null> {
    const headerBytes = await this.transferInWithTimeout(512, timeoutMs);
    if (!headerBytes || headerBytes.length < 24) {
      return null;
    }

    const cmd = readInt32LE(headerBytes, 0);
    const arg0 = readInt32LE(headerBytes, 4);
    const arg1 = readInt32LE(headerBytes, 8);
    const len = readInt32LE(headerBytes, 12);
    const magic = readInt32LE(headerBytes, 20);

    if (magic !== ((cmd ^ 0xffffffff) >>> 0)) {
      FileLogger.log(TAG, `ADB packet magic mismatch: cmd=0x${cmd.toString(16)}, magic=0x${magic.toString(16)}`);
      return null;
    }

    let payload: Uint8Array | null = null;
    if (len > 0) {
      payload = new Uint8Array(len);
      let totalRead = 0;
      if (headerBytes.length > 24) {
        const extra = Math.min(len, headerBytes.length - 24);
        payload.set(headerBytes.subarray(24, 24 + extra), 0);
        totalRead += extra;
      }

      while (totalRead < len && !this.deviceDisconnected) {
        const reqSize = Math.max(512, Math.ceil((len - totalRead) / 512) * 512);
        const chunk = await this.transferInWithTimeout(reqSize, 2000);
        if (!chunk || chunk.length === 0) break;
        const copyLen = Math.min(chunk.length, len - totalRead);
        payload.set(chunk.subarray(0, copyLen), totalRead);
        totalRead += copyLen;
      }
    }

    return { command: cmd, arg0, arg1, data: payload };
  }

  public async stopStream(): Promise<void> {
    if (!this.streamRunning && !this.streamLoopPromise) return;
    FileLogger.log(TAG, 'Stopping active ADB command stream');
    this.streamRunning = false;
    if (
      this.activeLocalId !== 0 &&
      this.activeRemoteId !== 0 &&
      !this.deviceDisconnected &&
      this.device.opened
    ) {
      try {
        await Promise.race([
          this.sendPacket(A_CLSE, this.activeLocalId, this.activeRemoteId, null),
          new Promise((r) => setTimeout(r, 150)),
        ]);
      } catch {
        this.activeLocalId = 0;
      }
    }
    this.activeLocalId = 0;
    this.activeRemoteId = 0;

    if (this.streamLoopPromise) {
      await Promise.race([
        this.streamLoopPromise,
        new Promise((r) => setTimeout(r, 200)),
      ]);
      this.streamLoopPromise = null;
    }
  }

  public async stop(): Promise<void> {
    this.running = false;
    this.streamRunning = false;
    this.activeLocalId = 0;
    this.activeRemoteId = 0;
    this.pendingReadPromise = null;
    this.streamLoopPromise = null;

    if (!this.deviceDisconnected && this.device.opened) {
      try {
        await Promise.race([
          this.device.releaseInterface(this.interfaceNumber),
          new Promise((r) => setTimeout(r, 150)),
        ]);
      } catch {
        return;
      }
    }
  }
}
