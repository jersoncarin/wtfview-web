# WTFView Web

Low-latency WebUSB digital FPV video viewer, HD OSD renderer, and DVR recorder for DJI FPV Goggles built with Vite, React, and TypeScript.

---

## What is WTFView Web?

WTFView Web allows you to connect DJI FPV Goggles directly to a web browser (desktop or Android via Chrome / Edge / Chromium) over USB-C to:
- Stream live 720p 60 FPS digital FPV video with low latency using WebUSB and WebCodecs.
- Render full 1080p HD Betaflight / INAV / ArduPilot / Quicksilver OSD overlays on top of the live feed.
- Record composite 1080p 60 FPS Web DVR video with HD OSD directly from the browser.
- Persist Last Known Flight GPS coordinates for one-click Google Maps drone recovery.

---

## Compatible Goggles

- **DJI FPV Goggles V1**
- **DJI FPV Goggles V2**

### Connection Modes:
1. **Stock Mode (Bulk WebUSB)**: Works on stock firmware. Uses the DJI USB handshake (`RMVT`) on USB Interface 3 to stream live H.264 video.
2. **Rooted / WTF Mode (WebUSB ADB)**: Works on goggles rooted via [fpv.wtf](https://github.com/fpv-wtf/). Enables full HD MSP OSD extraction, custom font syncing, and live Air Unit / Goggles telemetry HUD alongside live video.

---

## How It Works

### 1. Connection & Ingestion
- **DJI Protocol Mode (Stock)**: Claims DJI USB Interface 3 (VID `0x2ca3`, PID `0x001f`) via WebUSB, sends the `RMVT` magic packet, and reads raw H.264 Annex-B video packets over USB bulk endpoints.
- **ADB Stream Mode (Rooted)**: Claims the USB ADB interface (`0xFF/0x42/0x01`), performs the `A_CNXN` handshake, and pushes `wtf_forwarder` to `/tmp/wtf_forwarder` on the goggles. The daemon forwards internal UDP socket traffic:
  - Port `7650`: Goggles voltage & temperature telemetry
  - Port `7655`: Air Unit temperature, voltage & FC variant telemetry
  - Port `7656`: LZ4-compressed MSP DisplayPort OSD canvas stream

  Packets are multiplexed with a `WTFV` header and streamed over ADB stdout via WebUSB to the browser.

### 2. Video Pipeline
- **NAL Demuxing**: Scans incoming byte buffers for H.264 Annex-B NAL units (SPS `7`, PPS `8`, AUD `9`, SEI `6`, IDR `5`, Non-IDR `1`) and assembles complete Access Units.
- **WebCodecs Decoding**: Passes Access Units to the browser's `VideoDecoder` configured with `optimizeForLatency: true` for immediate frame output onto the HTML5 `<canvas>`.
- **Real-Time FPS Counter**: Measures and displays actual rendered video frames per second in the bottom telemetry HUD pill.

### 3. OSD Pipeline
- **LZ4 Dictionary Decompression**: MSP DisplayPort OSD frames from port `7656` are decompressed in TypeScript using the pre-shared 64 KB dictionary (`dictionary_1.bin`).
- **Font Sync & Glyph Rendering**: `FontManager` automatically pulls and caches custom OSD fonts from `/blackbox/fonts` or `/opt/fonts` on the goggles (with fallback to bundled HD fonts for Betaflight, INAV, ArduPilot, Quicksilver, and Ultra) and blits the `60x22` grid of `32x48` glyphs onto a transparent `1920x1080` canvas at 60 FPS.

### 4. Last Known Flight & Drone Recovery
- **Automatic GPS Parsing**: Parses real-time GPS coordinates directly from the decoded OSD character buffer.
- **Persistent Coordinates**: Automatically saves the last valid GPS coordinates and timestamp in `localStorage`.
- **One-Click Google Maps Recovery**: Open the drone's coordinates directly in Google Maps under **Last Known Flight** in Settings.

---

## How to Build & Develop

### Prerequisites
- [Bun](https://bun.sh/) (v1.0+)
- Chromium-based browser with `WebUSB` and `WebCodecs` support (Chrome, Edge, Brave, Opera)

### Commands

```bash
bun install

bun run dev

bun run build

bun run preview
```

Build outputs are generated in `dist/`.

---

## Credits

- **[FPV.WTF](https://github.com/fpv-wtf/)** — Goggles rooting tools, protocols, and original concepts.
- **[DigiView-Android](https://github.com/fpvout/DigiView-Android)** — Reference Android implementation.

---

## License

This project is licensed under the [MIT License](LICENSE).
