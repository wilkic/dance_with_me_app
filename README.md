# Dance With Me — MVP

A phone-based web app: capture your room, step into frame, and see yourself
as a real-time stick figure dancing in your own (person-free) space.

## Run it

```bash
npm install
npm run dev
```

Vite prints a `https://<your-lan-ip>:5173` URL — open that on your phone
(same Wi-Fi). HTTPS is self-signed, so accept the browser warning once;
camera access requires a secure context. The pose model downloads from a
CDN on first load, so the phone needs internet the first time.

## How to use

1. **Start Camera** — grant camera permission.
2. **Capture Room** — prop the phone up facing your dance space, step out
   of frame, tap the button. A 5-second countdown fires, then the app
   averages several frames into a "clean plate" of your empty room.
3. **Dance** — step back in. You're gone from the screen; a stick figure
   dances in your room instead. The HUD shows FPS — and, when connected to
   the dance-analysis server, your motion-derived BPM and song matches.

Controls: **Ghost** toggles between the clean room (user removed) and the
live feed (debugging). **Rescan** recaptures the room. **Flip** switches
front/back camera before capture. The **☰ menu** (top right while dancing)
has guest-dancer options — how many guests (0–3), the delay before each
appears, their opacity — and **Exit** back to the start screen. Guests are
delayed replays of your own moves, drawn behind you at 90% opacity by
default.

## Architecture

```
src/
  camera.js            getUserMedia wrapper, front/back switching
  room/roomModel.js    RoomModel: session-persistent room representation
  pose/
    poseFormat.js      ★ standardized PoseFrame: the app-wide contract
    poseDetector.js    MediaPipe PoseLandmarker behind a swappable interface
    smoothing.js       One Euro filter per joint (low jitter, low lag)
  avatar/
    avatar.js          Avatar interface (render(ctx, poseFrame, viewport, beat))
    stickFigure.js     MVP implementation: glowing stick figure, beat pulse
  net/poseChannel.js   networking seam: publish/subscribe of PoseFrames
  main.js              app state machine + render loop
server/                dance-analysis server (Node, separate package.json)
  index.js             WebSocket ingest of PoseFrames → opinions out
  beatDetector.js      tempo + beats from motion alone (moved from the client)
  matcher.js           tempo-first pairing, half/double-tempo tolerant
  songs.js             stub BPM-labeled catalog for "next song" pairing
  test/synthetic.js    end-to-end: 2 synthetic dancers → profiled + matched
  lab/                 dance lab: BPM calibration + rhythm research tools
    run.js             scenario suite ("dance unit tests") + recording analysis
    synthDancer.js     synthetic dancer with per-body-part oscillators
    signals.js         per-part position/speed channels from PoseFrames
    stft.js            STFT on a BPM grid → waterfall matrices
    report.js          self-contained HTML report (waterfall heatmaps)
```

### Dance-analysis server

Rhythm analysis no longer runs on the phone. The client streams its raw
PoseFrames (the same binary format used everywhere) to the server, which
runs a per-dancer BeatDetector, forms an opinion of each dancer's tempo,
and pairs tempo-compatible dancers by proposing a shared "next song" — the
music does the syncing, not phase alignment. Without a server the app is
fully offline as before (no BPM shown).

```bash
cd server && npm install && npm start   # ws://0.0.0.0:8901
npm run dev                             # in another terminal, as usual
```

Then open the app with `?server=1` appended
(`https://<lan-ip>:5173/?server=1`) — the dev server proxies `/ws` to the
analysis server so the phone reuses the already-accepted HTTPS cert. On a
non-Vite host pass a full URL instead: `?server=wss://host:port`.
`cd server && npm test` runs the synthetic end-to-end check (two fake
dancers at 120/118 BPM must be profiled and matched).

### Dance lab (BPM calibration)

Dancers layer frequencies — hips carry a slow groove, arms flourish on top,
and moving at half tempo (the Nyquist of the song) is idiomatic. The
production detector collapses the body into one speed scalar, so the
fastest limb wins. The lab in `server/lab/` measures this instead of
guessing:

```bash
cd server && npm run lab      # synthetic scenario suite → lab/out/report.html
```

Each scenario is a synthetic dancer with independent per-part oscillators;
checks are PASS/FAIL for required behavior and KNOWN GAP for measured
shortcomings we intend to fix. The report renders STFT waterfall heatmaps
(time × BPM) of the detector's speed scalar and per-part position channels,
with ground truth and the live detector estimate overlaid.

To capture real data, dance to the built-in metronome while the server
records:

```bash
cd server && RECORD_DIR=recordings npm start
# phone: https://<lan-ip>:5173/?server=1&click=100   ← metronome at 100 BPM
cd server && node lab/run.js analyze recordings/<file>.jsonl
```

The `?click=BPM` parameter plays an accented click once dancing starts and
labels the recorded session with the ground-truth BPM, so recorded moves
("dance unit tests" performed by a human) can be checked against what the
detector and the waterfalls saw.

### Design decisions (and how they serve the end-state)

**Room "scanning" = clean plate, not 3D mesh.** Mobile browsers expose no
LiDAR/depth APIs, so a Teleport-style scan isn't possible on the web today.
Instead, the phone is positioned once and a person-free photo of the room
("clean plate") becomes the session's room model. This makes user removal
free and perfect: the live feed is only ever used for pose detection, and
the *plate* is what's rendered — no segmentation artifacts, no ML cost.
`RoomModel.geometry` is reserved so real 3D (WebXR depth on Android Chrome,
or a native wrapper for LiDAR phones) can be added without changing
consumers. Device orientation at capture is already recorded as metadata.

**PoseFrame is the universal currency.** Every pose is a flat
`Float32Array` (33 keypoints × x,y,z,visibility, MediaPipe topology) with a
timestamp, plus binary serialize/deserialize helpers. Avatar rendering,
rhythm analysis, and the network channel all consume this one format, so a
remote dancer's frames are indistinguishable from local ones downstream.

**Avatars are pluggable.** `StickFigureAvatar` implements a tiny `Avatar`
interface that takes a PoseFrame and a canvas. AI-generated dancers or
remote users are new implementations fed from a different PoseFrame source
— the render loop doesn't change. (Rendering is 2D canvas for MVP speed;
the interface doesn't preclude a Three.js-backed avatar later, and
PoseFrames already carry z.)

**Rhythm from motion, no audio.** `BeatDetector` computes a body-size-
normalized motion-energy signal from weighted joint speeds, resamples it to
30 Hz, and autocorrelates a 6 s window to find the dominant period
(50–200 BPM) plus a confidence. Beats are marked at adaptive energy peaks,
which gives beat *phase* — the quantity you'll need to sync dancers across
locations. Verified on synthetic motion: recovers 120 BPM at 0.91
confidence. Real-world caveat: it finds the tempo of *your movement*, which
may lock to half/double the musical tempo depending on the dance.

**Networking is a seam, not a feature.** The render loop already publishes
every local PoseFrame through `PoseChannel` (serialized, network-ready).
The MVP transport is a no-op loopback; multiplayer means writing a
WebRTC/WebSocket transport and rendering subscribed remote frames as
additional avatars — no changes to detection, smoothing, or rendering.

### Performance notes (mobile-first)

- MediaPipe `pose_landmarker_lite` with GPU delegate; 720p capture cap.
- Detection runs only on new video frames (`currentTime` guard).
- One Euro filtering instead of moving averages: smooth when still,
  responsive when fast — the right trade-off for dance.
- 2D canvas compositing (one `drawImage` + stroked lines per frame); no 3D
  engine overhead in the hot loop.

## Phase status

- **Phase 1 (room setup):** done, via clean-plate capture (see caveat above).
- **Phase 2 (pose → stick figure, user removal):** done.
- **Phase 3 (rhythm from motion):** first version done — BPM + beat pulses.
- **Phase 4 (polish/testing):** needs on-device testing across rooms,
  lighting, and phones.
