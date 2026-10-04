import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AV_NOPTS_VALUE, Demuxer, Muxer } from '../src/index.js';
import { getInputFile, prepareTestEnvironment } from './index.js';

import type { MuxerOptions, Packet, Stream } from '../src/index.js';

prepareTestEnvironment();

const INT_MAX = 0x7fffffffn;
const FRAGMENTED = '+frag_keyframe+empty_moov+default_base_moof';

interface Source {
  input: Demuxer;
  video: Stream;
  audio: Stream;
  videoPacket: Packet;
  audioPacket: Packet;
}

/**
 * Open demux.mp4 and keep its first video keyframe and first audio packet as templates.
 * Both streams use a time base the mp4 muxer keeps (1/15360, 1/44100), so source ticks
 * are output ticks.
 */
async function openSource(): Promise<Source> {
  const input = await Demuxer.open(getInputFile('demux.mp4'));
  const video = input.video()!;
  const audio = input.audio()!;
  let videoPacket: Packet | undefined;
  let audioPacket: Packet | undefined;
  for await (const packet of input.packets()) {
    if (!packet) break;
    if (packet.streamIndex === video.index && packet.isKeyframe && !videoPacket) videoPacket = packet.clone()!;
    if (packet.streamIndex === audio.index && !audioPacket) audioPacket = packet.clone()!;
    if (videoPacket && audioPacket) break;
  }
  assert.ok(videoPacket && audioPacket, 'test input must provide a video keyframe and an audio packet');
  return { input, video, audio, videoPacket, audioPacket };
}

async function closeSource(source: Source): Promise<void> {
  source.videoPacket.free();
  source.audioPacket.free();
  await source.input.close();
}

function sink(): { write: (data: Buffer) => number; chunks: Buffer[] } {
  const chunks: Buffer[] = [];
  return {
    chunks,
    write: (data: Buffer) => {
      chunks.push(Buffer.from(data));
      return data.length;
    },
  };
}

function stamp(packet: Packet, dts: bigint, duration?: bigint): Packet {
  packet.dts = dts;
  packet.pts = dts;
  if (duration !== undefined) packet.duration = duration;
  return packet;
}

function seconds(stream: Stream, value: number): bigint {
  return BigInt(Math.round((value * stream.timeBase.den) / stream.timeBase.num));
}

/** A DTS (PTS = DTS), or explicit timestamps for a packet. */
type Timestamps = bigint | { dts: bigint; pts: bigint };

/**
 * Write video packets at the given timestamps into a single-stream muxer (direct write path).
 * Returns the error of the first rejected write, if any.
 */
async function writeVideo(source: Source, dtsList: Timestamps[], options: MuxerOptions = {}, sync = false): Promise<Error | undefined> {
  const out = sink();
  const muxerOptions: MuxerOptions = { format: 'mp4', exitOnError: false, options: { movflags: FRAGMENTED }, ...options };
  const output = sync ? Muxer.openSync(out, { ...muxerOptions, format: muxerOptions.format! }) : await Muxer.open(out, { ...muxerOptions, format: muxerOptions.format! });
  const index = output.addStream(source.video);
  let error: Error | undefined;
  try {
    for (const dts of dtsList) {
      if (typeof dts === 'bigint') {
        stamp(source.videoPacket, dts);
      } else {
        source.videoPacket.dts = dts.dts;
        source.videoPacket.pts = dts.pts;
      }
      if (sync) output.writePacketSync(source.videoPacket, index);
      else await output.writePacket(source.videoPacket, index);
      if (dts === dtsList[0] && muxerOptions.format === 'mp4') {
        assert.deepEqual({ ...output.getStream(index)!.timeBase }, { ...source.video.timeBase }, 'source ticks must equal output ticks');
      }
    }
  } catch (e) {
    error = e as Error;
  } finally {
    if (sync) output.closeSync();
    else await output.close();
  }
  assert.ok(source.videoPacket.size > 0, 'the caller keeps ownership of its packet');
  return error;
}

/** A packet passed to the muxer at a point in real time: DTS (PTS = DTS) and time in ms on the muxer's clock. */
interface Timed {
  dts: bigint;
  at: number;
  /** Stamp the timestamp as PTS only and leave the DTS unset. */
  ptsOnly?: boolean;
}

/** Packets 40 ms apart in media and in real time, starting at `start` seconds of media and `at` ms. */
function paced(stream: Stream, start: number, count: number, at = 0): Timed[] {
  return Array.from({ length: count }, (_, i) => ({ dts: seconds(stream, start + i * 0.04), at: at + i * 40 }));
}

/** Record the DTS of every packet handed to av_interleaved_write_frame (both variants). */
function recordDts(output: Muxer): bigint[] {
  const written: bigint[] = [];
  const formatContext = output.getFormatContext();
  const write = formatContext.interleavedWriteFrame.bind(formatContext);
  const writeSync = formatContext.interleavedWriteFrameSync.bind(formatContext);
  formatContext.interleavedWriteFrame = async (pkt: Packet | null) => {
    if (pkt) written.push(pkt.dts);
    return write(pkt);
  };
  formatContext.interleavedWriteFrameSync = (pkt: Packet | null) => {
    if (pkt) written.push(pkt.dts);
    return writeSync(pkt);
  };
  return written;
}

/**
 * Write video packets into a single-stream muxer (no background write queue) with
 * dtsForwardThreshold 10 s, each at its time on a clock the test drives.
 * Returns the error of the first rejected write and the DTS libavformat received.
 */
async function writeTimed(source: Source, packets: Timed[], options: MuxerOptions = {}, sync = false): Promise<{ error?: Error; written: bigint[] }> {
  const muxerOptions: MuxerOptions = { format: 'mp4', exitOnError: false, options: { movflags: FRAGMENTED }, dtsForwardThreshold: 10, ...options };
  const output = sync
    ? Muxer.openSync(sink(), { ...muxerOptions, format: muxerOptions.format! })
    : await Muxer.open(sink(), { ...muxerOptions, format: muxerOptions.format! });
  let now = 0;
  output.setClock(() => now);
  const written = recordDts(output);
  const index = output.addStream(source.video);
  let error: Error | undefined;
  try {
    for (const { dts, at, ptsOnly } of packets) {
      now = at;
      stamp(source.videoPacket, dts);
      if (ptsOnly) source.videoPacket.dts = AV_NOPTS_VALUE;
      if (sync) output.writePacketSync(source.videoPacket, index);
      else await output.writePacket(source.videoPacket, index);
    }
  } catch (e) {
    error = e as Error;
  } finally {
    if (sync) output.closeSync();
    else await output.close();
  }
  return { error, written };
}

/**
 * Write video from 2 s to `videoEnd` s into a two-stream fragmented mp4, then the first
 * audio packets starting at `audioStart` s, then close. Returns every write and close error.
 */
async function writeLateAudio(
  source: Source,
  { videoEnd = 30, audioStart = 0, audioPackets = 1, movflags = FRAGMENTED, sync = false } = {},
): Promise<{ errors: string[]; bytes: number }> {
  const out = sink();
  const muxerOptions = { format: 'mp4', exitOnError: false, options: { movflags } } as const;
  const output = sync ? Muxer.openSync(out, muxerOptions) : await Muxer.open(out, muxerOptions);
  const videoIndex = output.addStream(source.video);
  const audioIndex = output.addStream(source.audio);
  const errors: string[] = [];
  const write = async (packet: Packet, index: number): Promise<void> => {
    try {
      if (sync) output.writePacketSync(packet, index);
      else await output.writePacket(packet, index);
    } catch (e) {
      errors.push((e as Error).message);
    }
  };

  for (let i = 0; 2 + i * 0.04 < videoEnd; i++) {
    await write(stamp(source.videoPacket, seconds(source.video, 2 + i * 0.04)), videoIndex);
  }
  for (let i = 0; i < audioPackets; i++) {
    await write(stamp(source.audioPacket, seconds(source.audio, audioStart) + BigInt(i) * 1024n, 1024n), audioIndex);
  }
  try {
    if (sync) output.closeSync();
    else await output.close();
  } catch (e) {
    errors.push((e as Error).message);
  }
  return { errors, bytes: out.chunks.reduce((sum, chunk) => sum + chunk.length, 0) };
}

describe('Muxer timestamp guards', () => {
  describe('mov sample duration limit', () => {
    for (const sync of [false, true]) {
      it(`accepts a DTS step of INT_MAX-1 ticks and rejects INT_MAX (${sync ? 'sync' : 'async'})`, async () => {
        const source = await openSource();
        try {
          const accepted = await writeVideo(source, [0n, INT_MAX - 1n, INT_MAX - 1n + 512n], {}, sync);
          assert.equal(accepted, undefined, `a step below INT_MAX must be written: ${accepted?.message}`);

          const rejected = await writeVideo(source, [0n, INT_MAX], {}, sync);
          assert.match(rejected?.message ?? '', /Timestamp discontinuity on output stream 0: DTS jumped forward 2147483647 ticks/);
        } finally {
          await closeSource(source);
        }
      });
    }

    it('rejects a packet duration of INT_MAX ticks', async () => {
      const source = await openSource();
      try {
        const out = sink();
        const output = await Muxer.open(out, { format: 'mp4', exitOnError: false, options: { movflags: FRAGMENTED } });
        const index = output.addStream(source.video);
        await output.writePacket(stamp(source.videoPacket, 0n, 512n), index);
        await assert.rejects(output.writePacket(stamp(source.videoPacket, 512n, INT_MAX), index), /packet duration is 2147483647 ticks/);
        await output.close();
      } finally {
        await closeSource(source);
      }
    });

    it('keeps measuring steps across a packet without DTS', async () => {
      const source = await openSource();
      try {
        source.videoPacket.duration = 512n;
        // mux.c fills the missing DTS from the PTS buffer: 512 here (reorder delay 2,
        // duration 512). The next step is measured against the last known DTS, 0.
        const afterGap = await writeVideo(source, [0n, { dts: AV_NOPTS_VALUE, pts: 1536n }, 512n + INT_MAX], { exitOnError: true });
        assert.match(afterGap?.message ?? '', /DTS jumped forward 2147484159 ticks/);

        // The packet without DTS is measured by its PTS, which bounds the DTS mux.c fills in.
        const itself = await writeVideo(source, [0n, { dts: AV_NOPTS_VALUE, pts: INT_MAX }], { exitOnError: true });
        assert.match(itself?.message ?? '', /DTS jumped forward 2147483647 ticks/);

        const normal = await writeVideo(source, [0n, { dts: AV_NOPTS_VALUE, pts: 1536n }, 1024n, 1536n], { exitOnError: true });
        assert.equal(normal, undefined, `a packet without DTS must not disturb the timeline: ${normal?.message}`);
      } finally {
        await closeSource(source);
      }
    });

    it('does not limit formats outside the mov family', async () => {
      const source = await openSource();
      try {
        const error = await writeVideo(source, [0n, INT_MAX, INT_MAX + 512n], { format: 'matroska', options: {} });
        assert.equal(error, undefined, `matroska must take the step: ${error?.message}`);
      } finally {
        await closeSource(source);
      }
    });

    it('surfaces the rejection from the background write queue (two streams)', async () => {
      const source = await openSource();
      try {
        const out = sink();
        const output = await Muxer.open(out, { format: 'mp4', exitOnError: false, options: { movflags: FRAGMENTED } });
        const videoIndex = output.addStream(source.video);
        const audioIndex = output.addStream(source.audio);

        let error: unknown;
        try {
          await output.writePacket(stamp(source.videoPacket, 0n), videoIndex);
          await output.writePacket(stamp(source.audioPacket, 0n), audioIndex);
          await output.writePacket(stamp(source.videoPacket, INT_MAX), videoIndex);
          // The worker rejects asynchronously; keep both streams moving until it shows.
          for (let i = 1; i <= 20; i++) {
            await output.writePacket(stamp(source.audioPacket, BigInt(i) * 1024n), audioIndex);
            await output.writePacket(stamp(source.videoPacket, INT_MAX + BigInt(i) * 512n), videoIndex);
          }
        } catch (e) {
          error = e;
        }
        await output.close().catch((e: unknown) => (error ??= e));
        assert.match(String(error), /Timestamp discontinuity on output stream 0/);
      } finally {
        await closeSource(source);
      }
    });
  });

  describe('late stream start without edit list', () => {
    for (const sync of [false, true]) {
      const mode = sync ? 'sync' : 'async';

      it(`rejects a late stream's first packet that ends before the output's start (${mode})`, async () => {
        const source = await openSource();
        try {
          // libavformat writes the video once its queue spans 10 s and starts the output at
          // 2 s; movenc would put the audio packet there with a negative duration and abort
          // the process (movenc.c:1255) in the trailer.
          const { errors } = await writeLateAudio(source, { sync });
          assert.deepEqual(errors, [
            'Timestamp discontinuity on output stream 1: its first packet ends 1.977s before the start of output stream 0, which mp4 without an edit list cannot store',
          ]);
        } finally {
          await closeSource(source);
        }
      });

      it(`accepts a late stream at the output's start, and any stream while libavformat holds the others (${mode})`, async () => {
        const source = await openSource();
        try {
          const atStart = await writeLateAudio(source, { audioStart: 2, audioPackets: 3, sync });
          assert.deepEqual(atStart.errors, [], 'a late stream starting at the start must pass');

          const early = await writeLateAudio(source, { videoEnd: 8, audioPackets: 3, sync });
          assert.deepEqual(early.errors, [], 'libavformat has written nothing yet and starts the output at the audio');
        } finally {
          await closeSource(source);
        }
      });
    }

    it('leaves outputs with an edit list alone', async () => {
      const source = await openSource();
      try {
        const { errors, bytes } = await writeLateAudio(source, { movflags: `${FRAGMENTED}+delay_moov` });
        assert.deepEqual(errors, []);
        assert.ok(bytes > 0);
      } finally {
        await closeSource(source);
      }
    });
  });

  describe('discardOnClose', () => {
    for (const sync of [false, true]) {
      it(`makes close() skip the trailer (${sync ? 'sync' : 'async'})`, async () => {
        const source = await openSource();
        try {
          const bytesAtClose = async (discard: boolean): Promise<[number, number]> => {
            const out = sink();
            const bytes = (): number => out.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
            const options = { format: 'mp4', options: { movflags: FRAGMENTED } } as const;
            const output = sync ? Muxer.openSync(out, options) : await Muxer.open(out, options);
            const index = output.addStream(source.video);
            for (let i = 0; i < 10; i++) {
              if (sync) output.writePacketSync(stamp(source.videoPacket, seconds(source.video, i)), index);
              else await output.writePacket(stamp(source.videoPacket, seconds(source.video, i)), index);
            }
            const before = bytes();
            if (discard) output.discardOnClose();
            if (sync) output.closeSync();
            else await output.close();
            return [before, bytes()];
          };

          const [before, after] = await bytesAtClose(false);
          assert.ok(after > before, 'the trailer flushes the last fragment');
          const [discardedBefore, discardedAfter] = await bytesAtClose(true);
          assert.equal(discardedAfter, discardedBefore, 'nothing is written on close');
        } finally {
          await closeSource(source);
        }
      });
    }
  });

  describe('dtsBackwardThreshold', () => {
    for (const sync of [false, true]) {
      it(`keeps 2s and 30s backward jumps (camera clock wobble) when unset (${sync ? 'sync' : 'async'})`, async () => {
        const source = await openSource();
        try {
          for (const back of [2, 30]) {
            const start = seconds(source.video, 60);
            const error = await writeVideo(source, [start, start - seconds(source.video, back)], {}, sync);
            assert.equal(error, undefined, `a ${back}s jump must be clamped, not rejected: ${error?.message}`);
          }
          const start = seconds(source.video, 60);
          const disabled = await writeVideo(source, [start, start - seconds(source.video, 30)], { dtsBackwardThreshold: 0 }, sync);
          assert.equal(disabled, undefined, '0 disables the check');
        } finally {
          await closeSource(source);
        }
      });

      it(`rejects only jumps beyond the threshold (${sync ? 'sync' : 'async'})`, async () => {
        const source = await openSource();
        try {
          const start = seconds(source.video, 60);
          const nine = await writeVideo(source, [start, start - seconds(source.video, 9)], { dtsBackwardThreshold: 10 }, sync);
          assert.equal(nine, undefined, `9s must be clamped: ${nine?.message}`);

          const eleven = await writeVideo(source, [start, start - seconds(source.video, 11)], { dtsBackwardThreshold: 10 }, sync);
          assert.match(eleven?.message ?? '', /Timestamp discontinuity on output stream 0: DTS jumped back 11\.000s, more than dtsBackwardThreshold \(10s\)/);
        } finally {
          await closeSource(source);
        }
      });
    }

    it('rejects even with exitOnError disabled and for non-mov formats', async () => {
      const source = await openSource();
      try {
        const start = seconds(source.video, 60);
        const error = await writeVideo(source, [start, start - seconds(source.video, 20)], { format: 'matroska', options: {}, dtsBackwardThreshold: 10 });
        assert.match(error?.message ?? '', /DTS jumped back/);
      } finally {
        await closeSource(source);
      }
    });

    it('rejects invalid thresholds', () => {
      for (const value of [-1, NaN, Infinity, '10' as unknown as number]) {
        assert.throws(() => Muxer.openSync({ write: (data: Buffer) => data.length }, { format: 'mp4', dtsBackwardThreshold: value }), RangeError);
      }
      for (const value of [0, 2.5, 10]) {
        Muxer.openSync({ write: (data: Buffer) => data.length }, { format: 'mp4', dtsBackwardThreshold: value }).closeSync();
      }
    });
  });

  describe('dtsForwardThreshold', () => {
    for (const sync of [false, true]) {
      const mode = sync ? 'sync' : 'async';

      it(`rejects a forward jump that real time does not explain, before it reaches libavformat (${mode})`, async () => {
        const source = await openSource();
        try {
          const before = paced(source.video, 0, 5);
          const spike = { dts: seconds(source.video, 1800.2), at: 200 };
          const { error, written } = await writeTimed(source, [...before, spike, ...paced(source.video, 1800.24, 3, 240)], {}, sync);
          assert.match(
            error?.message ?? '',
            /^Timestamp discontinuity on output stream 0: DTS jumped forward 1800\.040s while 0\.040s passed, more than dtsForwardThreshold \(10s\)$/,
          );
          assert.deepEqual(
            written,
            before.map((p) => p.dts),
            'the jump must never reach libavformat',
          );
        } finally {
          await closeSource(source);
        }
      });

      it(`accepts a gap that comes with the matching wait, and a burst after a stall (${mode})`, async () => {
        const source = await openSource();
        try {
          // 30 s without packets, then the stream continues on the same timeline
          const gap = await writeTimed(source, [...paced(source.video, 0, 5), ...paced(source.video, 30.2, 5, 30_200)], {}, sync);
          assert.equal(gap.error, undefined, `a real gap must pass: ${gap.error?.message}`);
          assert.equal(gap.written.length, 10);

          // 15 s stall, then the held-up 15 s of media arrive at once and the stream goes on
          const burst = await writeTimed(
            source,
            [...paced(source.video, 0, 5), ...paced(source.video, 0.2, 375, 15_200).map((p) => ({ ...p, at: 15_200 })), ...paced(source.video, 15.2, 5, 15_240)],
            {},
            sync,
          );
          assert.equal(burst.error, undefined, `a burst after a stall must pass: ${burst.error?.message}`);
        } finally {
          await closeSource(source);
        }
      });

      it(`accepts the end of a gap after frames a parser or encoder held back during it (${mode})`, async () => {
        const source = await openSource();
        try {
          // A 15 s gap. The 60 frames from before it leave only once input resumes, one per
          // new frame, so they absorb the wait and the first frame after the gap steps
          // forward 15 s within 40 ms against them.
          const heldBack = paced(source.video, 0.2, 60, 15_200);
          const after = paced(source.video, 15.2 + 2.4, 5, 15_200 + 60 * 40);
          const { error, written } = await writeTimed(source, [...paced(source.video, 0, 5), ...heldBack, ...after], {}, sync);
          assert.equal(error, undefined, `the end of a real gap must pass: ${error?.message}`);
          assert.equal(written.length, 70);

          // A jump right after such frames is still caught.
          const jump = await writeTimed(source, [...paced(source.video, 0, 5), ...heldBack, { dts: seconds(source.video, 1800), at: 17_600 }], {}, sync);
          assert.match(jump.error?.message ?? '', /DTS jumped forward 1797\.440s while 0\.040s passed/);
        } finally {
          await closeSource(source);
        }
      });

      it(`rejects only a lead beyond the threshold (${mode})`, async () => {
        const source = await openSource();
        try {
          const below = await writeTimed(source, [...paced(source.video, 0, 3), { dts: seconds(source.video, 0.08 + 9.99 + 0.5), at: 580 }], {}, sync);
          assert.equal(below.error, undefined, `a lead of 9.99 s must pass: ${below.error?.message}`);

          const above = await writeTimed(source, [...paced(source.video, 0, 3), { dts: seconds(source.video, 0.08 + 10.01 + 0.5), at: 580 }], {}, sync);
          assert.match(above.error?.message ?? '', /DTS jumped forward 10\.510s while 0\.500s passed, more than dtsForwardThreshold \(10s\)/);

          const off = await writeTimed(source, [...paced(source.video, 0, 3), { dts: seconds(source.video, 1800), at: 120 }], { dtsForwardThreshold: 0 }, sync);
          assert.equal(off.error, undefined, '0 disables the check');
        } finally {
          await closeSource(source);
        }
      });

      it(`never checks a stream's first packet (${mode})`, async () => {
        const source = await openSource();
        try {
          const { error, written } = await writeTimed(source, paced(source.video, 3600, 3), {}, sync);
          assert.equal(error, undefined, `nothing precedes the first packet: ${error?.message}`);
          assert.equal(written.length, 3);
        } finally {
          await closeSource(source);
        }
      });

      it(`measures packets without DTS by their PTS (${mode})`, async () => {
        const source = await openSource();
        try {
          const ptsOnly = (packets: Timed[]): Timed[] => packets.map((p) => ({ ...p, ptsOnly: true }));
          const before = ptsOnly(paced(source.video, 0, 50));
          const jump = await writeTimed(source, [...before, ...ptsOnly([{ dts: seconds(source.video, 1802), at: 2000 }])], {}, sync);
          assert.match(jump.error?.message ?? '', /DTS jumped forward 1800\.040s while 0\.040s passed, more than dtsForwardThreshold \(10s\)/);
          assert.equal(jump.written.length, 50, 'the jump must never reach libavformat');

          const gap = await writeTimed(source, ptsOnly([...paced(source.video, 0, 5), ...paced(source.video, 30.2, 5, 30_200)]), {}, sync);
          assert.equal(gap.error, undefined, `a real gap must pass: ${gap.error?.message}`);
        } finally {
          await closeSource(source);
        }
      });
    }

    it('checks each stream against its own packets and surfaces a rejection from the write queue', async () => {
      const source = await openSource();
      try {
        const output = await Muxer.open(sink(), { format: 'mp4', exitOnError: false, options: { movflags: FRAGMENTED }, dtsForwardThreshold: 10 });
        let now = 0;
        output.setClock(() => now);
        const written = recordDts(output);
        const videoIndex = output.addStream(source.video);
        const audioIndex = output.addStream(source.audio);
        const audioTicks = (s: number): bigint => seconds(source.audio, s);

        let error: unknown;
        try {
          // The audio's first packet lies an hour ahead of the video: not a jump of either stream.
          for (let i = 0; i < 5; i++) {
            now = i * 40;
            await output.writePacket(stamp(source.videoPacket, seconds(source.video, i * 0.04)), videoIndex);
            await output.writePacket(stamp(source.audioPacket, audioTicks(3600 + i * 0.04)), audioIndex);
          }
          now = 200;
          await output.writePacket(stamp(source.videoPacket, seconds(source.video, 1800)), videoIndex);
          // The worker rejects asynchronously; keep the audio moving until it shows.
          for (let i = 6; i <= 30; i++) {
            now = i * 40;
            await output.writePacket(stamp(source.audioPacket, audioTicks(3600 + i * 0.04)), audioIndex);
          }
        } catch (e) {
          error = e;
        }
        await output.close().catch((e: unknown) => (error ??= e));
        assert.match(String(error), /Timestamp discontinuity on output stream 0: DTS jumped forward 1799\.840s while 0\.040s passed/);
        assert.ok(!written.includes(seconds(source.video, 1800)), 'the jump must never reach libavformat');
      } finally {
        await closeSource(source);
      }
    });

    it('measures real time when a packet is passed in, not when the pre-mux queue writes it', async () => {
      for (const jump of [false, true]) {
        const source = await openSource();
        try {
          const output = await Muxer.open(sink(), { format: 'mp4', exitOnError: false, options: { movflags: FRAGMENTED }, dtsForwardThreshold: 10 });
          let now = 0;
          output.setClock(() => now);
          const written = recordDts(output);
          const videoIndex = output.addStream(source.video);
          const audioIndex = output.addStream(source.audio);

          // Hold the header write open: packets passed in meanwhile wait in the pre-mux queue.
          const formatContext = output.getFormatContext();
          const writeHeader = formatContext.writeHeader.bind(formatContext);
          const gate = Promise.withResolvers<void>();
          formatContext.writeHeader = async (options) => {
            await gate.promise;
            return writeHeader(options);
          };

          let error: unknown;
          try {
            const first = output.writePacket(stamp(source.audioPacket, 0n), audioIndex);
            await output.writePacket(stamp(source.videoPacket, 0n), videoIndex);
            // A real 30 s gap: both packets leave the queue together, long after they came in.
            now = 30_000;
            await output.writePacket(stamp(source.videoPacket, seconds(source.video, 30)), videoIndex);
            now = 30_040;
            await output.writePacket(stamp(source.videoPacket, seconds(source.video, jump ? 1800 : 30.04)), videoIndex);
            gate.resolve();
            await first;
          } catch (e) {
            error = e;
          }
          await output.close().catch((e: unknown) => (error ??= e));
          if (jump) {
            assert.match(String(error), /DTS jumped forward 1770\.000s while 0\.040s passed/);
          } else {
            assert.equal(error, undefined, `the gap came with its wait: ${String(error)}`);
            assert.ok(written.includes(seconds(source.video, 30.04)));
          }
        } finally {
          await closeSource(source);
        }
      }
    });

    it('rejects invalid thresholds', () => {
      for (const value of [-1, NaN, Infinity, '10' as unknown as number]) {
        assert.throws(
          () => Muxer.openSync({ write: (data: Buffer) => data.length }, { format: 'mp4', dtsForwardThreshold: value }),
          /^RangeError: dtsForwardThreshold must be/,
        );
      }
    });
  });

  describe('clamped packet duration', () => {
    /** Record DTS and duration of every packet handed to av_interleaved_write_frame. */
    function recordWrites(output: Muxer): [bigint, bigint][] {
      const written: [bigint, bigint][] = [];
      const formatContext = output.getFormatContext();
      const write = formatContext.interleavedWriteFrame.bind(formatContext);
      formatContext.interleavedWriteFrame = async (pkt: Packet | null) => {
        if (pkt) written.push([pkt.dts, pkt.duration]);
        return write(pkt);
      };
      return written;
    }

    it('shrinks a clamped packet to the clamped step', async () => {
      const source = await openSource();
      try {
        const output = await Muxer.open(sink(), { format: 'mp4', options: { movflags: FRAGMENTED } });
        const index = output.addStream(source.video);
        const written = recordWrites(output);
        for (const dts of [0n, 512n, 1024n, 1536n - 5000n, 2048n]) {
          await output.writePacket(stamp(source.videoPacket, dts, 512n), index);
        }
        await output.close();

        // movenc continues a track at DTS + duration after a fragment flush, so the
        // clamped packet must end where the next clamped DTS would start.
        assert.deepEqual(written, [
          [0n, 512n],
          [512n, 512n],
          [1024n, 512n],
          [1025n, 1n],
          [2048n, 512n],
        ]);
      } finally {
        await closeSource(source);
      }
    });

    it('keeps the duration where equal DTS are allowed (AVFMT_TS_NONSTRICT)', async () => {
      const source = await openSource();
      try {
        const output = await Muxer.open(sink(), { format: 'matroska' });
        const index = output.addStream(source.video);
        const written = recordWrites(output);
        for (const dts of [15360n, 15360n - 5000n]) {
          await output.writePacket(stamp(source.videoPacket, dts, 512n), index);
        }
        await output.close();

        // 1/1000 output time base: 1000 ms, clamped to an equal DTS, duration 33 ms kept
        assert.deepEqual(written, [
          [1000n, 33n],
          [1000n, 33n],
        ]);
      } finally {
        await closeSource(source);
      }
    });
  });
});
