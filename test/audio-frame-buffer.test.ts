import assert from 'node:assert';
import { describe, it } from 'node:test';
import { AudioFrameBuffer } from '../src/api/audio-frame-buffer.js';
import { AV_CHANNEL_LAYOUT_MONO, AV_CHANNEL_LAYOUT_STEREO } from '../src/constants/channel-layouts.js';
import { AV_NOPTS_VALUE, AV_SAMPLE_FMT_FLT, AV_SAMPLE_FMT_FLTP, AV_SAMPLE_FMT_S16, AV_SAMPLE_FMT_U8 } from '../src/constants/constants.js';
import { Frame } from '../src/lib/frame.js';
import { Rational } from '../src/lib/rational.js';

import type { AVSampleFormat } from '../src/constants/constants.js';
import type { ChannelLayout, IRational } from '../src/lib/types.js';

// Helper function to create audio frames
function createAudioFrame(nbSamples: number, format: AVSampleFormat, sampleRate: number, channelLayout: ChannelLayout, pts = 0n): Frame {
  const frame = new Frame();
  frame.alloc();
  frame.nbSamples = nbSamples;
  frame.format = format;
  frame.sampleRate = sampleRate;
  frame.channelLayout = channelLayout;
  frame.getBuffer(0);
  frame.pts = pts;
  return frame;
}

describe('AudioFrameBuffer', () => {
  describe('create', () => {
    it('should create buffer with correct parameters', () => {
      using buffer = AudioFrameBuffer.create(480, AV_SAMPLE_FMT_FLT, 48000, AV_CHANNEL_LAYOUT_MONO, 1);

      assert.strictEqual(buffer.size, 0, 'Initial buffer should be empty');
      assert.strictEqual(buffer.hasFrame(), false, 'Should not have frame initially');
    });

    it('should create buffer for different sample formats', () => {
      using buffer1 = AudioFrameBuffer.create(960, AV_SAMPLE_FMT_S16, 48000, AV_CHANNEL_LAYOUT_STEREO, 2);
      using buffer2 = AudioFrameBuffer.create(1024, AV_SAMPLE_FMT_FLT, 44100, AV_CHANNEL_LAYOUT_MONO, 1);

      assert.strictEqual(buffer1.size, 0);
      assert.strictEqual(buffer2.size, 0);
    });
  });

  describe('push (async)', () => {
    it('should buffer audio frames asynchronously', async () => {
      using buffer = AudioFrameBuffer.create(480, AV_SAMPLE_FMT_FLT, 48000, AV_CHANNEL_LAYOUT_MONO, 1);
      using frame = createAudioFrame(240, AV_SAMPLE_FMT_FLT, 48000, AV_CHANNEL_LAYOUT_MONO);

      await buffer.push(frame);

      assert.strictEqual(buffer.size, 240, 'Buffer should contain 240 samples');
      assert.strictEqual(buffer.hasFrame(), false, 'Should not have complete frame yet');
    });

    it('should accumulate samples from multiple frames', async () => {
      using buffer = AudioFrameBuffer.create(480, AV_SAMPLE_FMT_FLT, 48000, AV_CHANNEL_LAYOUT_MONO, 1);
      using frame1 = createAudioFrame(240, AV_SAMPLE_FMT_FLT, 48000, AV_CHANNEL_LAYOUT_MONO, 0n);
      using frame2 = createAudioFrame(240, AV_SAMPLE_FMT_FLT, 48000, AV_CHANNEL_LAYOUT_MONO, 240n);

      await buffer.push(frame1);
      assert.strictEqual(buffer.size, 240);
      assert.strictEqual(buffer.hasFrame(), false);

      await buffer.push(frame2);
      assert.strictEqual(buffer.size, 480);
      assert.strictEqual(buffer.hasFrame(), true, 'Should have complete frame now');
    });

    it('should throw error for non-audio frames', async () => {
      using buffer = AudioFrameBuffer.create(480, AV_SAMPLE_FMT_FLT, 48000, AV_CHANNEL_LAYOUT_MONO, 1);
      using frame = new Frame(); // Empty frame, not audio

      await assert.rejects(async () => await buffer.push(frame), /requires an audio frame/, 'Should reject non-audio frames');
    });
  });

  describe('pushSync', () => {
    it('should buffer audio frames synchronously', () => {
      using buffer = AudioFrameBuffer.create(480, AV_SAMPLE_FMT_FLT, 48000, AV_CHANNEL_LAYOUT_MONO, 1);
      using frame = createAudioFrame(240, AV_SAMPLE_FMT_FLT, 48000, AV_CHANNEL_LAYOUT_MONO);

      buffer.pushSync(frame);

      assert.strictEqual(buffer.size, 240, 'Buffer should contain 240 samples');
      assert.strictEqual(buffer.hasFrame(), false, 'Should not have complete frame yet');
    });
  });

  describe('pull (async)', () => {
    it('should return null when insufficient samples', async () => {
      using buffer = AudioFrameBuffer.create(480, AV_SAMPLE_FMT_FLT, 48000, AV_CHANNEL_LAYOUT_MONO, 1);
      using frame = createAudioFrame(240, AV_SAMPLE_FMT_FLT, 48000, AV_CHANNEL_LAYOUT_MONO);

      await buffer.push(frame);

      const outputFrame = await buffer.pull();
      assert.strictEqual(outputFrame, null, 'Should return null when insufficient samples');
    });

    it('should return frame with correct size when enough samples available', async () => {
      using buffer = AudioFrameBuffer.create(480, AV_SAMPLE_FMT_FLT, 48000, AV_CHANNEL_LAYOUT_MONO, 1);
      using frame = createAudioFrame(960, AV_SAMPLE_FMT_FLT, 48000, AV_CHANNEL_LAYOUT_MONO);

      await buffer.push(frame);

      // Should be able to pull 2 frames
      using outputFrame1 = await buffer.pull();
      assert.notStrictEqual(outputFrame1, null);
      assert.strictEqual(outputFrame1!.nbSamples, 480, 'Output frame should have exactly 480 samples');
      assert.strictEqual(outputFrame1!.pts, 0n, 'First frame PTS should be 0');
      assert.strictEqual(outputFrame1!.timeBase.num, 1, 'Output timebase numerator should be 1');
      assert.strictEqual(outputFrame1!.timeBase.den, 48000, 'Output timebase should be 1/sample_rate to match the sample-counter PTS');

      using outputFrame2 = await buffer.pull();
      assert.notStrictEqual(outputFrame2, null);
      assert.strictEqual(outputFrame2!.nbSamples, 480);
      assert.strictEqual(outputFrame2!.pts, 480n, 'Second frame PTS should be 480');

      // No more frames available
      const outputFrame3 = await buffer.pull();
      assert.strictEqual(outputFrame3, null);
    });

    it('should maintain PTS continuity', async () => {
      using buffer = AudioFrameBuffer.create(480, AV_SAMPLE_FMT_FLT, 48000, AV_CHANNEL_LAYOUT_MONO, 1);

      // Push multiple frames
      for (let i = 0; i < 3; i++) {
        using frame = createAudioFrame(480, AV_SAMPLE_FMT_FLT, 48000, AV_CHANNEL_LAYOUT_MONO, BigInt(i * 480));
        await buffer.push(frame);
      }

      // Pull and verify PTS
      using frame1 = await buffer.pull();
      assert.strictEqual(frame1!.pts, 0n);

      using frame2 = await buffer.pull();
      assert.strictEqual(frame2!.pts, 480n);

      using frame3 = await buffer.pull();
      assert.strictEqual(frame3!.pts, 960n);
    });
  });

  describe('pullSync', () => {
    it('should return frame synchronously', () => {
      using buffer = AudioFrameBuffer.create(480, AV_SAMPLE_FMT_FLT, 48000, AV_CHANNEL_LAYOUT_MONO, 1);
      using frame = createAudioFrame(480, AV_SAMPLE_FMT_FLT, 48000, AV_CHANNEL_LAYOUT_MONO);

      buffer.pushSync(frame);

      using outputFrame = buffer.pullSync();
      assert.notStrictEqual(outputFrame, null);
      assert.strictEqual(outputFrame!.nbSamples, 480);
    });
  });

  describe('pullPartial', () => {
    it('should return null when buffer is empty', async () => {
      using buffer = AudioFrameBuffer.create(480, AV_SAMPLE_FMT_FLT, 48000, AV_CHANNEL_LAYOUT_MONO, 1);

      const outputFrame = await buffer.pullPartial();
      assert.strictEqual(outputFrame, null, 'Should return null with nothing to drain');
    });

    it('should return null while a complete frame is still available', async () => {
      using buffer = AudioFrameBuffer.create(480, AV_SAMPLE_FMT_FLT, 48000, AV_CHANNEL_LAYOUT_MONO, 1);
      using frame = createAudioFrame(700, AV_SAMPLE_FMT_FLT, 48000, AV_CHANNEL_LAYOUT_MONO);

      await buffer.push(frame);

      const outputFrame = await buffer.pullPartial();
      assert.strictEqual(outputFrame, null, 'Complete frames must be drained via pull() first');
    });

    it('should pad the final partial frame with silence (async)', async () => {
      using buffer = AudioFrameBuffer.create(480, AV_SAMPLE_FMT_FLT, 48000, AV_CHANNEL_LAYOUT_MONO, 1);
      using frame = createAudioFrame(300, AV_SAMPLE_FMT_FLT, 48000, AV_CHANNEL_LAYOUT_MONO);
      // Fill the input with non-zero bytes so real samples are distinguishable from padding
      frame.data![0].fill(0x3f, 0, 300 * 4);

      await buffer.push(frame);

      using outputFrame = await buffer.pullPartial();
      assert.notStrictEqual(outputFrame, null);
      assert.strictEqual(outputFrame!.nbSamples, 480, 'Padded frame should have exactly frameSize samples');
      assert.strictEqual(outputFrame!.pts, 0n, 'PTS should continue the sample counter');
      assert.strictEqual(outputFrame!.timeBase.num, 1);
      assert.strictEqual(outputFrame!.timeBase.den, 48000, 'Timebase should be 1/sample_rate');
      assert.strictEqual(buffer.size, 0, 'Buffer should be drained');

      const data = outputFrame!.data![0];
      assert.ok(
        data.subarray(0, 300 * 4).every((b) => b === 0x3f),
        'Real samples should be preserved',
      );
      assert.ok(
        data.subarray(300 * 4, 480 * 4).every((b) => b === 0),
        'Tail should be padded with silence',
      );
    });

    it('should pad the final partial frame with silence (sync)', () => {
      using buffer = AudioFrameBuffer.create(480, AV_SAMPLE_FMT_FLT, 48000, AV_CHANNEL_LAYOUT_MONO, 1);
      using frame = createAudioFrame(300, AV_SAMPLE_FMT_FLT, 48000, AV_CHANNEL_LAYOUT_MONO);
      frame.data![0].fill(0x3f, 0, 300 * 4);

      buffer.pushSync(frame);

      using outputFrame = buffer.pullPartialSync();
      assert.notStrictEqual(outputFrame, null);
      assert.strictEqual(outputFrame!.nbSamples, 480, 'Padded frame should have exactly frameSize samples');
      assert.strictEqual(outputFrame!.pts, 0n, 'PTS should continue the sample counter');
      assert.strictEqual(buffer.size, 0, 'Buffer should be drained');

      const data = outputFrame!.data![0];
      assert.ok(
        data.subarray(300 * 4, 480 * 4).every((b) => b === 0),
        'Tail should be padded with silence',
      );
    });

    it('should continue the sample-counter PTS after full pulls', async () => {
      using buffer = AudioFrameBuffer.create(480, AV_SAMPLE_FMT_FLT, 48000, AV_CHANNEL_LAYOUT_MONO, 1);
      using frame = createAudioFrame(700, AV_SAMPLE_FMT_FLT, 48000, AV_CHANNEL_LAYOUT_MONO);

      await buffer.push(frame);

      using fullFrame = await buffer.pull();
      assert.strictEqual(fullFrame!.pts, 0n);

      using partialFrame = await buffer.pullPartial();
      assert.notStrictEqual(partialFrame, null);
      assert.strictEqual(partialFrame!.pts, 480n, 'Partial frame PTS should follow the last full frame');
      assert.strictEqual(partialFrame!.nbSamples, 480);
    });

    it('should use 0x80 as the silence value for unsigned 8-bit', async () => {
      using buffer = AudioFrameBuffer.create(480, AV_SAMPLE_FMT_U8, 48000, AV_CHANNEL_LAYOUT_MONO, 1);
      using frame = createAudioFrame(100, AV_SAMPLE_FMT_U8, 48000, AV_CHANNEL_LAYOUT_MONO);
      frame.data![0].fill(0x11, 0, 100);

      await buffer.push(frame);

      using outputFrame = await buffer.pullPartial();
      assert.notStrictEqual(outputFrame, null);
      const data = outputFrame!.data![0];
      assert.ok(
        data.subarray(100, 480).every((b) => b === 0x80),
        'u8 tail should be padded with 0x80 (unsigned silence)',
      );
    });
  });

  describe('hasFrame', () => {
    it('should return true when enough samples available', async () => {
      using buffer = AudioFrameBuffer.create(480, AV_SAMPLE_FMT_FLT, 48000, AV_CHANNEL_LAYOUT_MONO, 1);
      using frame = createAudioFrame(480, AV_SAMPLE_FMT_FLT, 48000, AV_CHANNEL_LAYOUT_MONO);

      await buffer.push(frame);

      assert.strictEqual(buffer.hasFrame(), true);
    });

    it('should return false when insufficient samples', async () => {
      using buffer = AudioFrameBuffer.create(480, AV_SAMPLE_FMT_FLT, 48000, AV_CHANNEL_LAYOUT_MONO, 1);
      using frame = createAudioFrame(240, AV_SAMPLE_FMT_FLT, 48000, AV_CHANNEL_LAYOUT_MONO);

      await buffer.push(frame);

      assert.strictEqual(buffer.hasFrame(), false);
    });
  });

  describe('reset', () => {
    it('should clear buffer and reset PTS', async () => {
      using buffer = AudioFrameBuffer.create(480, AV_SAMPLE_FMT_FLT, 48000, AV_CHANNEL_LAYOUT_MONO, 1);
      using frame = createAudioFrame(480, AV_SAMPLE_FMT_FLT, 48000, AV_CHANNEL_LAYOUT_MONO);

      await buffer.push(frame);
      assert.strictEqual(buffer.size, 480);
      assert.strictEqual(buffer.hasFrame(), true);

      buffer.reset();

      assert.strictEqual(buffer.size, 0, 'Buffer should be empty after reset');
      assert.strictEqual(buffer.hasFrame(), false, 'Should not have frame after reset');

      // Verify PTS reset by pushing and pulling again. The frame has no time base,
      // so its PTS is not trusted and the timeline restarts at 0.
      using frame2 = createAudioFrame(480, AV_SAMPLE_FMT_FLT, 48000, AV_CHANNEL_LAYOUT_MONO, 1000n);
      await buffer.push(frame2);
      using outputFrame = await buffer.pull();
      assert.strictEqual(outputFrame!.pts, 0n, 'PTS should reset to 0 after buffer reset');
    });
  });

  describe('size', () => {
    it('should track number of buffered samples', async () => {
      using buffer = AudioFrameBuffer.create(480, AV_SAMPLE_FMT_FLT, 48000, AV_CHANNEL_LAYOUT_MONO, 1);

      assert.strictEqual(buffer.size, 0);

      using frame1 = createAudioFrame(240, AV_SAMPLE_FMT_FLT, 48000, AV_CHANNEL_LAYOUT_MONO);
      await buffer.push(frame1);
      assert.strictEqual(buffer.size, 240);

      using frame2 = createAudioFrame(240, AV_SAMPLE_FMT_FLT, 48000, AV_CHANNEL_LAYOUT_MONO);
      await buffer.push(frame2);
      assert.strictEqual(buffer.size, 480);

      using outputFrame = await buffer.pull();
      assert.notStrictEqual(outputFrame, null);
      assert.strictEqual(buffer.size, 0, 'Buffer should be empty after pulling all samples');
    });
  });

  describe('variable frame sizes', () => {
    it('should handle variable input frame sizes correctly', async () => {
      using buffer = AudioFrameBuffer.create(480, AV_SAMPLE_FMT_FLT, 48000, AV_CHANNEL_LAYOUT_MONO, 1);

      const sizes = [100, 200, 300, 400, 500];

      for (const size of sizes) {
        using frame = createAudioFrame(size, AV_SAMPLE_FMT_FLT, 48000, AV_CHANNEL_LAYOUT_MONO);
        await buffer.push(frame);
      }

      // Total: 1500 samples = 3 complete frames (480 each) + 60 remaining
      assert.strictEqual(buffer.size, 1500);

      using frame1 = await buffer.pull();
      assert.notStrictEqual(frame1, null);
      assert.strictEqual(frame1!.nbSamples, 480);

      using frame2 = await buffer.pull();
      assert.notStrictEqual(frame2, null);
      assert.strictEqual(frame2!.nbSamples, 480);

      using frame3 = await buffer.pull();
      assert.notStrictEqual(frame3, null);
      assert.strictEqual(frame3!.nbSamples, 480);

      // Should have 60 samples remaining
      assert.strictEqual(buffer.size, 60);
      assert.strictEqual(buffer.hasFrame(), false);
    });
  });

  describe('disposal', () => {
    it('should properly dispose resources', () => {
      using _buffer = AudioFrameBuffer.create(480, AV_SAMPLE_FMT_FLT, 48000, AV_CHANNEL_LAYOUT_MONO, 1);
      // using statement will automatically call Symbol.dispose
    });

    it('should handle manual disposal', () => {
      const buffer = AudioFrameBuffer.create(480, AV_SAMPLE_FMT_FLT, 48000, AV_CHANNEL_LAYOUT_MONO, 1);
      buffer[Symbol.dispose]();
      // Should not throw
    });
  });

  describe('timestamps', () => {
    // 48 kHz mono, 480-sample output frames, 960-sample (20 ms) input frames.
    // Deviations up to 20 ms (960 samples) count as continuous; larger ones are compensated
    // once they persisted over 0.2 s of input (10 input frames). Gaps up to 1 s are filled,
    // overlaps up to 1 s dropped, anything larger restarts the timeline.
    const RATE = 48000;
    const TB = new Rational(1, RATE);
    const IN = 960;
    const CONFIRM = 10;

    // Mono float frame whose samples hold (input sample index + 1), so dropped
    // samples and inserted silence (0) are visible in the output.
    function rampFrame(nbSamples: number, pts: bigint, firstIndex: number, timeBase: IRational = TB): Frame {
      const frame = createAudioFrame(nbSamples, AV_SAMPLE_FMT_FLT, RATE, AV_CHANNEL_LAYOUT_MONO, pts);
      frame.timeBase = timeBase;
      const data = frame.data![0];
      for (let i = 0; i < nbSamples; i++) {
        data.writeFloatLE(firstIndex + i + 1, i * 4);
      }
      return frame;
    }

    // Push IN-sample frames numbered from `first` (their samples continue the input), stamped by `pts(i)`.
    function feed(buffer: AudioFrameBuffer, first: number, count: number, pts: (i: number) => bigint): void {
      for (let i = first; i < first + count; i++) {
        using frame = rampFrame(IN, pts(i), i * IN);
        buffer.pushSync(frame);
      }
    }

    function drainSync(buffer: AudioFrameBuffer): { pts: bigint[]; samples: number[]; timeBase?: IRational } {
      const pts: bigint[] = [];
      const samples: number[] = [];
      let timeBase: IRational | undefined;
      let frame;
      while ((frame = buffer.pullSync()) !== null) {
        using out = frame;
        assert.strictEqual(out.nbSamples, 480, 'Every output frame keeps the encoder frame size');
        pts.push(out.pts);
        timeBase = out.timeBase;
        const data = out.data![0];
        for (let i = 0; i < out.nbSamples; i++) {
          samples.push(data.readFloatLE(i * 4));
        }
      }
      return { pts, samples, timeBase };
    }

    async function drainAsync(buffer: AudioFrameBuffer): Promise<{ pts: bigint[]; samples: number[] }> {
      const pts: bigint[] = [];
      const samples: number[] = [];
      let frame;
      while ((frame = await buffer.pull()) !== null) {
        using out = frame;
        pts.push(out.pts);
        const data = out.data![0];
        for (let i = 0; i < out.nbSamples; i++) {
          samples.push(data.readFloatLE(i * 4));
        }
      }
      return { pts, samples };
    }

    // Deterministic pseudo-random numbers in [0, 1)
    function random(seed: number): () => number {
      let state = seed;
      return () => {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        return state / 0x80000000;
      };
    }

    const ramp = (from: number, count: number): number[] => Array.from({ length: count }, (_, i) => from + i + 1);
    const silence = (count: number): number[] => new Array<number>(count).fill(0);
    const frameStarts = (first: number, count: number): bigint[] => Array.from({ length: count }, (_, i) => BigInt(first + i * 480));

    it('stamps each output frame with the timestamp of its first input sample', () => {
      using buffer = AudioFrameBuffer.create(480, AV_SAMPLE_FMT_FLT, RATE, AV_CHANNEL_LAYOUT_MONO, 1);

      // 2 s offset start, 300-sample input frames (not aligned to the output frame size)
      for (let i = 0; i < 10; i++) {
        using frame = rampFrame(300, BigInt(96000 + i * 300), i * 300);
        buffer.pushSync(frame);
      }

      const out = drainSync(buffer);
      assert.deepStrictEqual(out.pts, frameStarts(96000, 6), 'Output keeps the input start and counts on by samples');
      assert.deepStrictEqual(out.samples, ramp(0, 2880), 'Continuous input passes through unchanged');
      assert.strictEqual(out.timeBase?.num, 1);
      assert.strictEqual(out.timeBase?.den, RATE);
      assert.strictEqual(buffer.size, 120);
    });

    it('neither inserts nor drops samples for timestamp jitter', () => {
      using buffer = AudioFrameBuffer.create(480, AV_SAMPLE_FMT_FLT, RATE, AV_CHANNEL_LAYOUT_MONO, 1);

      // 10 s of sample-continuous input stamped with +-30 ms of uniform jitter
      const next = random(1);
      feed(buffer, 0, 500, (i) => BigInt(i * IN + Math.round((next() * 2 - 1) * 0.03 * RATE)));

      const out = drainSync(buffer);
      assert.strictEqual(out.samples.length + buffer.size, 500 * IN, 'Every pushed sample is kept, none inserted');
      assert.deepStrictEqual(out.samples, ramp(0, out.samples.length));
      assert.deepStrictEqual(out.pts, frameStarts(Number(out.pts[0]), out.pts.length), 'Jitter must not move the output timeline');
    });

    it('ignores frames with a wrong timestamp that do not persist', () => {
      using buffer = AudioFrameBuffer.create(480, AV_SAMPLE_FMT_FLT, RATE, AV_CHANNEL_LAYOUT_MONO, 1);

      const outliers = new Map<number, number>([
        [20, 3 * RATE], // a single frame 3 s ahead
        [40, -3 * RATE], // a single frame 3 s behind
        [60, 2400], // two frames 50 ms ahead
        [61, 2400],
        [80, 30 * 3600 * RATE], // a single frame 30 h ahead
      ]);
      feed(buffer, 0, 100, (i) => BigInt(i * IN + (outliers.get(i) ?? 0)));

      const out = drainSync(buffer);
      assert.deepStrictEqual(out.samples, ramp(0, 100 * IN));
      assert.deepStrictEqual(out.pts, frameStarts(0, 200));
    });

    it('fills a persistent gap with silence', () => {
      using buffer = AudioFrameBuffer.create(480, AV_SAMPLE_FMT_FLT, RATE, AV_CHANNEL_LAYOUT_MONO, 1);

      // 50 ms of input missing after frame 9
      feed(buffer, 0, 10, (i) => BigInt(i * IN));
      feed(buffer, 10, 15, (i) => BigInt(i * IN + 2400));

      const out = drainSync(buffer);
      // Frames that arrive before the gap counts as persistent still continue the output
      const early = (CONFIRM - 1) * IN;
      assert.deepStrictEqual(out.samples, [...ramp(0, 10 * IN + early), ...silence(2400), ...ramp(10 * IN + early, 6 * IN)]);
      assert.deepStrictEqual(out.pts, frameStarts(0, 55), 'Output stays contiguous across the gap');
      assert.strictEqual(out.samples.indexOf(10 * IN + early + 1), (10 + CONFIRM - 1) * IN + 2400, 'Afterwards the input lands at its timestamp');
    });

    it('drops a persistent overlap once instead of latching onto the highest timestamp', () => {
      using buffer = AudioFrameBuffer.create(480, AV_SAMPLE_FMT_FLT, RATE, AV_CHANNEL_LAYOUT_MONO, 1);

      // The input steps back 30 ms after frame 9 and stays there
      feed(buffer, 0, 10, (i) => BigInt(i * IN));
      feed(buffer, 10, 40, (i) => BigInt(i * IN - 1440));

      const out = drainSync(buffer);
      // The 1440 samples after the confirmation point are dropped: all of frame 19, half of frame 20
      const cut = (10 + CONFIRM - 1) * IN;
      assert.deepStrictEqual(out.samples, [...ramp(0, cut), ...ramp(cut + 1440, 50 * IN - cut - 1440 - buffer.size)]);
      assert.deepStrictEqual(out.pts, frameStarts(0, out.pts.length));
      assert.strictEqual(out.samples.length + buffer.size, 50 * IN - 1440, 'Exactly the overlap is dropped');
    });

    it('drops an overlap that takes longer than the confirmation to consume exactly once', () => {
      using buffer = AudioFrameBuffer.create(480, AV_SAMPLE_FMT_FLT, RATE, AV_CHANNEL_LAYOUT_MONO, 1);

      // The input steps back 0.5 s after frame 9: dropping it takes 25 input frames
      feed(buffer, 0, 10, (i) => BigInt(i * IN));
      feed(buffer, 10, 60, (i) => BigInt(i * IN - 24000));

      const out = drainSync(buffer);
      const cut = (10 + CONFIRM - 1) * IN;
      assert.strictEqual(out.samples.length + buffer.size, 70 * IN - 24000, 'Exactly the overlap is dropped');
      assert.deepStrictEqual(out.samples, [...ramp(0, cut), ...ramp(cut + 24000, out.samples.length - cut)]);
      assert.deepStrictEqual(out.pts, frameStarts(0, out.pts.length));
    });

    it('takes the median deviation, so jitter on a real gap does not leak into the fill', () => {
      using buffer = AudioFrameBuffer.create(480, AV_SAMPLE_FMT_FLT, RATE, AV_CHANNEL_LAYOUT_MONO, 1);

      // 100 ms gap with +-5 ms of jitter on every timestamp
      const next = random(7);
      const jitter = (): number => Math.round((next() * 2 - 1) * 0.005 * RATE);
      feed(buffer, 0, 50, (i) => BigInt(i * IN + jitter()));
      feed(buffer, 50, 50, (i) => BigInt(i * IN + 4800 + jitter()));

      const out = drainSync(buffer);
      const filled = out.samples.filter((value) => value === 0).length;
      assert.ok(Math.abs(filled - 4800) <= 240, `filled ${filled} samples for a 4800-sample gap`);
      assert.deepStrictEqual(
        out.samples.filter((value) => value !== 0),
        ramp(0, out.samples.length - filled),
        'No input is dropped',
      );
    });

    it('keeps drifting input within about the tolerance of its timestamps with few corrections', () => {
      using buffer = AudioFrameBuffer.create(480, AV_SAMPLE_FMT_FLT, RATE, AV_CHANNEL_LAYOUT_MONO, 1);

      // Timestamps run 0.5% slower than the sample count: 0.15 s over 30 s
      feed(buffer, 0, 1500, (i) => BigInt(Math.round(i * IN * 0.995)));

      const out = drainSync(buffer);
      let cuts = 0;
      let worst = 0;
      for (let i = 0; i < out.pts.length; i++) {
        const input = out.samples[i * 480] - 1;
        const inputPts = Math.round(Math.floor(input / IN) * IN * 0.995) + (input % IN);
        worst = Math.max(worst, Math.abs(Number(out.pts[i]) - inputPts));
      }
      for (let i = 1; i < out.samples.length; i++) {
        const step = out.samples[i] - out.samples[i - 1];
        if (step !== 1) {
          cuts++;
          assert.ok(step > 960, `each correction exceeds the tolerance, got a cut of ${step - 1} samples`);
        }
      }
      assert.ok(cuts > 0 && cuts <= 8, `${cuts} corrections for 7200 samples of drift`);
      assert.ok(worst <= 960 + 480, `output timestamps stay within ${worst} samples of the input`);
    });

    it('restarts the timeline on a jump beyond the fill limit', () => {
      using buffer = AudioFrameBuffer.create(480, AV_SAMPLE_FMT_FLT, RATE, AV_CHANNEL_LAYOUT_MONO, 1);

      using f0 = rampFrame(600, 0n, 0);
      buffer.pushSync(f0);
      // Frames continue the 600 samples, then the input jumps 10 s ahead
      for (let i = 0; i < 4 + 15; i++) {
        using frame = rampFrame(IN, BigInt(600 + i * IN + (i >= 4 ? 480000 : 0)), 600 + i * IN);
        buffer.pushSync(frame);
      }

      const out = drainSync(buffer);
      // The confirming frame starts at sample 600 + 12 * 960 = 12120; the partial frame is padded to 12480
      const restartAt = 600 + (4 + CONFIRM - 1) * IN;
      const pad = 480 - (restartAt % 480);
      assert.deepStrictEqual(out.samples.slice(0, restartAt + pad + 480), [...ramp(0, restartAt), ...silence(pad), ...ramp(restartAt, 480)]);
      const restartFrame = (restartAt + pad) / 480;
      assert.deepStrictEqual(out.pts.slice(0, restartFrame), frameStarts(0, restartFrame));
      assert.deepStrictEqual(out.pts.slice(restartFrame), frameStarts(restartAt + 480000, out.pts.length - restartFrame), 'Output continues at the input timestamp');
    });

    it('follows a backward jump beyond the drop limit without losing audio', () => {
      using buffer = AudioFrameBuffer.create(480, AV_SAMPLE_FMT_FLT, RATE, AV_CHANNEL_LAYOUT_MONO, 1);

      // A 1.5 s clip played twice with its timestamps starting at 0 both times
      feed(buffer, 0, 150, (i) => BigInt((i % 75) * IN));

      const out = drainSync(buffer);
      assert.deepStrictEqual(out.samples, ramp(0, 150 * IN), 'The second loop is kept');
      const restartFrame = ((75 + CONFIRM - 1) * IN) / 480;
      assert.deepStrictEqual(out.pts.slice(0, restartFrame), frameStarts(0, restartFrame));
      assert.deepStrictEqual(out.pts.slice(restartFrame), frameStarts((CONFIRM - 1) * IN, 300 - restartFrame), 'The timeline restarts behind');
    });

    it('fills gaps up to maxGapFill and turns larger ones into timestamp jumps', () => {
      const run = (gap: number, maxGapFill?: number): { samples: number[]; pts: bigint[] } => {
        using buffer = AudioFrameBuffer.create(480, AV_SAMPLE_FMT_FLT, RATE, AV_CHANNEL_LAYOUT_MONO, 1, maxGapFill === undefined ? {} : { maxGapFill });
        feed(buffer, 0, 10, (i) => BigInt(i * IN));
        feed(buffer, 10, 20, (i) => BigInt(i * IN + gap));
        return drainSync(buffer);
      };
      const zeros = (samples: number[]): number => samples.filter((value) => value === 0).length;

      const nearLimit = run(47520);
      assert.strictEqual(zeros(nearLimit.samples), 47520, 'A 0.99 s gap is filled by default');
      assert.deepStrictEqual(nearLimit.pts, frameStarts(0, nearLimit.pts.length));

      const beyondLimit = run(48480);
      assert.strictEqual(zeros(beyondLimit.samples), 0, 'A 1.01 s gap restarts the timeline');
      assert.ok(beyondLimit.pts.some((pts, i) => i > 0 && pts - beyondLimit.pts[i - 1] === 480n + 48480n));

      const noFill = run(2400, 0);
      assert.strictEqual(zeros(noFill.samples), 0, 'With maxGapFill 0 a 50 ms gap is not filled');
      assert.deepStrictEqual(noFill.samples, ramp(0, 30 * IN));
      const restartFrame = ((10 + CONFIRM - 1) * IN) / 480;
      assert.strictEqual(noFill.pts[restartFrame] - noFill.pts[restartFrame - 1], 480n + 2400n, 'The gap becomes a timestamp jump');
    });

    it('fills a long gap without holding its silence in memory', () => {
      using buffer = AudioFrameBuffer.create(480, AV_SAMPLE_FMT_FLT, RATE, AV_CHANNEL_LAYOUT_MONO, 1, { maxGapFill: 3600 });
      const fifo = (buffer as unknown as { fifo: { size: number; space: number } }).fifo;

      // A 300-sample lead puts both ends of the silence inside output frames
      using lead = rampFrame(300, 0n, 0);
      buffer.pushSync(lead);
      const gap = 60 * RATE + 100;
      for (let i = 0; i < 20; i++) {
        using frame = rampFrame(IN, BigInt(300 + i * IN + (i >= 10 ? gap : 0)), 300 + i * IN);
        buffer.pushSync(frame);
      }

      const input = 300 + 20 * IN;
      const total = input + gap;
      assert.strictEqual(buffer.size, total);
      assert.strictEqual(fifo.size, input, 'The FIFO holds the input only');
      // AVAudioFifo grows to twice what it has to hold
      assert.ok(fifo.size + fifo.space <= 2 * (input + IN), `FIFO allocated for ${fifo.size + fifo.space} samples`);

      // Output sample k: input before the silence, the silence, then the rest of the input
      const silenceAt = 300 + (10 + CONFIRM - 1) * IN;
      const expected = (k: number): number => (k < silenceAt ? k + 1 : k < silenceAt + gap ? 0 : k - gap + 1);
      let index = 0;
      let mismatch = -1;
      let frame;
      while ((frame = buffer.pullSync()) !== null) {
        using out = frame;
        assert.strictEqual(out.pts, BigInt(index), 'Output stays contiguous across the gap');
        const data = out.data![0];
        for (let i = 0; i < out.nbSamples && mismatch < 0; i++) {
          if (data.readFloatLE(i * 4) !== expected(index + i)) {
            mismatch = index + i;
          }
        }
        index += out.nbSamples;
        if (index + buffer.size !== total) {
          assert.fail(`After ${index} samples the buffer reports ${buffer.size} of ${total - index} left`);
        }
      }
      assert.strictEqual(mismatch, -1, `Output sample ${mismatch} is wrong`);
      assert.ok(fifo.size + fifo.space <= 2 * (input + IN), 'Pulling the silence does not grow the FIFO');
    });

    it('counts on from the last timestamp for frames without one', () => {
      using buffer = AudioFrameBuffer.create(480, AV_SAMPLE_FMT_FLT, RATE, AV_CHANNEL_LAYOUT_MONO, 1);

      using f0 = rampFrame(300, 4800n, 0);
      using f1 = rampFrame(300, AV_NOPTS_VALUE, 300);
      using f2 = rampFrame(300, AV_NOPTS_VALUE, 600);
      using f3 = rampFrame(300, 5700n, 900);
      for (const frame of [f0, f1, f2, f3]) {
        buffer.pushSync(frame);
      }

      const out = drainSync(buffer);
      assert.deepStrictEqual(out.pts, frameStarts(4800, 2));
      assert.deepStrictEqual(out.samples, ramp(0, 960));
    });

    it('counts samples from 0 when no frame carries a timestamp', () => {
      using buffer = AudioFrameBuffer.create(480, AV_SAMPLE_FMT_FLT, RATE, AV_CHANNEL_LAYOUT_MONO, 1);

      for (let i = 0; i < 4; i++) {
        using frame = rampFrame(300, AV_NOPTS_VALUE, i * 300);
        buffer.pushSync(frame);
      }

      const out = drainSync(buffer);
      assert.deepStrictEqual(out.pts, frameStarts(0, 2));
      assert.strictEqual(out.timeBase?.den, RATE, 'The frames time base is still used');
    });

    it('dates samples buffered before the first timestamp back from it', () => {
      using buffer = AudioFrameBuffer.create(480, AV_SAMPLE_FMT_FLT, RATE, AV_CHANNEL_LAYOUT_MONO, 1);

      using f0 = rampFrame(300, AV_NOPTS_VALUE, 0);
      using f1 = rampFrame(300, 48000n, 300);
      buffer.pushSync(f0);
      buffer.pushSync(f1);

      assert.deepStrictEqual(drainSync(buffer).pts, [47700n]);
    });

    it('restarts at the first timestamp once untimed samples went out', () => {
      for (const first of [100000, 960]) {
        using buffer = AudioFrameBuffer.create(480, AV_SAMPLE_FMT_FLT, RATE, AV_CHANNEL_LAYOUT_MONO, 1);

        // 1 s without timestamps, pulled on a made-up timeline from 0
        feed(buffer, 0, 50, () => AV_NOPTS_VALUE);
        const untimed = drainSync(buffer);
        feed(buffer, 50, 20, (i) => BigInt(first + (i - 50) * IN));
        const timed = drainSync(buffer);

        assert.deepStrictEqual(untimed.pts, frameStarts(0, 100));
        assert.deepStrictEqual(timed.pts, frameStarts(first, 40), `The timed input at ${first} starts a new timeline`);
        assert.deepStrictEqual([...untimed.samples, ...timed.samples], ramp(0, 70 * IN), 'Nothing is filled or dropped against the made-up timeline');
      }
    });

    it('converts input timestamps to the time base of the first frame', () => {
      using buffer = AudioFrameBuffer.create(480, AV_SAMPLE_FMT_FLT, RATE, AV_CHANNEL_LAYOUT_MONO, 1);
      const mpegTb = new Rational(1, 90000);

      // 480 samples at 48 kHz = 900 ticks at 90 kHz
      using f0 = rampFrame(480, 270000n, 0, mpegTb);
      using f1 = rampFrame(480, 270900n, 480, mpegTb);
      using f2 = rampFrame(480, 271800n, 960, mpegTb);
      // A frame in another time base is rescaled into the output time base
      using f3 = rampFrame(480, 3030n, 1440, new Rational(1, 1000));
      for (const frame of [f0, f1, f2, f3]) {
        buffer.pushSync(frame);
      }

      const out = drainSync(buffer);
      assert.deepStrictEqual(
        out.pts,
        Array.from({ length: 4 }, (_, i) => BigInt(270000 + i * 900)),
      );
      assert.strictEqual(out.timeBase?.den, 90000, 'Output frames carry the input time base');
      assert.deepStrictEqual(out.samples, ramp(0, 1920));
    });

    it('fills a gap measured in another time base', () => {
      using buffer = AudioFrameBuffer.create(480, AV_SAMPLE_FMT_FLT, RATE, AV_CHANNEL_LAYOUT_MONO, 1);
      const mpegTb = new Rational(1, 90000);

      // 960 samples at 48 kHz = 1800 ticks at 90 kHz; 50 ms gap = 4500 ticks
      for (let i = 0; i < 30; i++) {
        using frame = rampFrame(IN, BigInt(i * 1800 + (i >= 10 ? 4500 : 0)), i * IN, mpegTb);
        buffer.pushSync(frame);
      }

      const out = drainSync(buffer);
      assert.strictEqual(out.samples.filter((value) => value === 0).length, 2400);
      assert.deepStrictEqual(
        out.pts,
        Array.from({ length: out.pts.length }, (_, i) => BigInt(i * 900)),
      );
    });

    it('times the silence-padded last frame from the buffered samples', async () => {
      using buffer = AudioFrameBuffer.create(480, AV_SAMPLE_FMT_FLT, RATE, AV_CHANNEL_LAYOUT_MONO, 1);

      using f0 = rampFrame(700, 4800n, 0);
      await buffer.push(f0);

      using full = await buffer.pull();
      assert.strictEqual(full!.pts, 4800n);

      using partial = await buffer.pullPartial();
      assert.strictEqual(partial!.pts, 5280n, 'Partial frame starts at its first buffered sample');
      assert.strictEqual(buffer.size, 0);

      // Input that continues after the flush is timed after the padded frame
      using f1 = rampFrame(480, 5500n, 700);
      await buffer.push(f1);
      using next = await buffer.pull();
      assert.strictEqual(next!.pts, 5760n);
    });

    it('produces the same timeline with the async and sync variants', async () => {
      // Gap, overlap, forward and backward restart, untimed frames, irregular frame sizes
      const schedule: { size: number; pts: bigint }[] = [];
      let pts = 1000;
      const add = (count: number, size: number, step: number | null): void => {
        for (let i = 0; i < count; i++) {
          schedule.push({ size, pts: step === null ? AV_NOPTS_VALUE : BigInt(pts) });
          pts += size;
        }
        if (step !== null) {
          pts += step;
        }
      };
      add(15, 700, 2000);
      add(20, 500, -1500);
      add(20, IN, 900000);
      add(20, 300, -950000);
      add(15, IN, 0);
      add(5, IN, null);

      const frames = (): Frame[] => {
        let index = 0;
        return schedule.map(({ size, pts }) => {
          const frame = rampFrame(size, pts, index);
          index += size;
          return frame;
        });
      };

      using asyncBuffer = AudioFrameBuffer.create(480, AV_SAMPLE_FMT_FLT, RATE, AV_CHANNEL_LAYOUT_MONO, 1);
      for (const frame of frames()) {
        await asyncBuffer.push(frame);
        frame.free();
      }
      const fromAsync = await drainAsync(asyncBuffer);

      using syncBuffer = AudioFrameBuffer.create(480, AV_SAMPLE_FMT_FLT, RATE, AV_CHANNEL_LAYOUT_MONO, 1);
      for (const frame of frames()) {
        syncBuffer.pushSync(frame);
        frame.free();
      }
      const fromSync = drainSync(syncBuffer);

      assert.deepStrictEqual(fromAsync.pts, fromSync.pts);
      assert.deepStrictEqual(fromAsync.samples, fromSync.samples);
      assert.strictEqual(asyncBuffer.size, syncBuffer.size);
      assert.ok(fromSync.samples.includes(0), 'The gap was filled');
      assert.ok(
        fromSync.pts.some((value, i) => i > 0 && value < fromSync.pts[i - 1]),
        'The timeline restarted behind',
      );
    });

    it('trims planar frames on every plane', () => {
      using buffer = AudioFrameBuffer.create(480, AV_SAMPLE_FMT_FLTP, RATE, AV_CHANNEL_LAYOUT_STEREO, 2);

      for (let i = 0; i < 30; i++) {
        using frame = createAudioFrame(IN, AV_SAMPLE_FMT_FLTP, RATE, AV_CHANNEL_LAYOUT_STEREO, BigInt(i * IN - (i >= 10 ? 1440 : 0)));
        frame.timeBase = TB;
        const [left, right] = frame.data!;
        for (let s = 0; s < IN; s++) {
          left.writeFloatLE(i * IN + s + 1, s * 4);
          right.writeFloatLE(-(i * IN + s + 1), s * 4);
        }
        buffer.pushSync(frame);
      }

      const left: number[] = [];
      const right: number[] = [];
      let frame;
      while ((frame = buffer.pullSync()) !== null) {
        using out = frame;
        const [l, r] = out.data!;
        for (let s = 0; s < out.nbSamples; s++) {
          left.push(l.readFloatLE(s * 4));
          right.push(r.readFloatLE(s * 4));
        }
      }

      const cut = (10 + CONFIRM - 1) * IN;
      assert.deepStrictEqual(left, [...ramp(0, cut), ...ramp(cut + 1440, left.length - cut)]);
      assert.deepStrictEqual(
        right,
        left.map((value) => -value),
      );
    });

    it('keeps the stamping position in step with the FIFO when a write fails', () => {
      using buffer = AudioFrameBuffer.create(480, AV_SAMPLE_FMT_FLT, RATE, AV_CHANNEL_LAYOUT_MONO, 1);

      // A 50 ms gap after frame 9 (frame 19 confirms it, so its push adds silence
      // first), then a 10 s jump after frame 24 that restarts the timeline at frame 34
      const pts = (i: number): bigint => BigInt(i * IN + (i >= 10 ? 2400 : 0) + (i >= 25 ? 480000 : 0));
      feed(buffer, 0, 10 + CONFIRM - 1, pts);
      const fifo = (buffer as unknown as { fifo: { writeSync: (...args: unknown[]) => number } }).fifo;
      const writeSync = fifo.writeSync.bind(fifo);
      // The silence is kept, the frame's samples fail with AVERROR(ENOMEM)
      fifo.writeSync = () => -12;
      assert.throws(() => feed(buffer, 10 + CONFIRM - 1, 1, pts));
      fifo.writeSync = writeSync;

      // The lost frame leaves the next one 20 ms late: within the tolerance
      feed(buffer, 10 + CONFIRM, 25, pts);
      const out = drainSync(buffer);
      const lost = 10 + CONFIRM - 1;
      assert.deepStrictEqual(out.samples.slice(0, lost * IN + 2400 + IN), [...ramp(0, lost * IN), ...silence(2400), ...ramp((lost + 1) * IN, IN)]);
      const restart = 25 + CONFIRM - 1;
      const frame = out.samples.findIndex((value, i) => i % 480 === 0 && value === restart * IN + 1) / 480;
      assert.ok(frame > 0, 'The restart lands on a frame boundary');
      assert.strictEqual(out.pts[frame], pts(restart), 'The restart is stamped where its samples are in the FIFO');
    });

    it('stamps by sample count from 0 with timestamps: samples', () => {
      using buffer = AudioFrameBuffer.create(480, AV_SAMPLE_FMT_FLT, RATE, AV_CHANNEL_LAYOUT_MONO, 1, { timestamps: 'samples' });

      feed(buffer, 0, 30, (i) => BigInt(96000 + i * IN + (i >= 10 ? 2400 : 0)));

      const out = drainSync(buffer);
      assert.deepStrictEqual(out.pts, frameStarts(0, 60), 'Input timestamps are ignored');
      assert.deepStrictEqual(out.samples, ramp(0, 30 * IN), 'Nothing is filled or dropped');
      assert.strictEqual(out.timeBase?.den, RATE);
    });

    it('rejects out-of-range options', () => {
      for (const options of [{ maxGapFill: -1 }, { maxGapFill: Number.NaN }, { maxGapFill: Infinity }, { timestamps: 'pts' as 'input' }]) {
        assert.throws(() => AudioFrameBuffer.create(480, AV_SAMPLE_FMT_FLT, RATE, AV_CHANNEL_LAYOUT_MONO, 1, options), RangeError);
      }
    });

    it('starts a new timeline after reset', () => {
      using buffer = AudioFrameBuffer.create(480, AV_SAMPLE_FMT_FLT, RATE, AV_CHANNEL_LAYOUT_MONO, 1);

      using f0 = rampFrame(480, 1000n, 0);
      buffer.pushSync(f0);
      buffer.reset();

      using f1 = rampFrame(480, 96000n, 0);
      buffer.pushSync(f1);
      assert.deepStrictEqual(drainSync(buffer).pts, [96000n]);
    });
  });
});
