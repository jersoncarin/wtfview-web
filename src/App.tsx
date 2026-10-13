import { useCallback, useEffect, useRef, useState } from 'react';
import { AdbWebUsbClient } from './adb/adbWebUsbClient';
import './App.css';
import { parseGpsFromOsdText } from './map/gpsParser';
import { FontManager } from './osd/fontManager';
import { getOsdText } from './osd/lz4';
import { OsdManager } from './osd/osdManager';
import { FileLogger } from './utils/logger';
import { H264WebCodecsPlayer } from './video/h264WebCodecsPlayer';

const TAG = 'MainActivity';
const DJI_VENDOR_ID = 0x2ca3;
const DJI_PRODUCT_ID = 0x001f;
const APP_VERSION = '1.0.4';

const PREF_OSD_ENABLED = 'pref_osd_enabled';
const PREF_AU_HUD_ENABLED = 'pref_au_hud_enabled';
const PREF_STRETCH_ENABLED = 'pref_stretch_enabled';
const PREF_DEBUG_LOG_ENABLED = 'pref_debug_log_enabled';
const PREF_LAST_GPS_LAT = 'pref_last_gps_lat';
const PREF_LAST_GPS_LON = 'pref_last_gps_lon';
const PREF_LAST_GPS_TIME = 'pref_last_gps_time';

function loadBoolPref(key: string, defaultVal: boolean): boolean {
  try {
    const val = localStorage.getItem(key);
    if (val === null) return defaultVal;
    return val === 'true';
  } catch {
    return defaultVal;
  }
}

function saveBoolPref(key: string, val: boolean): void {
  try {
    localStorage.setItem(key, val ? 'true' : 'false');
  } catch {
    return;
  }
}

export function App() {
  const [osdEnabled, setOsdEnabled] = useState<boolean>(() => loadBoolPref(PREF_OSD_ENABLED, true));
  const [auHudEnabled, setAuHudEnabled] = useState<boolean>(() => loadBoolPref(PREF_AU_HUD_ENABLED, true));
  const [stretchEnabled, setStretchEnabled] = useState<boolean>(() => loadBoolPref(PREF_STRETCH_ENABLED, false));
  const [debugLogEnabled, setDebugLogEnabled] = useState<boolean>(() => loadBoolPref(PREF_DEBUG_LOG_ENABLED, false));

  const [isConnected, setIsConnected] = useState(false);
  const [isVideoPlaying, setIsVideoPlaying] = useState(false);
  const [statusMsg, setStatusMsg] = useState('Waiting for DJI Goggles...');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [controlsDimmed, setControlsDimmed] = useState(false);

  const [auTemp, setAuTemp] = useState(0);
  const [auVoltage, setAuVoltage] = useState(0);
  const [glsTemp, setGlsTemp] = useState(0);
  const [glsVoltage, setGlsVoltage] = useState(0);
  const [renderedFps, setRenderedFps] = useState(0);

  const [lastGpsLat, setLastGpsLat] = useState<string | null>(() => localStorage.getItem(PREF_LAST_GPS_LAT));
  const [lastGpsLon, setLastGpsLon] = useState<string | null>(() => localStorage.getItem(PREF_LAST_GPS_LON));
  const [lastGpsTime, setLastGpsTime] = useState<number>(() => {
    const t = localStorage.getItem(PREF_LAST_GPS_TIME);
    return t ? parseInt(t, 10) : 0;
  });

  const [hasCachedFont, setHasCachedFont] = useState<boolean>(() => FontManager.hasCachedFont());
  const [isSyncingFont, setIsSyncingFont] = useState(false);
  const [debugLogs, setDebugLogs] = useState<string[]>([]);

  const [isRecording, setIsRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);

  const fpvCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const osdCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const debugScrollRef = useRef<HTMLDivElement | null>(null);

  const fontManagerRef = useRef<FontManager | null>(null);
  const osdManagerRef = useRef<OsdManager | null>(null);
  const videoPlayerRef = useRef<H264WebCodecsPlayer | null>(null);
  const adbClientRef = useRef<AdbWebUsbClient | null>(null);
  const activeDeviceRef = useRef<USBDevice | null>(null);
  const connectingRef = useRef(false);
  const disconnectingRef = useRef(false);
  const dimTimerRef = useRef<number | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordRafRef = useRef<number | null>(null);
  const recordTimerRef = useRef<number | null>(null);
  const osdEnabledRef = useRef(osdEnabled);

  useEffect(() => {
    osdEnabledRef.current = osdEnabled;
  }, [osdEnabled]);

  const scheduleDimControls = useCallback((delayMs = 3500) => {
    setControlsDimmed(false);
    if (dimTimerRef.current !== null) {
      window.clearTimeout(dimTimerRef.current);
    }
    dimTimerRef.current = window.setTimeout(() => {
      setControlsDimmed(true);
    }, delayMs);
  }, []);

  const startAdbStream = useCallback(async (adbClient: AdbWebUsbClient, osdManager: OsdManager) => {
    const streamCmd =
      'exec:chmod 755 /tmp/wtf_forwarder 2>/dev/null; killall wtf_forwarder wtf_fwd tcpdump 2>/dev/null; nice -n 19 /tmp/wtf_forwarder 2>/dev/null';
    FileLogger.log(TAG, `Starting ADB stream: ${streamCmd}`);
    await adbClient.startCommandStream(streamCmd, {
      onData: (data, offset, length) => {
        osdManager.getPcapParser().feedData(data, offset, length);
      },
      onClose: () => {
        FileLogger.log(TAG, 'OSD stream closed');
      },
    });
  }, []);

  const disconnectDevice = useCallback(async () => {
    if (disconnectingRef.current) return;
    if (!activeDeviceRef.current && !connectingRef.current) return;
    disconnectingRef.current = true;
    FileLogger.log(TAG, 'disconnectDevice called');

    const dev = activeDeviceRef.current;
    const adb = adbClientRef.current;
    const vp = videoPlayerRef.current;

    activeDeviceRef.current = null;
    adbClientRef.current = null;
    connectingRef.current = false;

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        mediaRecorderRef.current.stop();
      } catch {
        mediaRecorderRef.current = null;
      }
    }

    setIsConnected(false);
    setIsVideoPlaying(false);
    setStatusMsg('Waiting for DJI Goggles...');
    setAuTemp(0);
    setAuVoltage(0);
    setGlsTemp(0);
    setGlsVoltage(0);
    setRenderedFps(0);

    if (osdManagerRef.current) {
      osdManagerRef.current.clearCanvas();
    }

    try {
      await Promise.allSettled([
        adb ? adb.stop() : Promise.resolve(),
        vp ? vp.stop() : Promise.resolve(),
      ]);

      if (dev && dev.opened) {
        await Promise.race([
          dev.close(),
          new Promise((r) => setTimeout(r, 150)),
        ]);
      }
    } catch {
      disconnectingRef.current = false;
    } finally {
      disconnectingRef.current = false;
    }
  }, []);

  const connectDevice = useCallback(
    async (device: USBDevice) => {
      if (activeDeviceRef.current || connectingRef.current || disconnectingRef.current) return;
      connectingRef.current = true;

      try {
        FileLogger.log(TAG, `Opening DJI Goggles USB device (${device.productName || 'Goggles'})...`);
        await device.open();
        if (!device.configuration) {
          await device.selectConfiguration(1);
        }

        activeDeviceRef.current = device;
        setIsConnected(true);
        setStatusMsg('DJI Goggles connected! Starting video...');

        if (videoPlayerRef.current) {
          const ok = await videoPlayerRef.current.start(device);
          if (ok) {
            FileLogger.log(TAG, 'Video pipeline started');
          } else {
            FileLogger.logError(TAG, 'Failed to configure video interface 3');
          }
        }

        if (!activeDeviceRef.current || !device.opened) {
          return;
        }

        const adbClient = await AdbWebUsbClient.findAndCreate(device);
        if (adbClient && (await adbClient.connect())) {
          adbClientRef.current = adbClient;
          FileLogger.log(TAG, 'Connected to Goggles ADB!');

          try {
            const resp = await fetch('/wtf_forwarder');
            const bin = new Uint8Array(await resp.arrayBuffer());
            const pushed = await adbClient.pushFile('/tmp/wtf_forwarder', bin, 2500);
            FileLogger.log(TAG, `Pushed wtf_forwarder: ${pushed} (${bin.length} bytes)`);
          } catch (err) {
            FileLogger.log(TAG, `wtf_forwarder push notice: ${String(err)}`);
          }

          if (osdManagerRef.current && activeDeviceRef.current && device.opened) {
            if (!FontManager.hasCachedFont()) {
              FileLogger.log(TAG, 'No cached goggles font found. Pulling from goggles on initialize...');
              const pulled = await osdManagerRef.current.syncGogglesFont(adbClient);
              FileLogger.log(TAG, `Initialize font sync result: ${pulled}`);
              setHasCachedFont(FontManager.hasCachedFont());
            } else {
              FileLogger.log(TAG, 'Goggles font already cached, skipping pull on initialize.');
            }

            osdManagerRef.current.getPcapParser().reset();
            await startAdbStream(adbClient, osdManagerRef.current);
          }
        } else {
          FileLogger.log(TAG, 'ADB handshake failed or interface not found');
        }
      } catch (err) {
        FileLogger.logError(TAG, 'Failed to connect USB device', err);
        setStatusMsg('Failed to open USB device. Ensure no other app is claiming it.');
        activeDeviceRef.current = null;
        setIsConnected(false);
      } finally {
        connectingRef.current = false;
      }
    },
    [startAdbStream]
  );

  const checkPairedDevices = useCallback(async () => {
    if (!navigator.usb || activeDeviceRef.current || connectingRef.current) return;
    try {
      const devices = await navigator.usb.getDevices();
      for (const dev of devices) {
        if (dev.vendorId === DJI_VENDOR_ID && dev.productId === DJI_PRODUCT_ID) {
          await connectDevice(dev);
          return;
        }
      }
    } catch (err) {
      FileLogger.logError(TAG, 'Error scanning WebUSB devices', err);
    }
  }, [connectDevice]);

  const handleRequestUsbDevice = async () => {
    if (!navigator.usb) {
      setStatusMsg('WebUSB is not supported in this browser. Use Chrome or Edge.');
      return;
    }
    try {
      setStatusMsg('Requesting USB permission...');
      const device = await navigator.usb.requestDevice({
        filters: [
          { vendorId: DJI_VENDOR_ID, productId: DJI_PRODUCT_ID },
          { vendorId: DJI_VENDOR_ID },
        ],
      });
      if (device) {
        await connectDevice(device);
      }
    } catch (err) {
      FileLogger.log(TAG, `USB request cancelled or denied: ${String(err)}`);
      setStatusMsg('Waiting for DJI Goggles...');
    }
  };

  useEffect(() => {
    FileLogger.setDebugEnabled(loadBoolPref(PREF_DEBUG_LOG_ENABLED, false));
    const unsub = FileLogger.addListener((_line, allLogs) => {
      setDebugLogs([...allLogs]);
    });

    const fm = new FontManager();
    fontManagerRef.current = fm;
    const om = new OsdManager(fm);
    osdManagerRef.current = om;

    om.setTelemetryListener({
      onTelemetryUpdate: (temp, voltage) => {
        setAuTemp(temp);
        setAuVoltage(voltage);
      },
      onGogglesTelemetryUpdate: (temp, voltage) => {
        setGlsTemp(temp);
        setGlsVoltage(voltage);
      },
    });

    if (osdCanvasRef.current) {
      om.setCanvas(osdCanvasRef.current);
    }

    const vp = new H264WebCodecsPlayer({
      onPlaying: () => {
        setIsVideoPlaying(true);
        scheduleDimControls(2000);
      },
      onFpsCalculated: (fps) => {
        setRenderedFps(fps);
      },
      onDisconnected: () => {
        void disconnectDevice();
      },
    });
    if (fpvCanvasRef.current) {
      vp.setCanvas(fpvCanvasRef.current);
    }
    videoPlayerRef.current = vp;

    void (async () => {
      await fm.initialize();
      setHasCachedFont(FontManager.hasCachedFont());
      await om.initialize();
      await checkPairedDevices();
    })();

    const onUsbConnect = (e: USBConnectionEvent) => {
      FileLogger.log(TAG, 'USB device attached');
      if (
        e.device.vendorId === DJI_VENDOR_ID &&
        (e.device.productId === DJI_PRODUCT_ID || e.device.productId > 0)
      ) {
        setTimeout(() => {
          void connectDevice(e.device);
        }, 300);
      }
    };

    const onUsbDisconnect = (e: USBConnectionEvent) => {
      if (
        activeDeviceRef.current &&
        (e.device === activeDeviceRef.current || e.device.vendorId === DJI_VENDOR_ID)
      ) {
        FileLogger.log(TAG, 'USB device detached');
        void disconnectDevice();
      }
    };

    if (navigator.usb) {
      navigator.usb.addEventListener('connect', onUsbConnect);
      navigator.usb.addEventListener('disconnect', onUsbDisconnect);
    }

    const gpsInterval = window.setInterval(() => {
      if (!activeDeviceRef.current) return;
      const text = getOsdText();
      if (text) {
        const coord = parseGpsFromOsdText(text);
        if (coord) {
          const latStr = coord.latitude.toFixed(7);
          const lonStr = coord.longitude.toFixed(7);
          const now = Date.now();
          setLastGpsLat(latStr);
          setLastGpsLon(lonStr);
          setLastGpsTime(now);
          try {
            localStorage.setItem(PREF_LAST_GPS_LAT, latStr);
            localStorage.setItem(PREF_LAST_GPS_LON, lonStr);
            localStorage.setItem(PREF_LAST_GPS_TIME, String(now));
          } catch {
            return;
          }
        }
      }
    }, 1000);

    return () => {
      unsub();
      window.clearInterval(gpsInterval);
      if (navigator.usb) {
        navigator.usb.removeEventListener('connect', onUsbConnect);
        navigator.usb.removeEventListener('disconnect', onUsbDisconnect);
      }
      void disconnectDevice();
    };
  }, [checkPairedDevices, connectDevice, disconnectDevice, scheduleDimControls]);

  useEffect(() => {
    if (debugLogEnabled && debugScrollRef.current) {
      debugScrollRef.current.scrollTop = debugScrollRef.current.scrollHeight;
    }
  }, [debugLogs, debugLogEnabled]);

  const handleToggleOsd = () => {
    const next = !osdEnabled;
    setOsdEnabled(next);
    saveBoolPref(PREF_OSD_ENABLED, next);
  };

  const handleToggleAuHud = () => {
    const next = !auHudEnabled;
    setAuHudEnabled(next);
    saveBoolPref(PREF_AU_HUD_ENABLED, next);
  };

  const handleToggleStretch = () => {
    const next = !stretchEnabled;
    setStretchEnabled(next);
    saveBoolPref(PREF_STRETCH_ENABLED, next);
  };

  const handleToggleDebugLog = () => {
    const next = !debugLogEnabled;
    setDebugLogEnabled(next);
    saveBoolPref(PREF_DEBUG_LOG_ENABLED, next);
    FileLogger.setDebugEnabled(next);
  };

  const handleSyncFont = async () => {
    if (!isConnected || !adbClientRef.current || !osdManagerRef.current) {
      return;
    }
    setIsSyncingFont(true);
    try {
      await adbClientRef.current.stopStream();
      await osdManagerRef.current.syncGogglesFont(adbClientRef.current);
      setHasCachedFont(FontManager.hasCachedFont());
      await startAdbStream(adbClientRef.current, osdManagerRef.current);
    } finally {
      setIsSyncingFont(false);
    }
  };

  const handleOpenInMaps = () => {
    if (!lastGpsLat || !lastGpsLon) return;
    window.open(
      `https://www.google.com/maps/search/?api=1&query=${lastGpsLat},${lastGpsLon}`,
      '_blank',
      'noopener,noreferrer'
    );
  };

  const handleToggleFullscreen = () => {
    if (!document.fullscreenElement) {
      void document.documentElement.requestFullscreen().catch(() => {});
    } else {
      void document.exitFullscreen().catch(() => {});
    }
  };

  const handleToggleRecord = () => {
    if (isRecording) {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
      return;
    }

    if (!fpvCanvasRef.current) return;

    const recCanvas = document.createElement('canvas');
    recCanvas.width = 1920;
    recCanvas.height = 1080;
    const recCtx = recCanvas.getContext('2d');
    if (!recCtx) return;

    const drawComposite = () => {
      if (fpvCanvasRef.current) {
        recCtx.drawImage(fpvCanvasRef.current, 0, 0, 1920, 1080);
      }
      if (osdEnabledRef.current && osdCanvasRef.current) {
        recCtx.drawImage(osdCanvasRef.current, 0, 0, 1920, 1080);
      }
      recordRafRef.current = requestAnimationFrame(drawComposite);
    };
    drawComposite();

    const stream = recCanvas.captureStream(60);
    const mimeTypes = [
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
      'video/mp4',
    ];
    let selectedMime = '';
    for (const m of mimeTypes) {
      if (MediaRecorder.isTypeSupported(m)) {
        selectedMime = m;
        break;
      }
    }

    const chunks: BlobPart[] = [];
    const recorder = new MediaRecorder(stream, {
      mimeType: selectedMime || undefined,
      videoBitsPerSecond: 16_000_000,
    });

    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) {
        chunks.push(ev.data);
      }
    };

    recorder.onstop = () => {
      if (recordRafRef.current !== null) {
        cancelAnimationFrame(recordRafRef.current);
        recordRafRef.current = null;
      }
      if (recordTimerRef.current !== null) {
        window.clearInterval(recordTimerRef.current);
        recordTimerRef.current = null;
      }
      setIsRecording(false);
      setRecordSeconds(0);

      const blob = new Blob(chunks, { type: selectedMime || 'video/webm' });
      const ext = selectedMime.includes('mp4') ? 'mp4' : 'webm';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const now = new Date();
      const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
      a.href = url;
      a.download = `WTFView_DVR_${stamp}.${ext}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      FileLogger.log(TAG, `Saved DVR recording: ${a.download}`);
    };

    mediaRecorderRef.current = recorder;
    recorder.start(1000);
    setIsRecording(true);
    setRecordSeconds(0);
    recordTimerRef.current = window.setInterval(() => {
      setRecordSeconds((s) => s + 1);
    }, 1000);
    FileLogger.log(TAG, 'Started Web DVR recording (1080p @ 60fps)');
  };

  const formatDuration = (sec: number): string => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  const isStatusGreen = statusMsg.includes('connected') || statusMsg.includes('Starting');

  return (
    <div
      className="main-layout"
      onClick={() => scheduleDimControls(3500)}
      onMouseMove={() => scheduleDimControls(3500)}
    >
      <div className={`viewport-stage ${stretchEnabled ? 'aspect-stretch' : 'aspect-16-9'}`}>
        <canvas ref={fpvCanvasRef} className="fpv-canvas" width={1280} height={720} />
        <canvas
          ref={osdCanvasRef}
          className="osd-canvas"
          width={1920}
          height={1080}
          style={{ display: osdEnabled ? 'block' : 'none' }}
        />
      </div>

      {isConnected && auHudEnabled && (
        <div className="au-hud-pill">
          <span className={`hud-item ${auTemp >= 80 ? 'temp-hot' : ''}`}>
            {auTemp > 0 ? `AU: ${auTemp}°C` : 'AU: --°C'}
          </span>
          <span className="hud-volt">{auVoltage > 0 ? `${auVoltage.toFixed(1)}V` : '--.-V'}</span>
          <span className="hud-divider">|</span>
          <span className={`hud-item ${glsTemp >= 80 ? 'temp-hot' : ''}`}>
            {glsTemp > 0 ? `GLS: ${glsTemp}°C` : 'GLS: --°C'}
          </span>
          <span className="hud-volt">{glsVoltage > 0 ? `${glsVoltage.toFixed(1)}V` : '--.-V'}</span>
          <span className="hud-divider">|</span>
          <span className="hud-fps">{renderedFps > 0 ? `${renderedFps} FPS` : '-- FPS'}</span>
        </div>
      )}

      <div className={`top-right-controls ${controlsDimmed ? 'dimmed' : ''}`}>
        {isConnected && (
          <button
            type="button"
            className={`rec-btn ${isRecording ? 'recording' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              handleToggleRecord();
            }}
            title="Record DVR (Video + OSD)"
          >
            <span className="rec-dot" />
            <span>{isRecording ? formatDuration(recordSeconds) : 'REC'}</span>
          </button>
        )}

        <button
          type="button"
          className="circle-btn"
          onClick={(e) => {
            e.stopPropagation();
            handleToggleFullscreen();
          }}
          title="Fullscreen"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
          </svg>
        </button>

        <button
          type="button"
          className="circle-btn"
          onClick={(e) => {
            e.stopPropagation();
            setSettingsOpen(true);
          }}
          title="Settings"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>

      {!isVideoPlaying && (
        <div className="waiting-card">
          <img src="/app_logo.png" alt="WTFView Logo" className="waiting-logo" />
          <div className="waiting-title">WTFView</div>
          <div className="waiting-status-row">
            <span className={`status-dot ${isStatusGreen ? 'green' : 'amber'}`} />
            <span className="status-text">{statusMsg}</span>
          </div>
          {!isConnected && (
            <button type="button" className="connect-usb-btn" onClick={handleRequestUsbDevice}>
              Connect DJI Goggles
            </button>
          )}
        </div>
      )}

      {debugLogEnabled && (
        <div className="debug-log-container" onClick={(e) => e.stopPropagation()}>
          <div className="debug-log-header">
            <span className="debug-log-title">DEBUG LOG</span>
            <button
              type="button"
              className="debug-clear-btn"
              onClick={() => FileLogger.clearLogs()}
            >
              CLEAR
            </button>
          </div>
          <div ref={debugScrollRef} className="debug-scroll-view">
            {debugLogs.join('\n')}
          </div>
        </div>
      )}

      {settingsOpen && (
        <div className="modal-backdrop" onClick={() => setSettingsOpen(false)}>
          <div className="settings-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="settings-header">
              <span className="settings-title">Settings</span>
              <button
                type="button"
                className="close-btn"
                onClick={() => setSettingsOpen(false)}
                aria-label="Close Settings"
              >
                ✕
              </button>
            </div>

            <div className="settings-divider" />

            <div className="setting-row">
              <span className="setting-label">HD OSD</span>
              <button
                type="button"
                className={`toggle-switch ${osdEnabled ? 'checked' : ''}`}
                onClick={handleToggleOsd}
              >
                <span className="toggle-thumb" />
              </button>
            </div>

            <div className="setting-row">
              <span className="setting-label">Goggles / AU HUD</span>
              <button
                type="button"
                className={`toggle-switch ${auHudEnabled ? 'checked' : ''}`}
                onClick={handleToggleAuHud}
              >
                <span className="toggle-thumb" />
              </button>
            </div>

            <div className="setting-row">
              <span className="setting-label">Stretch Video</span>
              <button
                type="button"
                className={`toggle-switch ${stretchEnabled ? 'checked' : ''}`}
                onClick={handleToggleStretch}
              >
                <span className="toggle-thumb" />
              </button>
            </div>

            <div className="setting-row">
              <span className="setting-label">Debug Log</span>
              <button
                type="button"
                className={`toggle-switch ${debugLogEnabled ? 'checked' : ''}`}
                onClick={handleToggleDebugLog}
              >
                <span className="toggle-thumb" />
              </button>
            </div>

            <div className="gps-card">
              <div className="gps-info">
                <span className="gps-title">Last Known Flight</span>
                <span className="gps-coords">
                  {lastGpsLat && lastGpsLon ? `${lastGpsLat}, ${lastGpsLon}` : 'No GPS data recorded'}
                </span>
                <span className="gps-time">
                  {lastGpsLat && lastGpsLon
                    ? lastGpsTime > 0
                      ? `Recorded: ${new Date(lastGpsTime).toLocaleString()}`
                      : 'Recorded: Available'
                    : 'Last seen: --'}
                </span>
              </div>
              <button
                type="button"
                className="action-btn"
                disabled={!lastGpsLat || !lastGpsLon}
                onClick={handleOpenInMaps}
              >
                Open in Maps
              </button>
            </div>

            <div className="font-sync-row">
              <div className="gps-info">
                <span className="setting-label">Goggles OSD Font</span>
                <span
                  className={`font-status ${
                    isSyncingFont ? 'syncing' : hasCachedFont ? 'cached' : 'bundled'
                  }`}
                >
                  {isSyncingFont
                    ? 'Status: Pulling font from goggles...'
                    : hasCachedFont
                      ? 'Status: Cached Goggles Font'
                      : 'Status: Bundled Default Font'}
                </span>
              </div>
              <button
                type="button"
                className="action-btn"
                disabled={!isConnected || isSyncingFont}
                onClick={() => void handleSyncFont()}
              >
                {isSyncingFont ? 'Syncing...' : 'Sync Font'}
              </button>
            </div>

            <div className="settings-divider" />

            <div className="about-heading">About</div>

            <div className="about-card">
              <img src="/app_logo.png" alt="WTFView Logo" className="about-logo" />
              <div className="gps-info">
                <span className="about-app-name">WTFView</span>
                <span className="about-version">Version {APP_VERSION}</span>
                <span className="about-logo-credit">App logo by FPV.WTF</span>
              </div>
            </div>

            <a
              className="link-block"
              href="https://github.com/jersoncarin"
              target="_blank"
              rel="noopener noreferrer"
            >
              <span className="link-title-bold">Developer: Jerson Carin</span>
              <span className="link-url">github.com/jersoncarin</span>
            </a>

            <div className="credits-subheading">Credits &amp; Special Thanks</div>

            <a
              className="link-block"
              href="https://github.com/fpv-wtf/"
              target="_blank"
              rel="noopener noreferrer"
            >
              <span className="link-title">FPV.WTF (Logo &amp; Projects)</span>
              <span className="link-url">https://github.com/fpv-wtf/</span>
            </a>

            <a
              className="link-block"
              href="https://github.com/fpvout/DigiView-Android"
              target="_blank"
              rel="noopener noreferrer"
            >
              <span className="link-title">DigiView-Android (fpvout)</span>
              <span className="link-url">https://github.com/fpvout/DigiView-Android</span>
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
