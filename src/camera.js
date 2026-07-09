/**
 * Camera handling: getUserMedia with mobile-friendly constraints and
 * front/back switching.
 */
export class Camera {
  constructor(videoEl) {
    this.video = videoEl;
    this.stream = null;
    this.facingMode = 'environment'; // back camera by default (phone propped up)
  }

  get width() { return this.video.videoWidth; }
  get height() { return this.video.videoHeight; }
  /** Front cameras should be mirrored so movement reads naturally. */
  get mirrored() { return this.facingMode === 'user'; }

  async start(facingMode = this.facingMode) {
    this.stop();
    this.facingMode = facingMode;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode,
        // 720p-ish keeps pose detection fast on mobile GPUs
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
      },
    });
    this.video.srcObject = this.stream;
    await this.video.play();
    // Wait until dimensions are known
    if (!this.video.videoWidth) {
      await new Promise((res) => {
        this.video.addEventListener('loadedmetadata', res, { once: true });
      });
    }
  }

  async flip() {
    await this.start(this.facingMode === 'environment' ? 'user' : 'environment');
  }

  stop() {
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
  }
}
