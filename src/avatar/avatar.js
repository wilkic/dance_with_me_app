/**
 * Avatar: the interface every avatar implementation must satisfy.
 *
 * Avatars are deliberately decoupled from pose detection — they consume the
 * standardized PoseFrame (see pose/poseFormat.js). Later phases can add
 * AI-generated dancers or remote users' avatars by implementing this same
 * interface and feeding them PoseFrames from another source (a generator,
 * the network) instead of the local detector.
 */
export class Avatar {
  /**
   * @param {CanvasRenderingContext2D} ctx  target context (stage-sized)
   * @param {object} poseFrame              standardized PoseFrame
   * @param {{width:number,height:number}} viewport  stage pixel size
   * @param {object} [beat]                 optional beat state from BeatDetector
   */
  // eslint-disable-next-line no-unused-vars
  render(ctx, poseFrame, viewport, beat) {
    throw new Error('Avatar.render must be implemented');
  }
}
