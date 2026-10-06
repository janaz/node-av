import { AV_NOPTS_VALUE, AV_SAMPLE_FMT_U8, AV_SAMPLE_FMT_U8P } from '../constants/constants.js';
import { AudioFifo } from '../lib/audio-fifo.js';
import { FFmpegError } from '../lib/error.js';
import { Frame } from '../lib/frame.js';
import { Rational } from '../lib/rational.js';
import { avGetBytesPerSample, avRescaleQ, avSampleFmtIsPlanar } from '../lib/utilities.js';

import type { AVSampleFormat } from '../constants/index.js';
import type { ChannelLayout } from '../lib/types.js';

/**
 * Deviation (seconds) between an input frame's timestamp and the sample count that still counts as continuous input.
 *
 * @internal
 */
const RESYNC_TOLERANCE = 0.02;

/**
 * Input (seconds) over which a larger deviation must persist before it is compensated.
 *
 * @internal
 */
const CONFIRM_DURATION = 0.2;

/**
 * Frames over which a larger deviation must persist before it is compensated.
 *
 * @internal
 */
const CONFIRM_FRAMES = 3;

/**
 * Largest overlap (seconds) dropped from the input instead of restarting the timeline.
 *
 * @internal
 */
const MAX_TRIM = 1;

/**
 * Default largest gap (seconds) filled with silence instead of restarting the timeline.
 *
 * @internal
 */
const DEFAULT_MAX_GAP_FILL = 1;

/**
 * Options for {@link AudioFrameBuffer.create}.
 */
export interface AudioFrameBufferOptions {
  /**
   * Where the timestamps of the output frames come from.
   *
   * With `'input'` the output keeps the timing of the pushed frames, as described
   * for {@link AudioFrameBuffer}. With `'samples'` input timestamps are ignored and
   * the output is counted from 0 by its samples, in the time base of the pushed
   * frames; use it for input whose timestamps are unusable.
   *
   * @default 'input'
   */
  timestamps?: 'input' | 'samples';

  /**
   * Largest gap in seconds that is filled with silence.
   *
   * A larger gap restarts the output timeline at the new timestamp, so it shows up
   * as a timestamp jump instead. Real-time outputs such as RTP are better served by
   * `0`: a filled gap is only written once the input resumes and then goes out as a
   * burst of late packets, while receivers handle a timestamp gap like packet loss.
   * Gaps of up to one output frame are filled either way, because a restart pads the
   * current output frame with silence to its end. The silence is generated while
   * pulling and takes no memory, but a long fill comes out in one go once the input
   * resumes.
   *
   * @default 1
   */
  maxGapFill?: number;
}

/**
 * Run of buffered samples whose timestamps count on from one input timestamp.
 *
 * @internal
 */
interface TimelineSegment {
  /** Sample index the run starts at (always on an output frame boundary). */
  index: number;
  /** Timestamp of that sample in the output time base. */
  pts: bigint;
}

/**
 * Consecutive timed frames whose timestamps deviate from the buffered samples in the same direction.
 *
 * @internal
 */
interface Deviation {
  /** 1 while the input is ahead of the buffered samples (gap), -1 while it is behind (overlap). */
  sign: number;
  /** Number of frames in the run. */
  frames: number;
  /** Number of input samples in the run. */
  samples: number;
  /** Deviation of each frame in the output time base. */
  offsets: bigint[];
}

/**
 * Run of silence in the output that is not stored in the FIFO.
 *
 * @internal
 */
interface SilenceRun {
  /** Sample index the run starts at. */
  index: number;
  /** Number of silent samples. */
  length: number;
}

/**
 * Part of an output frame, read from the FIFO or filled with silence.
 *
 * @internal
 */
interface ReadRun {
  /** Number of samples in the part. */
  length: number;
  /** True if the part is silence instead of FIFO samples. */
  silent: boolean;
}

/**
 * Check the options of an audio frame buffer.
 *
 * @param options - Options to check
 *
 * @throws {RangeError} If an option is out of range
 *
 * @internal
 */
export function assertAudioFrameBufferOptions(options: AudioFrameBufferOptions): void {
  const { timestamps, maxGapFill } = options;
  if (timestamps !== undefined && timestamps !== 'input' && timestamps !== 'samples') {
    throw new RangeError(`timestamps must be 'input' or 'samples', got ${String(timestamps)}`);
  }
  if (maxGapFill !== undefined && !(Number.isFinite(maxGapFill) && maxGapFill >= 0)) {
    throw new RangeError(`maxGapFill must be a finite number of seconds >= 0, got ${maxGapFill}`);
  }
}

/**
 * Middle value of a list of timestamps.
 *
 * @param values - Non-empty list of timestamps
 *
 * @returns The value in the middle after sorting
 *
 * @internal
 */
function median(values: bigint[]): bigint {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sorted[sorted.length >> 1];
}

/**
 * Audio frame buffering utility for encoders with fixed frame size requirements.
 *
 * Many audio encoders (Opus, AAC, MP3, etc.) require frames with a specific number
 * of samples (frame_size). This class buffers incoming frames and outputs frames
 * with exactly the required size.
 *
 * Output frames keep the input timing: each carries the timestamp of its first
 * sample, in the time base of the pushed frames, and counts on by samples while the
 * input is continuous. Deviations of up to 20 ms count as continuous, and larger ones
 * only once they persist over 0.2 s of input, so jitter and single frames with a wrong
 * timestamp leave the audio untouched. A persistent gap of up to a second is then
 * filled with silence and an overlap of up to a second is dropped, which keeps the
 * audio contiguous and in sync; a larger jump restarts the timeline at the new
 * timestamp on the next frame boundary. Frames without a timestamp or time base
 * continue the previous one.
 *
 * Uses FFmpeg's AVAudioFifo internally for efficient sample buffering.
 *
 * @example
 * ```typescript
 * import { AudioFrameBuffer } from 'node-av/api';
 *
 * // Create buffer for 480-sample frames (e.g., Opus at 24kHz)
 * using buffer = AudioFrameBuffer.create(480, AV_SAMPLE_FMT_FLT, 48000, 'mono', 1);
 *
 * // Push variable-sized frames from filter
 * for await (const frame of filterOutput) {
 *   await buffer.push(frame);
 *
 *   // Pull fixed-size frames for encoder
 *   let outputFrame;
 *   while ((outputFrame = await buffer.pull()) !== null) {
 *     await encoder.encode(outputFrame);
 *     outputFrame.free();
 *   }
 * }
 *
 * // Flush remaining samples (final partial frame is padded with silence)
 * let outputFrame;
 * while ((outputFrame = await buffer.pull()) !== null) {
 *   await encoder.encode(outputFrame);
 *   outputFrame.free();
 * }
 * const tail = await buffer.pullPartial();
 * if (tail) {
 *   await encoder.encode(tail);
 *   tail.free();
 * }
 * ```
 *
 * @example
 * ```typescript
 * // Real-time output: input gaps become timestamp jumps instead of silence
 * using buffer = AudioFrameBuffer.create(960, AV_SAMPLE_FMT_FLT, 48000, 'mono', 1, { maxGapFill: 0 });
 * ```
 */
export class AudioFrameBuffer implements Disposable {
  private fifo: AudioFifo;
  private frame: Frame;
  private frameSize: number;
  private channels: number;
  private sampleStride: number;
  private staging: Buffer;
  private stagingPlanes: Buffer[];
  private silenceValue: number;
  private sampleTimeBase: Rational;
  private timeBase: Rational | null = null;
  private countsInSamples = true;
  private followInput: boolean;
  private tolerance: number;
  private confirmSamples: number;
  private maxFill: number;
  private maxTrim: number;
  private headIndex = 0;
  private tailIndex = 0;
  private segments: TimelineSegment[] = [{ index: 0, pts: 0n }];
  private silence: SilenceRun[] = [];
  private timed = false;
  private trimPending = 0;
  private deviation: Deviation | null = null;

  /**
   * @param fifo - Underlying AudioFifo instance
   *
   * @param frameSize - Number of samples per output frame
   *
   * @param sampleFormat - Audio sample format
   *
   * @param sampleRate - Sample rate in Hz
   *
   * @param channelLayout - Channel layout
   *
   * @param options - Timing options
   *
   * @internal
   */
  private constructor(
    fifo: AudioFifo,
    frameSize: number,
    sampleFormat: AVSampleFormat,
    sampleRate: number,
    channelLayout: ChannelLayout,
    options: AudioFrameBufferOptions,
  ) {
    this.fifo = fifo;
    this.frameSize = frameSize;
    this.channels = channelLayout.nbChannels;
    this.frame = new Frame();
    this.frame.alloc();
    this.frame.nbSamples = frameSize;
    this.frame.format = sampleFormat;
    this.frame.sampleRate = sampleRate;
    this.frame.channelLayout = channelLayout;
    // Until the first pushed frame brings a time base, timestamps count samples.
    this.sampleTimeBase = new Rational(1, sampleRate);
    this.frame.timeBase = this.sampleTimeBase;
    this.frame.getBuffer(0); // Allocate buffer once

    // Frame.data is a copy instead of a view where external buffers are not allowed (Electron),
    // so samples are staged in JS memory and copied into the frame with fromBuffer()
    const planar = avSampleFmtIsPlanar(sampleFormat);
    const planeCount = planar ? this.channels : 1;
    this.sampleStride = avGetBytesPerSample(sampleFormat) * (planar ? 1 : this.channels);
    const planeSize = frameSize * this.sampleStride;
    this.staging = Buffer.alloc(planeSize * planeCount);
    this.stagingPlanes = Array.from({ length: planeCount }, (_, i) => this.staging.subarray(i * planeSize, (i + 1) * planeSize));
    // av_samples_set_silence() semantics: unsigned 8-bit formats are silent at 0x80
    this.silenceValue = sampleFormat === AV_SAMPLE_FMT_U8 || sampleFormat === AV_SAMPLE_FMT_U8P ? 0x80 : 0;

    this.followInput = options.timestamps !== 'samples';
    this.tolerance = Math.round(sampleRate * RESYNC_TOLERANCE);
    this.confirmSamples = Math.round(sampleRate * CONFIRM_DURATION);
    // At least one frame: a restart pads the current frame with up to that much silence anyway,
    // and the padding must never reach past the new timestamp
    this.maxFill = Math.max(Math.round(sampleRate * (options.maxGapFill ?? DEFAULT_MAX_GAP_FILL)), frameSize);
    this.maxTrim = Math.round(sampleRate * MAX_TRIM);
  }

  /**
   * Create an audio frame buffer.
   *
   * @param frameSize - Required frame size in samples
   *
   * @param sampleFormat - Audio sample format
   *
   * @param sampleRate - Sample rate in Hz
   *
   * @param channelLayout - Channel layout (e.g., 'mono', 'stereo')
   *
   * @param channels - Number of audio channels
   *
   * @param options - Timing options
   *
   * @returns Configured audio frame buffer
   *
   * @throws {RangeError} If an option is out of range
   *
   * @example
   * ```typescript
   * // For Opus encoder at 48kHz with 20ms frames
   * const buffer = AudioFrameBuffer.create(960, AV_SAMPLE_FMT_FLT, 48000, 'mono', 1);
   * ```
   */
  static create(
    frameSize: number,
    sampleFormat: AVSampleFormat,
    sampleRate: number,
    channelLayout: ChannelLayout,
    channels: number,
    options: AudioFrameBufferOptions = {},
  ): AudioFrameBuffer {
    assertAudioFrameBufferOptions(options);

    const fifo = new AudioFifo();
    // Allocate FIFO with capacity for multiple frames
    fifo.alloc(sampleFormat, channels, frameSize * 4);

    return new AudioFrameBuffer(fifo, frameSize, sampleFormat, sampleRate, channelLayout, options);
  }

  /**
   * Get number of samples currently in buffer.
   *
   * Includes silence inserted for gaps in the input.
   *
   * @returns Number of buffered samples
   *
   * @example
   * ```typescript
   * console.log(`Buffer contains ${buffer.size} samples`);
   * ```
   */
  get size(): number {
    return this.available();
  }

  /**
   * Check if a complete frame is available.
   *
   * Returns true if the buffer holds at least frameSize samples.
   *
   * @returns True if a full frame can be pulled
   *
   * @example
   * ```typescript
   * while (buffer.hasFrame()) {
   *   const frame = buffer.pull();
   *   // Process frame...
   * }
   * ```
   */
  hasFrame(): boolean {
    return this.available() >= this.frameSize;
  }

  /**
   * Push an audio frame into the buffer asynchronously.
   *
   * The frame's samples are added to the internal FIFO.
   * Call hasFrame() and pull() to retrieve fixed-size output frames.
   *
   * The first frame with a valid time base fixes the time base of the output frames.
   * When the frame timestamps deviate from the buffered samples by more than 20 ms
   * over at least 0.2 s of input (and 3 frames), a gap is filled with silence (up to
   * `maxGapFill`) and an overlap of up to 1 s is dropped from the input; a larger jump
   * restarts the timeline at the new timestamp after padding the current output frame
   * with silence. The frames that arrive until then still continue the previous
   * timeline. Each such correction is a short dropout or cut in the audio: input whose
   * timestamps drift against its sample count, such as a capture device stamped from
   * the system clock, gets one per 20 ms of drift, which keeps it within about 20 ms
   * of its timestamps.
   *
   * @param frame - Audio frame to buffer
   *
   * @throws {Error} If the frame is not an audio frame
   *
   * @throws {FFmpegError} If the samples cannot be written to the FIFO
   *
   * @example
   * ```typescript
   * await buffer.push(filterFrame);
   * ```
   *
   * @see {@link pushSync} For synchronous version
   */
  async push(frame: Frame): Promise<void> {
    // Every Frame getter is a call into the addon, so each one is read only once per push
    // (this is frame.isAudio() without its second nbSamples read)
    const nbSamples = frame.nbSamples;
    if (!(frame.sampleRate > 0 && nbSamples > 0)) {
      throw new Error('AudioFrameBuffer.push() requires an audio frame');
    }

    const skip = this.planPush(frame, nbSamples);
    const samples = nbSamples - skip;
    if (samples <= 0) {
      return;
    }

    try {
      FFmpegError.throwIfError(await this.fifo.write(this.inputPlanes(frame, skip), samples), 'Failed to write samples to the audio FIFO');
    } catch (error) {
      this.resyncTail();
      throw error;
    }
  }

  /**
   * Push an audio frame into the buffer synchronously.
   * Synchronous version of push.
   *
   * The frame's samples are added to the internal FIFO.
   * Call hasFrame() and pullSync() to retrieve fixed-size output frames.
   * Timestamps are handled as in push().
   *
   * @param frame - Audio frame to buffer
   *
   * @throws {Error} If the frame is not an audio frame
   *
   * @throws {FFmpegError} If the samples cannot be written to the FIFO
   *
   * @example
   * ```typescript
   * buffer.pushSync(filterFrame);
   * ```
   *
   * @see {@link push} For async version
   */
  pushSync(frame: Frame): void {
    const nbSamples = frame.nbSamples;
    if (!(frame.sampleRate > 0 && nbSamples > 0)) {
      throw new Error('AudioFrameBuffer.pushSync() requires an audio frame');
    }

    const skip = this.planPush(frame, nbSamples);
    const samples = nbSamples - skip;
    if (samples <= 0) {
      return;
    }

    try {
      FFmpegError.throwIfError(this.fifo.writeSync(this.inputPlanes(frame, skip), samples), 'Failed to write samples to the audio FIFO');
    } catch (error) {
      this.resyncTail();
      throw error;
    }
  }

  /**
   * Pull a fixed-size audio frame from the buffer asynchronously.
   *
   * Reads exactly frameSize samples from the FIFO and returns a cloned Frame
   * stamped with the timestamp of its first sample.
   * Returns null if not enough samples are available.
   * Reuses internal frame buffer for efficiency (like Decoder does).
   *
   * @returns Audio frame with exactly frameSize samples, or null if insufficient samples
   *
   * @throws {FFmpegError} If the FIFO cannot be read or the frame cannot be filled
   *
   * @throws {Error} If frame cloning fails (out of memory)
   *
   * @example
   * ```typescript
   * using frame = await buffer.pull();
   * if (frame) {
   *   await encoder.encode(frame);
   * }
   * ```
   *
   * @see {@link pullSync} For synchronous version
   */
  async pull(): Promise<Frame | null> {
    if (!this.hasFrame()) {
      return null;
    }

    const pts = this.headPts();

    // Read samples from FIFO and copy them into the reusable frame
    await this.readStaging(this.frameSize);
    this.commitStaging();

    return this.emitFrame(pts);
  }

  /**
   * Pull a fixed-size audio frame from the buffer synchronously.
   * Synchronous version of pull.
   *
   * Reads exactly frameSize samples from the FIFO and returns a cloned Frame
   * stamped with the timestamp of its first sample.
   * Returns null if not enough samples are available.
   * Reuses internal frame buffer for efficiency (like Decoder does).
   *
   * @returns Audio frame with exactly frameSize samples, or null if insufficient samples
   *
   * @throws {FFmpegError} If the FIFO cannot be read or the frame cannot be filled
   *
   * @throws {Error} If frame cloning fails (out of memory)
   *
   * @example
   * ```typescript
   * using frame = buffer.pullSync();
   * if (frame) {
   *   encoder.encodeSync(frame);
   * }
   * ```
   *
   * @see {@link pull} For async version
   */
  pullSync(): Frame | null {
    if (!this.hasFrame()) {
      return null;
    }

    const pts = this.headPts();

    // Read samples from FIFO and copy them into the reusable frame
    this.readStagingSync(this.frameSize);
    this.commitStaging();

    return this.emitFrame(pts);
  }

  /**
   * Pull the final partial frame from the buffer asynchronously.
   *
   * Reads the remaining samples (fewer than frameSize) and pads the tail with
   * silence so the returned frame still carries exactly frameSize samples.
   * Intended for end-of-stream flushing only - without it the tail (up to
   * frameSize - 1 samples) would be dropped. Returns null if the buffer is
   * empty, or while a complete frame is still available (drain those with
   * pull() first). The padding counts as audio, so frames pushed afterwards are
   * timed after it.
   *
   * @returns Silence-padded audio frame with frameSize samples, or null if nothing to drain
   *
   * @throws {FFmpegError} If the FIFO cannot be read or the frame cannot be filled
   *
   * @throws {Error} If frame cloning fails (out of memory)
   *
   * @example
   * ```typescript
   * // At end of stream, after pull() has returned null
   * using tail = await buffer.pullPartial();
   * if (tail) {
   *   await encoder.encode(tail);
   * }
   * ```
   *
   * @see {@link pullPartialSync} For synchronous version
   * @see {@link pull} For pulling complete frames
   */
  async pullPartial(): Promise<Frame | null> {
    const remaining = this.available();
    if (remaining <= 0 || remaining >= this.frameSize) {
      return null;
    }

    const pts = this.headPts();

    // Read the remaining samples into the head of the staging buffer
    await this.readStaging(remaining);

    // Pad the tail with silence up to frameSize
    this.fillSilence(remaining, this.frameSize);
    this.commitStaging();

    const frame = this.emitFrame(pts);
    this.advanceTailToHead();
    return frame;
  }

  /**
   * Pull the final partial frame from the buffer synchronously.
   * Synchronous version of pullPartial.
   *
   * Reads the remaining samples (fewer than frameSize) and pads the tail with
   * silence so the returned frame still carries exactly frameSize samples.
   * Intended for end-of-stream flushing only. Returns null if the buffer is
   * empty, or while a complete frame is still available.
   *
   * @returns Silence-padded audio frame with frameSize samples, or null if nothing to drain
   *
   * @throws {FFmpegError} If the FIFO cannot be read or the frame cannot be filled
   *
   * @throws {Error} If frame cloning fails (out of memory)
   *
   * @example
   * ```typescript
   * // At end of stream, after pullSync() has returned null
   * using tail = buffer.pullPartialSync();
   * if (tail) {
   *   encoder.encodeSync(tail);
   * }
   * ```
   *
   * @see {@link pullPartial} For async version
   * @see {@link pullSync} For pulling complete frames
   */
  pullPartialSync(): Frame | null {
    const remaining = this.available();
    if (remaining <= 0 || remaining >= this.frameSize) {
      return null;
    }

    const pts = this.headPts();

    // Read the remaining samples into the head of the staging buffer
    this.readStagingSync(remaining);

    // Pad the tail with silence up to frameSize
    this.fillSilence(remaining, this.frameSize);
    this.commitStaging();

    const frame = this.emitFrame(pts);
    this.advanceTailToHead();
    return frame;
  }

  /**
   * Reset the buffer, discarding all buffered samples.
   *
   * The next pushed frame starts a new timeline, and its time base becomes
   * the output time base.
   *
   * @example
   * ```typescript
   * buffer.reset();
   * ```
   */
  reset(): void {
    this.fifo.reset();
    this.headIndex = 0;
    this.tailIndex = 0;
    this.segments = [{ index: 0, pts: 0n }];
    this.silence = [];
    this.timed = false;
    this.trimPending = 0;
    this.deviation = null;
    this.timeBase = null;
    this.countsInSamples = true;
    this.frame.timeBase = this.sampleTimeBase;
  }

  /**
   * Decide how a pushed frame continues the buffered samples.
   *
   * The only place that moves the write position: it records the silence before the
   * frame and accounts for the samples the caller then writes, so the position always
   * runs ahead of the buffered samples by exactly the writes still in flight.
   *
   * @param frame - Audio frame about to be written
   *
   * @param nbSamples - Number of samples in the frame
   *
   * @returns Samples to drop from the head of the frame
   *
   * @internal
   */
  private planPush(frame: Frame, nbSamples: number): number {
    this.timeBase ??= this.lockTimeBase(frame);

    const pts = this.followInput ? this.inputPts(frame) : AV_NOPTS_VALUE;
    if (pts !== AV_NOPTS_VALUE && nbSamples > 0) {
      this.addSilence(this.timed ? this.trackInput(pts, nbSamples) : this.anchorInput(pts));
    }

    const skip = Math.min(this.trimPending, nbSamples);
    this.trimPending -= skip;
    this.tailIndex += nbSamples - skip;
    return skip;
  }

  /**
   * Append silence at the write position.
   *
   * Silence only exists as a run of sample indices and is generated while pulling, so
   * a long gap costs neither a buffer of its size nor a FIFO grown to hold it (an
   * AVAudioFifo never shrinks again).
   *
   * @param samples - Number of silent samples
   *
   * @internal
   */
  private addSilence(samples: number): void {
    if (samples <= 0) {
      return;
    }

    const last = this.silence[this.silence.length - 1];
    if (last && last.index + last.length === this.tailIndex) {
      last.length += samples;
    } else {
      this.silence.push({ index: this.tailIndex, length: samples });
    }
    this.tailIndex += samples;
  }

  /**
   * Anchor the timeline at the first frame that carries a timestamp.
   *
   * @param pts - Timestamp of the frame in the output time base
   *
   * @returns Silence to write before the frame
   *
   * @internal
   */
  private anchorInput(pts: bigint): number {
    this.timed = true;

    const first = this.segments[0];
    if (this.segments.length === 1 && this.headIndex === first.index) {
      // Nothing pulled yet: samples buffered without a timestamp end where this frame starts
      first.pts = pts - this.ticks(this.tailIndex - first.index);
      return 0;
    }

    // Samples without a timestamp already went out on a made-up timeline, which this
    // frame cannot be measured against
    return this.restart(pts);
  }

  /**
   * Compare a frame's timestamp with the buffered samples and compensate a persistent deviation.
   *
   * Within the tolerance the frame counts on by samples. A larger deviation is only
   * acted on once it has lasted over enough input in the same direction: jitter and
   * frames with a wrong timestamp come and go, while gaps, overlaps and clock steps
   * persist. The correction is the median deviation of that run, so jitter on top of
   * a real step does not leak into it.
   *
   * @param pts - Timestamp of the frame in the output time base
   *
   * @param nbSamples - Number of samples in the frame
   *
   * @returns Silence to write before the frame
   *
   * @internal
   */
  private trackInput(pts: bigint, nbSamples: number): number {
    // Where this frame belongs: after the buffered samples, minus the input still to be dropped
    const expected = this.trimPending > 0 ? this.tailPts() - this.ticks(this.trimPending) : this.tailPts();
    const offset = pts - expected;
    const drift = this.samples(offset);
    if (Math.abs(drift) <= this.tolerance) {
      this.deviation = null;
      return 0;
    }

    const sign = drift > 0 ? 1 : -1;
    if (this.deviation?.sign !== sign) {
      this.deviation = { sign, frames: 0, samples: 0, offsets: [] };
    }
    const deviation = this.deviation;
    deviation.frames++;
    deviation.samples += nbSamples;
    deviation.offsets.push(offset);
    if (deviation.frames < CONFIRM_FRAMES || deviation.samples < this.confirmSamples) {
      return 0;
    }

    this.deviation = null;
    return this.compensate(median(deviation.offsets), expected);
  }

  /**
   * Apply a confirmed deviation to the timeline.
   *
   * A gap is filled with silence and an overlap is dropped from the input, which keeps
   * the output contiguous and on its frame grid. Beyond their limits the timeline
   * restarts at the frame's timestamp instead.
   *
   * @param offset - Deviation of the frame in the output time base
   *
   * @param expected - Timestamp the frame would have without the deviation
   *
   * @returns Silence to write before the frame
   *
   * @internal
   */
  private compensate(offset: bigint, expected: bigint): number {
    const drift = this.samples(offset);
    if (drift > 0) {
      // Input still to be dropped is ahead of the expectation by the same amount
      const cancelled = Math.min(drift, this.trimPending);
      this.trimPending -= cancelled;
      const gap = drift - cancelled;
      if (gap <= this.maxFill) {
        return gap;
      }
    } else if (this.trimPending - drift <= this.maxTrim) {
      // Dropping keeps the output monotonic; following a small backward step would make
      // the muxer clamp every packet of the overlap to one tick after the previous one
      this.trimPending -= drift;
      return 0;
    }

    return this.restart(expected + offset);
  }

  /**
   * Start a new segment at the next output frame boundary.
   *
   * Every output frame then lies within one segment, so its timestamp stays well
   * defined; the current partial frame is padded with silence to get there.
   *
   * @param pts - Timestamp of the frame about to be written
   *
   * @returns Silence to write before the frame
   *
   * @internal
   */
  private restart(pts: bigint): number {
    const pad = (this.frameSize - (this.tailIndex % this.frameSize)) % this.frameSize;
    const index = this.tailIndex + pad;
    const last = this.segments[this.segments.length - 1];
    if (last.index === index) {
      last.pts = pts;
    } else {
      this.segments.push({ index, pts });
    }
    this.trimPending = 0;
    this.deviation = null;
    return pad;
  }

  /**
   * Fix the output time base from the first pushed frame.
   *
   * Frames without a valid time base leave the output counting samples (1/sample_rate).
   *
   * @param frame - First pushed frame
   *
   * @returns Output time base
   *
   * @internal
   */
  private lockTimeBase(frame: Frame): Rational {
    const tb = frame.timeBase;
    const timeBase = tb.num > 0 && tb.den > 0 ? tb : this.sampleTimeBase;
    this.countsInSamples = timeBase.num * this.sampleTimeBase.den === timeBase.den;
    this.frame.timeBase = timeBase;
    return timeBase;
  }

  /**
   * Read a frame's timestamp in the output time base.
   *
   * @param frame - Pushed frame
   *
   * @returns Timestamp, or AV_NOPTS_VALUE if the frame has no timestamp or time base
   *
   * @internal
   */
  private inputPts(frame: Frame): bigint {
    const pts = frame.pts;
    if (pts === AV_NOPTS_VALUE) {
      return pts;
    }

    const tb = frame.timeBase;
    if (tb.num <= 0 || tb.den <= 0) {
      return AV_NOPTS_VALUE;
    }

    const out = this.timeBase!;
    return tb.num === out.num && tb.den === out.den ? pts : avRescaleQ(pts, tb, out);
  }

  /**
   * Timestamp of the next sample to pull.
   *
   * Drops segments the head has reached the end of first, so the head lies in the first one.
   *
   * @returns Timestamp in the output time base
   *
   * @internal
   */
  private headPts(): bigint {
    while (this.segments.length > 1 && this.segments[1].index <= this.headIndex) {
      this.segments.shift();
    }

    const segment = this.segments[0];
    return segment.pts + this.ticks(this.headIndex - segment.index);
  }

  /**
   * Timestamp right after the last buffered sample.
   *
   * @returns Timestamp in the output time base
   *
   * @internal
   */
  private tailPts(): bigint {
    const segment = this.segments[this.segments.length - 1];
    return segment.pts + this.ticks(this.tailIndex - segment.index);
  }

  /**
   * Treat the silence padding of a partial frame as written audio.
   *
   * @internal
   */
  private advanceTailToHead(): void {
    this.tailIndex = this.headIndex;
    // Deviations seen so far were measured against the unpadded end
    this.deviation = null;
  }

  /**
   * Realign the write position with the FIFO after a failed write.
   *
   * @internal
   */
  private resyncTail(): void {
    this.tailIndex = this.headIndex + this.available();
    while (this.silence.length > 0 && this.silence[this.silence.length - 1].index >= this.tailIndex) {
      this.silence.pop();
    }
    while (this.segments.length > 1 && this.segments[this.segments.length - 1].index > this.tailIndex) {
      this.segments.pop();
    }
    this.deviation = null;
  }

  /**
   * Number of samples that can be pulled: buffered samples plus the silence between them.
   *
   * Stops at the first silence run that lies behind a write still in flight.
   *
   * @returns Number of samples available from the read position
   *
   * @internal
   */
  private available(): number {
    let buffered = this.fifo.size;
    if (this.silence.length === 0) {
      return buffered;
    }

    let index = this.headIndex;
    for (const run of this.silence) {
      // Negative while the read position lies inside the run
      const before = run.index - index;
      if (before > buffered) {
        break;
      }
      buffered -= Math.max(before, 0);
      index = run.index + run.length;
    }
    return index - this.headIndex + buffered;
  }

  /**
   * Split the next samples to pull into FIFO reads and silence.
   *
   * @param count - Number of samples to pull
   *
   * @returns Parts in pull order
   *
   * @internal
   */
  private readRuns(count: number): ReadRun[] {
    const runs: ReadRun[] = [];
    const end = this.headIndex + count;
    let index = this.headIndex;
    for (const run of this.silence) {
      if (run.index + run.length <= index) {
        continue;
      }
      const start = Math.max(run.index, index);
      if (start >= end) {
        break;
      }
      if (start > index) {
        runs.push({ length: start - index, silent: false });
      }
      index = Math.min(run.index + run.length, end);
      runs.push({ length: index - start, silent: true });
    }
    if (index < end) {
      runs.push({ length: end - index, silent: false });
    }
    return runs;
  }

  /**
   * Read the next samples into the head of the staging buffer.
   *
   * @param count - Number of samples to read
   *
   * @throws {FFmpegError} If the FIFO cannot be read
   *
   * @internal
   */
  private async readStaging(count: number): Promise<void> {
    if (this.silence.length === 0) {
      FFmpegError.throwIfError(await this.fifo.read(this.stagingPlanes, count), 'Failed to read samples from the audio FIFO');
      return;
    }

    let offset = 0;
    for (const run of this.readRuns(count)) {
      if (run.silent) {
        this.fillSilence(offset, offset + run.length);
      } else {
        FFmpegError.throwIfError(await this.fifo.read(this.stagingAt(offset), run.length), 'Failed to read samples from the audio FIFO');
      }
      offset += run.length;
    }
  }

  /**
   * Read the next samples into the head of the staging buffer synchronously.
   * Synchronous version of readStaging.
   *
   * @param count - Number of samples to read
   *
   * @throws {FFmpegError} If the FIFO cannot be read
   *
   * @internal
   */
  private readStagingSync(count: number): void {
    if (this.silence.length === 0) {
      FFmpegError.throwIfError(this.fifo.readSync(this.stagingPlanes, count), 'Failed to read samples from the audio FIFO');
      return;
    }

    let offset = 0;
    for (const run of this.readRuns(count)) {
      if (run.silent) {
        this.fillSilence(offset, offset + run.length);
      } else {
        FFmpegError.throwIfError(this.fifo.readSync(this.stagingAt(offset), run.length), 'Failed to read samples from the audio FIFO');
      }
      offset += run.length;
    }
  }

  /**
   * Staging planes starting at a sample offset.
   *
   * @param offset - First sample to write to
   *
   * @returns Plane buffers for a FIFO read
   *
   * @internal
   */
  private stagingAt(offset: number): Buffer[] {
    if (offset === 0) {
      return this.stagingPlanes;
    }

    const start = offset * this.sampleStride;
    return this.stagingPlanes.map((plane) => plane.subarray(start));
  }

  /**
   * Convert a sample count to output time base ticks.
   *
   * @param samples - Number of samples
   *
   * @returns Duration in the output time base
   *
   * @internal
   */
  private ticks(samples: number): bigint {
    return this.countsInSamples ? BigInt(samples) : avRescaleQ(samples, this.sampleTimeBase, this.timeBase ?? this.sampleTimeBase);
  }

  /**
   * Convert output time base ticks to a sample count.
   *
   * @param ticks - Duration in the output time base
   *
   * @returns Number of samples (rounded)
   *
   * @internal
   */
  private samples(ticks: bigint): number {
    return Number(this.countsInSamples ? ticks : avRescaleQ(ticks, this.timeBase ?? this.sampleTimeBase, this.sampleTimeBase));
  }

  /**
   * Plane buffers of a pushed frame, starting at a sample offset.
   *
   * @param frame - Pushed frame
   *
   * @param skip - Samples to leave out at the head
   *
   * @returns Plane buffers to write to the FIFO
   *
   * @internal
   */
  private inputPlanes(frame: Frame, skip: number): Buffer[] {
    const planes = frame.data!;
    if (skip === 0) {
      return planes;
    }

    const offset = skip * this.sampleStride;
    return planes.map((plane) => plane.subarray(offset));
  }

  /**
   * Stamp the reusable frame, advance the read position by one frame and hand out a clone.
   *
   * @param pts - Timestamp of the frame's first sample
   *
   * @returns Cloned output frame
   *
   * @throws {Error} If frame cloning fails (out of memory)
   *
   * @internal
   */
  private emitFrame(pts: bigint): Frame {
    this.frame.pts = pts;
    this.headIndex += this.frameSize;
    while (this.silence.length > 0 && this.silence[0].index + this.silence[0].length <= this.headIndex) {
      this.silence.shift();
    }

    // Clone frame for user (like Decoder does)
    const cloned = this.frame.clone();
    if (!cloned) {
      throw new Error('Failed to clone frame (out of memory)');
    }
    return cloned;
  }

  /**
   * Fill the staged sample range [fromSample, toSample) with silence.
   *
   * Planar frames carry one channel per plane; packed frames interleave all
   * channels in plane 0.
   *
   * @param fromSample - First sample index to silence
   *
   * @param toSample - Sample index after the last one to silence
   *
   * @internal
   */
  private fillSilence(fromSample: number, toSample: number): void {
    for (const plane of this.stagingPlanes) {
      plane.fill(this.silenceValue, fromSample * this.sampleStride, toSample * this.sampleStride);
    }
  }

  /**
   * Copy the staged samples into the reusable frame.
   *
   * A frame pulled earlier may still share the frame's buffer, so the buffer is
   * made writable first instead of overwriting the samples under that frame.
   *
   * @throws {FFmpegError} If the frame buffer cannot be made writable or filled
   *
   * @internal
   */
  private commitStaging(): void {
    FFmpegError.throwIfError(this.frame.makeWritable(), 'Failed to make frame writable');
    FFmpegError.throwIfError(this.frame.fromBuffer(this.staging), 'Failed to copy samples into frame');
  }

  /**
   * Free the buffer and all resources.
   *
   * @example
   * ```typescript
   * buffer.free();
   * ```
   */
  [Symbol.dispose](): void {
    this.frame.free();
    this.fifo[Symbol.dispose]();
  }
}
