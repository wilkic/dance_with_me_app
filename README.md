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
   dances in your room instead. The HUD shows FPS and, once you move
   rhythmically for a few seconds, your motion-derived BPM.

Controls: **Ghost** toggles between the clean room (user removed) and the
live feed (debugging). **Rescan** recaptures the room. **Flip** switches
front/back camera before capture.

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
  rhythm/beatDetector.js  tempo + beats from motion alone (no audio)
  net/poseChannel.js   networking seam: publish/subscribe of PoseFrames
  main.js              app state machine + render loop
```

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
