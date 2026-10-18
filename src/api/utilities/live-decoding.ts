import { availableParallelism } from 'node:os';

import { FF_THREAD_SLICE } from '../../constants/constants.js';

import type { CodecContext } from '../../lib/codec-context.js';

/**
 * Most frame threads a live software decoder uses.
 *
 * @internal
 */
const MAX_LIVE_FRAME_THREADS = 4;

/**
 * Choose low-latency threading for a live video decoder; a Decoder `configure` callback.
 *
 * Frame threading holds back one frame per thread before the first output, up to
 * 16 with the automatic thread count (~0.6 s at 25 fps). Hardware decoding gets
 * slice threading, which costs it nothing. Software decoding keeps frame threading
 * with at most 4 threads: slice threading only splits a frame into its slices, and
 * most cameras send one slice per frame, so it would decode on a single thread.
 *
 * @param context - Decoder context, before it is opened
 *
 * @internal
 */
export function configureLiveDecoderThreading(context: CodecContext): void {
  // Decoder.create() set the device only if it decodes on it
  if (context.hwDeviceCtx) {
    context.threadType = FF_THREAD_SLICE;
    return;
  }

  // Like FFmpeg's automatic count (CPUs + 1, a single thread on one CPU), capped
  const cpus = availableParallelism();
  context.threadCount = cpus > 1 ? Math.min(cpus + 1, MAX_LIVE_FRAME_THREADS) : 1;
}
