import { mkdirSync } from 'fs';
import { mkdir } from 'fs/promises';
import { Writable } from 'node:stream';
import { dirname, resolve } from 'path';

import {
  AV_CODEC_FLAG_GLOBAL_HEADER,
  AV_DISPOSITION_ATTACHED_PIC,
  AV_DISPOSITION_DEFAULT,
  AV_NOPTS_VALUE,
  AV_OPT_TYPE_BOOL,
  AV_OPT_TYPE_INT,
  AV_TIME_BASE_Q,
  AVERROR_EAGAIN,
  AVERROR_EOF,
  AVFMT_AVOID_NEG_TS_MAKE_ZERO,
  AVFMT_FLAG_CUSTOM_IO,
  AVFMT_GLOBALHEADER,
  AVFMT_NOFILE,
  AVFMT_TS_NONSTRICT,
  AVIO_FLAG_WRITE,
  AVMEDIA_TYPE_AUDIO,
  AVMEDIA_TYPE_VIDEO,
} from '../constants/constants.js';
import { Dictionary } from '../lib/dictionary.js';
import { FFmpegError } from '../lib/error.js';
import { FormatContext } from '../lib/format-context.js';
import { IOContext } from '../lib/io-context.js';
import { Packet } from '../lib/packet.js';
import { Rational } from '../lib/rational.js';
import { SyncQueue, SyncQueueType } from '../lib/sync-queue.js';
import { avAddQ, avCompareTs, avGetAudioFrameDuration2, avRescaleDelta, avRescaleQ } from '../lib/utilities.js';
import { MAX_MUXING_QUEUE_SIZE, MUXING_QUEUE_DATA_THRESHOLD, SYNC_BUFFER_DURATION } from './constants.js';
import { Encoder } from './encoder.js';
import { IOStream } from './io-stream.js';
import { AsyncQueue } from './utilities/async-queue.js';
import { applyContextOptions } from './utilities/context-options.js';

import type { AVMediaType, MuxerFormat, MuxerOptionsFor } from '../constants/index.js';
import type { IRational, OutputFormat, Stream } from '../lib/index.js';
import type { BitStreamFilterAPI } from './bitstream-filter.js';
import type { Demuxer, RTPDemuxer } from './demuxer.js';
import type { IOOutputCallbacks } from './io-stream.js';
import type { ContextOptions } from './utilities/context-options.js';

/**
 * Per-stream muxing state: output stream, encoder/bitstream filter, and the
 * timestamp/pre-mux bookkeeping used while writing.
 *
 * @internal
 */
interface StreamDescription {
  initialized: boolean;
  inputStream?: Stream; // Source stream for metadata/properties (optional in encoder-only mode)
  outputStream: Stream;
  encoder?: Encoder;
  bsf?: BitStreamFilterAPI; // Trailing bitstream filter whose output parameters override the encoder's

  timeBase?: IRational;
  sourceTimeBase?: IRational;
  isStreamCopy: boolean;
  sqIdxMux: number; // Index in sync queue, -1 if not using sync queue
  preMuxQueue: (Packet | null)[]; // PreMuxQueue: Buffered packets (or NULL for EOF marker) before muxer starts
  preMuxArrivals: number[]; // Arrival time of each preMuxQueue entry, in lockstep with it
  sqArrivals: number[]; // Arrival times of this stream's packets in the sync queue, oldest first
  preMuxQueueDataSize: number;
  eofReceived: boolean; // Track if EOF (NULL packet) was received for this stream
  lastMuxDts: bigint;
  firstMuxTs?: bigint; // DTS (PTS without DTS) of the stream's first written packet, output time base
  muxTimeBase?: Rational; // Output time base, read on the first written packet (fixed by the header)
  muxCodecType?: AVMediaType; // Output media type, read on the first written packet
  forward?: ForwardDtsState; // dtsForwardThreshold bookkeeping (audio/video streams with the check enabled)
  tsRescaleDeltaLast: { value: bigint }; // For av_rescale_delta (audio streamcopy)
  streamcopyStarted: boolean; // Track if streamcopy has started for this stream
  startTimeOffset?: bigint; // Effective per-stream startTime offset (decided on the first packet)
}

/**
 * Per-stream state of the dtsForwardThreshold check.
 *
 * Offsets are real time minus media time in ms, relative to the stream's first
 * written packet: they stay level while a live stream keeps pace with real time
 * and drop when its DTS runs ahead.
 *
 * @internal
 */
interface ForwardDtsState {
  msPerTick: number; // Output time base in ms
  lastTs: bigint; // DTS (PTS without DTS) of the last accepted packet
  lastArrival: number; // Arrival time of that packet, NaN before the first
  offset: number; // Offset of that packet
  windowMin: number; // Lowest offset in the current window bucket
  windowPrevMin: number; // Lowest offset in the previous window bucket
  windowCount: number; // Packets in the current window bucket
}

/**
 * A queued packet write: the packet, its stream state, stream index and arrival time.
 *
 * @internal
 */
interface WriteJob {
  pkt: Packet;
  streamInfo: StreamDescription;
  streamIndex: number;
  arrival: number;
}

/**
 * Observer for the packets a Muxer accepts for writing.
 *
 * @internal
 */
export interface MuxerPacketObserver {
  /** A packet with payload was accepted; throwing fails the write like a muxing error. */
  onPacket(streamIndex: number): void;
  /**
   * An accepted packet of this stream will not reach the output (dropped, or rejected by libavformat).
   * A libavformat error for an earlier, buffered packet is reported against the packet submitted with it.
   */
  onPacketRejected(streamIndex: number): void;
}

/**
 * Output formats implemented by libavformat/movenc.c, whose sample durations are 32-bit.
 *
 * @internal
 */
const MOV_FAMILY_FORMATS = new Set(['mov', 'mp4', '3gp', '3g2', 'psp', 'ipod', 'ismv', 'f4v', 'avif']);

/**
 * Smallest DTS step or packet duration (stream time base ticks) rejected for movenc outputs.
 *
 * movenc aborts the process via av_assert0(next_dts <= INT_MAX) in get_cluster_duration()
 * when it writes a sample table. A step of exactly INT_MAX still trips it once movenc nudges
 * a later DTS by one tick, so the limit itself is already rejected.
 *
 * @internal
 */
const MOV_SAMPLE_DURATION_LIMIT = 0x7fffffffn;

/**
 * Packets per bucket of the window of recent packets the dtsForwardThreshold check compares a packet with.
 *
 * Two buckets cover a stream's last 128 to 256 packets. After a gap in a live
 * source, a parser or encoder first releases the frames it held back before
 * the gap: those frames absorb the wait, and the first frame after the gap,
 * though on time, steps forward by the whole gap against them. Against the
 * frames before the gap it does not, and parsers and encoders hold back far
 * fewer frames than the window spans.
 *
 * @internal
 */
const FORWARD_WINDOW_BUCKET = 128;

/**
 * Options for Muxer creation.
 */
export interface MuxerOptions<F extends MuxerFormat | (string & {}) = MuxerFormat | (string & {})> {
  /**
   * Input media for automatic metadata and property copying.
   *
   * When provided, Muxer will automatically copy:
   * - Container-level metadata (title, artist, etc.)
   * - Stream-level metadata
   * - Disposition flags (DEFAULT, FORCED, etc.)
   * - Duration hints for encoding
   *
   * This matches FFmpeg CLI behavior which copies metadata by default.
   */
  input?: Demuxer | RTPDemuxer;

  /**
   * Preferred output format.
   *
   * If not specified, format is guessed from file extension.
   * Use this to override automatic format detection.
   *
   * Matches FFmpeg CLI's -f option.
   *
   * When given as a literal (e.g. `'mp4'`), `options` is strongly typed to that
   * muxer's known options plus the generic AVFormatContext options.
   */
  format?: F;

  /**
   * Buffer size for I/O operations.
   *
   * This option controls the size of the internal buffer used for
   * reading and writing data.
   *
   * @default 32768 (32 KB, matches FFmpeg CLI default)
   */
  bufferSize?: number;

  /**
   * Maximum packet size for I/O operations.
   *
   * This option controls the maximum size of individual packets
   * for protocols that require specific packet sizes (e.g., RTP with MTU constraints).
   *
   * Matches FFmpeg's max_packet_size in AVIOContext.
   *
   * @default 1200
   */
  maxPacketSize?: number;

  /**
   * Exit immediately on first write error.
   *
   * When enabled, the muxer will terminate on the first write error.
   * When disabled, errors are logged but processing continues.
   * Timestamp discontinuities the muxer refuses to write (see
   * {@link MuxerOptions.dtsBackwardThreshold} and
   * {@link MuxerOptions.dtsForwardThreshold}) are thrown either way.
   *
   * @default true
   */
  exitOnError?: boolean;

  /**
   * Backward DTS jump in seconds above which writing a packet fails.
   *
   * Audio and video DTS must not decrease, so a packet behind the stream's last
   * written DTS is clamped forward. After a large backward jump (a live source
   * restarting its clock) every following packet is clamped to one tick past the
   * previous one until the source catches up again, collapsing the timeline for
   * as long as the jump. With a threshold set, such a packet is rejected with an
   * error instead, so the owner can restart on a fresh timeline. Smaller jumps
   * are still clamped. `0` disables the check.
   *
   * Independent of this option, MP4/MOV-family outputs always reject a DTS step
   * or packet duration that their 32-bit sample durations cannot store (INT_MAX
   * ticks or more), where movenc would otherwise collapse the step to one tick
   * or abort the process. Without an edit list (fragmented output without
   * `delay_moov`) they also reject the first packet of a stream that starts
   * more than `max_interleave_delta` (10 s) after the others and ends before
   * the output's start, which movenc cannot store either.
   *
   * @default 0
   */
  dtsBackwardThreshold?: number;

  /**
   * Forward DTS jump in seconds, beyond the real time that passed, above which
   * writing a packet fails.
   *
   * For a source read in real time, timestamps advance with the clock: a gap
   * in the stream comes with a matching wait for the packet after it. A packet
   * whose DTS runs further ahead than the time that passed is a
   * discontinuity (a live source restarting its clock behind a restreamer),
   * and writing it would leave a sample spanning the jump. With a threshold
   * set, such a packet is rejected with an error before it reaches the
   * output, so the owner can restart on a fresh timeline. Real time is
   * measured per audio/video stream from when its packets are passed to
   * writePacket(), and a packet is compared with the stream's last 128 to 256
   * packets, so frames a parser or encoder held back during a gap do not make
   * the end of the gap look like a jump. A stream's first packet is not
   * checked, and a packet without DTS is measured by its PTS. Use it only for
   * sources read in real time: a file read faster than real time has its gaps
   * without the wait. `0` disables the check.
   *
   * @default 0
   */
  dtsForwardThreshold?: number;

  /**
   * Maximum number of packets to buffer per stream in the sync queue.
   *
   * Matches FFmpeg CLI's -max_muxing_queue_size option.
   * Limits memory usage when encoders are still initializing.
   * Takes effect after muxingQueueDataThreshold is reached.
   * If exceeded, an error is thrown.
   *
   * @default 128 (same as FFmpeg CLI)
   */
  maxMuxingQueueSize?: number;

  /**
   * Threshold in bytes after which maxMuxingQueueSize takes effect.
   *
   * Matches FFmpeg CLI's -muxing_queue_data_threshold option.
   * Once this threshold is reached, maxMuxingQueueSize limit applies.
   * This is an intelligent system: small streams (audio) can buffer many packets,
   * large streams (video) are limited by packet count.
   *
   * @default 52428800 (50 MB, same as FFmpeg CLI)
   */
  muxingQueueDataThreshold?: number;

  /**
   * Maximum buffering duration in seconds for sync queue interleaving.
   *
   * Matches FFmpeg CLI's -shortest_buf_duration option.
   * Controls how much buffering is allowed in the native sync queue
   * for packet interleaving across multiple streams.
   *
   * @default 10 (same as FFmpeg CLI)
   */
  syncQueueBufferDuration?: number;

  /**
   * Start time offset in seconds for output timestamps.
   *
   * Matches FFmpeg CLI's -ss (output) option.
   * Subtracts this offset from all packet timestamps.
   * Use for trimming from start of stream.
   *
   * @default AV_NOPTS_VALUE (no offset)
   */
  startTime?: number;

  /**
   * Whether to copy initial non-keyframe packets in streamcopy mode.
   *
   * Matches FFmpeg CLI's -copyinkf option.
   * If false (default), packets before first keyframe are skipped.
   * If true, all packets from start are copied.
   *
   * @default false
   */
  copyInitialNonkeyframes?: boolean;

  /**
   * Copy or discard frames before start time.
   *
   * Matches FFmpeg CLI's -copypriorss option.
   * Controls whether packets before the start time are copied:
   * - -1 (default): Use FFmpeg's internal ts_copy_start calculation
   * - 0: Discard packets before start time
   * - 1: Copy all packets regardless of start time
   *
   * @default -1
   */
  copyPriorStart?: number;

  /**
   * Use synchronous packet queue for interleaving.
   *
   * When true and there are stream copy streams present, enables FFmpeg's
   * sync queue for proper interleaving of packets based on timestamps.
   *
   * The sync queue is only activated when both conditions are met:
   * - `useSyncQueue` is `true`
   * - Output contains at least one stream copy stream
   *
   * This includes scenarios with:
   * - Only stream copy streams (e.g., 1 streamcopy stream)
   * - Mixed streams (e.g., 1 streamcopy + 1 encoded stream)
   *
   * For outputs with only encoded streams, the sync queue is not used.
   *
   * @default true
   */
  useSyncQueue?: boolean;

  /**
   * Use asynchronous write queue to prevent race conditions.
   *
   * When true and there are multiple streams (> 1), all write operations
   * are serialized through an async queue, preventing concurrent access
   * to AVFormatContext which can cause "Packet duration out of range"
   * errors with parallel encoding.
   *
   * The async queue is only activated when both conditions are met:
   * - `useAsyncWrite` is `true`
   * - Output has more than one stream
   *
   * For single-stream outputs, writes are performed directly without
   * queuing, regardless of this setting.
   *
   * @default true
   */
  useAsyncWrite?: boolean;

  /**
   * FFmpeg format options passed directly to the output.
   *
   * Key-value pairs of FFmpeg AVFormatContext / muxer-private options, applied
   * before avformat_write_header(). When `format` is a known literal, these are
   * typed to that muxer's options (autocomplete + value typing); arbitrary keys
   * remain allowed so protocol/other options still pass.
   */
  options?: MuxerOptionsFor<F>;

  /**
   * Configure the underlying format context just before the header is written.
   *
   * Called with the output {@link FormatContext} once, after all streams have
   * been initialized (their parameters, metadata, and disposition copied from
   * the source) and immediately before `avformat_write_header`. Use it to set
   * any container- or stream-level field with full type safety — for example
   * per-stream metadata (language/title) or disposition that should not be
   * overwritten by the source. Settings applied here take precedence because
   * they run after the source values are copied.
   *
   * @example
   * ```typescript
   * import { Dictionary } from 'node-av';
   *
   * await Muxer.open('out.mp4', {
   *   configure: (fmt) => {
   *     fmt.streams[1].metadata = Dictionary.fromObject({ language: 'eng' });
   *   },
   * });
   * ```
   */
  configure?: (context: FormatContext) => void;

  /**
   * Fields to set on the underlying format context.
   *
   * A typed, declarative bag for any writable {@link FormatContext} field. Applied
   * once, after all streams are initialized (their parameters, metadata and
   * disposition copied from the source) and immediately before
   * `avformat_write_header`, so values here take precedence. The allowed keys are
   * derived from the class, so every writable field is available and correctly
   * typed. For per-stream or computed changes use {@link MuxerOptions.configure}.
   *
   * @example
   * ```typescript
   * await Muxer.open('out.mp4', {
   *   context: {
   *     startTime: 0n,
   *   },
   * });
   * ```
   */
  context?: ContextOptions<FormatContext>;

  /**
   * AbortSignal for cancellation.
   *
   * When aborted, async methods throw AbortError.
   */
  signal?: AbortSignal;
}

/**
 * High-level muxer for writing and muxing media files.
 *
 * Provides simplified access to media muxing and file writing operations.
 * Automatically manages header and trailer writing - header is written on first packet,
 * trailer is written on close. Supports lazy initialization for both encoders and streams.
 * Handles stream configuration, packet writing, and format management.
 * Supports files, URLs, and custom I/O with automatic cleanup.
 * Essential component for media encoding pipelines and transcoding.
 *
 * @example
 * ```typescript
 * import { Muxer } from 'node-av/api';
 *
 * // Create output file
 * await using output = await Muxer.open('output.mp4');
 *
 * // Add streams from encoders
 * const videoIdx = output.addStream(videoEncoder);
 * const audioIdx = output.addStream(audioEncoder);
 *
 * // Write packets - header written automatically on first packet
 * await output.writePacket(packet, videoIdx);
 *
 * // Close - trailer written automatically
 * // (automatic with await using)
 * ```
 *
 * @example
 * ```typescript
 * // Stream copy
 * await using input = await Demuxer.open('input.mp4');
 * await using output = await Muxer.open('output.mp4');
 *
 * // Copy stream configuration
 * const videoIdx = output.addStream(input.video());
 *
 * // Process packets - header/trailer handled automatically
 * for await (const packet of input.packets()) {
 *   await output.writePacket(packet, videoIdx);
 *   packet.free();
 * }
 * ```
 *
 * @see {@link Demuxer} For reading media files
 * @see {@link Encoder} For encoding frames to packets
 * @see {@link FormatContext} For low-level API
 */
export class Muxer implements AsyncDisposable, Disposable {
  private formatContext: FormatContext;
  private options: MuxerOptions;
  private _streams = new Map<number, StreamDescription>();
  private ioContext?: IOContext;
  private customIO = false; // ioContext is callback-backed (Writable/IOOutputCallbacks) - freed, never closed
  private headerWritten = false;
  private headerWritePromise?: Promise<void>;
  private trailerWritten = false;
  private isClosed = false;
  private syncQueue?: SyncQueue; // FFmpeg's native sync queue for packet interleaving
  private sqPacket?: Packet; // Reusable packet for sync queue receive
  private containerMetadataCopied = false; // Track if container metadata has been copied
  private writeQueue?: AsyncQueue<WriteJob>; // Optional async queue for serialized writes
  private writeWorkerPromise?: Promise<void>; // Background worker promise
  private writeWorkerError?: Error; // First error from the write worker - poisons subsequent writes and close()
  private signal?: AbortSignal;
  private movSampleLimit = false; // Output is a movenc format with 32-bit sample durations (set before the header write)
  private tsNonStrict = false; // Output allows equal consecutive DTS (AVFMT_TS_NONSTRICT, set before the header write)
  private movZeroStart = false; // movenc puts each track's first sample at the output's start (no edit list, set after the header write)
  private interleaveDeltaUs = 0n; // libavformat's max_interleave_delta in µs (set after the header write)
  private trailerDiscarded = false; // close() skips the trailer, see discardOnClose()
  private forwardThresholdMs = 0; // dtsForwardThreshold in ms, 0 = off
  private clock: () => number = () => performance.now(); // Monotonic ms clock for packet arrival times
  private packetObserver?: MuxerPacketObserver; // Follows the accepted packets (FMP4Stream's maxPacketAge)

  /**
   * @param options - Media output options
   *
   * @throws {RangeError} If dtsBackwardThreshold or dtsForwardThreshold is not a finite number >= 0
   *
   * @internal
   */
  private constructor(options?: MuxerOptions) {
    for (const [name, threshold] of [
      ['dtsBackwardThreshold', options?.dtsBackwardThreshold],
      ['dtsForwardThreshold', options?.dtsForwardThreshold],
    ] as const) {
      if (threshold !== undefined && (!Number.isFinite(threshold) || threshold < 0)) {
        throw new RangeError(`${name} must be a finite number of seconds >= 0, got ${threshold}`);
      }
    }

    this.options = {
      copyInitialNonkeyframes: false,
      exitOnError: true,
      useSyncQueue: true,
      useAsyncWrite: true,
      ...options,
    };
    this.forwardThresholdMs = (options?.dtsForwardThreshold ?? 0) * 1000;

    this.formatContext = new FormatContext();
  }

  /**
   * Open muxer for writing.
   *
   * Creates and configures output context for muxing.
   * Automatically creates directories for file output.
   * Supports files, URLs, and custom I/O callbacks.
   *
   * Direct mapping to avformat_alloc_output_context2() and avio_open2().
   *
   * @param target - File path, URL, or I/O callbacks
   *
   * @param options - Output configuration options
   *
   * @returns Opened muxer instance
   *
   * @throws {Error} If format required for custom I/O
   *
   * @throws {RangeError} If dtsBackwardThreshold or dtsForwardThreshold is not a finite number >= 0
   *
   * @throws {FFmpegError} If allocation or opening fails
   *
   * @example
   * ```typescript
   * // Create file output
   * await using output = await Muxer.open('output.mp4');
   * ```
   *
   * @example
   * ```typescript
   * // Create output with specific format
   * await using output = await Muxer.open('output.ts', {
   *   format: 'mpegts'
   * });
   * ```
   *
   * @example
   * ```typescript
   * // Custom I/O callbacks - async streaming to web destination
   * const callbacks = {
   *   write: async (buffer: Buffer) => {
   *     await streamWriter.write(buffer);
   *     return buffer.length;
   *   }
   * };
   *
   * await using output = await Muxer.open(callbacks, {
   *   format: 'mp4',
   *   bufferSize: 8192
   * });
   * ```
   *
   * @example
   * ```typescript
   * // Custom I/O callbacks - synchronous buffering
   * const chunks: Buffer[] = [];
   * const callbacks = {
   *   write: (buffer: Buffer) => {
   *     chunks.push(Buffer.from(buffer));
   *     return buffer.length;
   *   }
   * };
   *
   * await using output = await Muxer.open(callbacks, { format: 'mp4' });
   * ```
   *
   * @see {@link MuxerOptions} For configuration options
   * @see {@link IOOutputCallbacks} For custom I/O interface
   */
  static async open<const F extends MuxerFormat | (string & {}) = MuxerFormat | (string & {})>(target: string, options?: MuxerOptions<F>): Promise<Muxer>;
  static async open<const F extends MuxerFormat | (string & {})>(target: IOOutputCallbacks, options: MuxerOptions<F> & { format: F }): Promise<Muxer>;
  static async open<const F extends MuxerFormat | (string & {})>(target: Writable, options: MuxerOptions<F> & { format: F }): Promise<Muxer>;
  static async open(target: string | IOOutputCallbacks | Writable, options?: MuxerOptions): Promise<Muxer> {
    const output = new Muxer(options);

    try {
      if (typeof target === 'string') {
        // File or stream URL - resolve relative paths and create directories
        // Check if it's a URL (starts with protocol://) or a file path
        const isUrl = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(target);
        const resolvedTarget = isUrl ? target : resolve(target);

        // Create directory structure for local files (not URLs)
        if (!isUrl && target !== '') {
          const dir = dirname(resolvedTarget);
          await mkdir(dir, { recursive: true });
        }
        // Allocate output context
        const ret = output.formatContext.allocOutputContext2(null, options?.format ?? null, resolvedTarget === '' ? null : resolvedTarget);
        FFmpegError.throwIfError(ret, 'Failed to allocate output context');

        // Set format options if provided
        if (options?.options) {
          for (const [key, value] of Object.entries(options.options)) {
            const ret = output.formatContext.setOption(key, value);
            FFmpegError.throwIfError(ret, `Failed to set muxer option '${key}'`);
          }
        }

        // Check if we need to open IO
        const oformat = output.formatContext.oformat;
        if (resolvedTarget && oformat && !oformat.hasFlags(AVFMT_NOFILE)) {
          // For file-based formats, we need to open the file using avio_open2
          // FFmpeg will manage the AVIOContext internally
          output.ioContext = new IOContext();
          const openRet = await output.ioContext.open2(resolvedTarget, AVIO_FLAG_WRITE);
          FFmpegError.throwIfError(openRet, `Failed to open output file: ${resolvedTarget}`);
          output.formatContext.pb = output.ioContext;
        }
      } else if (target instanceof Writable) {
        // Writable stream - format is required
        if (!options?.format) {
          throw new Error('Format must be specified for Writable stream output');
        }

        const ret = output.formatContext.allocOutputContext2(null, options.format, null);
        FFmpegError.throwIfError(ret, 'Failed to allocate output context');

        // Set format options if provided
        if (options?.options) {
          for (const [key, value] of Object.entries(options.options)) {
            const ret = output.formatContext.setOption(key, value);
            FFmpegError.throwIfError(ret, `Failed to set muxer option '${key}'`);
          }
        }

        output.ioContext = IOStream.createOutput(target, options);
        output.customIO = true;
        output.formatContext.pb = output.ioContext;
        output.formatContext.setFlags(AVFMT_FLAG_CUSTOM_IO);
      } else {
        // Custom IO with callbacks - format is required
        if (!options?.format) {
          throw new Error('Format must be specified for custom IO');
        }

        const ret = output.formatContext.allocOutputContext2(null, options.format, null);
        FFmpegError.throwIfError(ret, 'Failed to allocate output context');

        // Set format options if provided
        if (options?.options) {
          for (const [key, value] of Object.entries(options.options)) {
            const ret = output.formatContext.setOption(key, value);
            FFmpegError.throwIfError(ret, `Failed to set muxer option '${key}'`);
          }
        }

        output.ioContext = IOStream.createOutput(target, options);
        output.customIO = true;
        output.formatContext.pb = output.ioContext;
        output.formatContext.setFlags(AVFMT_FLAG_CUSTOM_IO);
      }

      if (options?.signal) {
        options.signal.throwIfAborted();
        output.signal = options.signal;
      }

      return output;
    } catch (error) {
      // Cleanup on error
      if (output.ioContext) {
        try {
          // Clear the pb reference first - freeContext() below closes a pb that
          // is still set, which would double-free the context released here
          output.formatContext.pb = null;
          if (output.customIO) {
            // For custom IO with callbacks, free the context
            output.ioContext.freeContext();
          } else {
            // For file-based IO, close the file handle
            await output.ioContext.closep();
          }
        } catch {
          // Ignore errors
        }
      }
      if (output.formatContext) {
        try {
          output.formatContext.freeContext();
        } catch {
          // Ignore errors
        }
      }
      throw error;
    }
  }

  /**
   * Open muxer for writing synchronously.
   * Synchronous version of open.
   *
   * Creates and configures output context for muxing.
   * Automatically creates directories for file output.
   * Supports files, URLs, and custom I/O callbacks.
   *
   * Direct mapping to avformat_alloc_output_context2() and avio_open2().
   *
   * @param target - File path, URL, or I/O callbacks
   *
   * @param options - Output configuration options
   *
   * @returns Opened muxer instance
   *
   * @throws {Error} If format required for custom I/O
   *
   * @throws {RangeError} If dtsBackwardThreshold or dtsForwardThreshold is not a finite number >= 0
   *
   * @throws {FFmpegError} If allocation or opening fails
   *
   * @example
   * ```typescript
   * // Create file output
   * using output = Muxer.openSync('output.mp4');
   * ```
   *
   * @example
   * ```typescript
   * // Create output with specific format
   * using output = Muxer.openSync('output.ts', {
   *   format: 'mpegts'
   * });
   * ```
   *
   * @see {@link open} For async version
   */
  static openSync<const F extends MuxerFormat | (string & {}) = MuxerFormat | (string & {})>(target: string, options?: MuxerOptions<F>): Muxer;
  static openSync<const F extends MuxerFormat | (string & {})>(target: IOOutputCallbacks, options: MuxerOptions<F> & { format: F }): Muxer;
  static openSync<const F extends MuxerFormat | (string & {})>(target: Writable, options: MuxerOptions<F> & { format: F }): Muxer;
  static openSync(target: string | IOOutputCallbacks | Writable, options?: MuxerOptions): Muxer {
    const output = new Muxer(options);

    try {
      if (typeof target === 'string') {
        // File or stream URL - resolve relative paths and create directories
        // Check if it's a URL (starts with protocol://) or a file path
        const isUrl = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(target);
        const resolvedTarget = isUrl ? target : resolve(target);

        // Create directory structure for local files (not URLs)
        if (!isUrl && target !== '') {
          const dir = dirname(resolvedTarget);
          mkdirSync(dir, { recursive: true });
        }
        // Allocate output context
        const ret = output.formatContext.allocOutputContext2(null, options?.format ?? null, resolvedTarget === '' ? null : resolvedTarget);
        FFmpegError.throwIfError(ret, 'Failed to allocate output context');

        // Set format options if provided
        if (options?.options) {
          for (const [key, value] of Object.entries(options.options)) {
            const ret = output.formatContext.setOption(key, value);
            FFmpegError.throwIfError(ret, `Failed to set muxer option '${key}'`);
          }
        }

        // Check if we need to open IO
        const oformat = output.formatContext.oformat;
        if (resolvedTarget && oformat && !oformat.hasFlags(AVFMT_NOFILE)) {
          // For file-based formats, we need to open the file using avio_open2
          // FFmpeg will manage the AVIOContext internally
          output.ioContext = new IOContext();
          const openRet = output.ioContext.open2Sync(resolvedTarget, AVIO_FLAG_WRITE);
          FFmpegError.throwIfError(openRet, `Failed to open output file: ${resolvedTarget}`);
          output.formatContext.pb = output.ioContext;
        }
      } else if (target instanceof Writable) {
        // Writable stream - format is required
        if (!options?.format) {
          throw new Error('Format must be specified for Writable stream output');
        }

        const ret = output.formatContext.allocOutputContext2(null, options.format, null);
        FFmpegError.throwIfError(ret, 'Failed to allocate output context');

        // Set format options if provided
        if (options?.options) {
          for (const [key, value] of Object.entries(options.options)) {
            const ret = output.formatContext.setOption(key, value);
            FFmpegError.throwIfError(ret, `Failed to set muxer option '${key}'`);
          }
        }

        output.ioContext = IOStream.createOutput(target, options);
        output.customIO = true;
        output.formatContext.pb = output.ioContext;
        output.formatContext.setFlags(AVFMT_FLAG_CUSTOM_IO);
      } else {
        // Custom IO with callbacks - format is required
        if (!options?.format) {
          throw new Error('Format must be specified for custom IO');
        }

        const ret = output.formatContext.allocOutputContext2(null, options.format, null);
        FFmpegError.throwIfError(ret, 'Failed to allocate output context');

        // Set format options if provided
        if (options?.options) {
          for (const [key, value] of Object.entries(options.options)) {
            const ret = output.formatContext.setOption(key, value);
            FFmpegError.throwIfError(ret, `Failed to set muxer option '${key}'`);
          }
        }

        output.ioContext = IOStream.createOutput(target, options);
        output.customIO = true;
        output.formatContext.pb = output.ioContext;
        output.formatContext.setFlags(AVFMT_FLAG_CUSTOM_IO);
      }

      if (options?.signal) {
        options.signal.throwIfAborted();
        output.signal = options.signal;
      }

      return output;
    } catch (error) {
      // Cleanup on error
      if (output.ioContext) {
        try {
          // Clear the pb reference first - freeContext() below closes a pb that
          // is still set, which would double-free the context released here
          output.formatContext.pb = null;
          if (output.customIO) {
            // For custom IO with callbacks, free the context
            output.ioContext.freeContext();
          } else {
            // For file-based IO, close the file handle
            output.ioContext.closepSync();
          }
        } catch {
          // Ignore errors
        }
      }
      if (output.formatContext) {
        try {
          output.formatContext.freeContext();
        } catch {
          // Ignore errors
        }
      }
      throw error;
    }
  }

  /**
   * Check if output is open.
   *
   * @example
   * ```typescript
   * if (!output.isOutputOpen) {
   *   console.log('Output is not open');
   * }
   * ```
   */
  get isOpen(): boolean {
    return !this.isClosed;
  }

  /**
   * Check if output is initialized.
   *
   * All streams have been initialized.
   * This occurs after the first packet has been written to each stream.
   *
   * @example
   * ```typescript
   * if (!output.isOutputInitialized) {
   *   console.log('Output is not initialized');
   * }
   * ```
   */
  get streamsInitialized(): boolean {
    if (this._streams.size === 0) {
      return false;
    }

    if (this.isClosed) {
      return false;
    }

    return Array.from(this._streams).every(([_, stream]) => stream.initialized);
  }

  /**
   * Get all streams in the media.
   *
   * @example
   * ```typescript
   * for (const stream of output.streams) {
   *   console.log(`Stream ${stream.index}: ${stream.codecpar.codecType}`);
   * }
   * ```
   */
  get streams(): Stream[] {
    return this.formatContext.streams;
  }

  /**
   * Get format name.
   *
   * Returns 'unknown' if output is closed or format is not available.
   *
   * @example
   * ```typescript
   * console.log(`Format: ${output.formatName}`); // "mov,mp4,m4a,3gp,3g2,mj2"
   * ```
   */
  get formatName(): string {
    if (this.isClosed) {
      return 'unknown';
    }

    return this.formatContext.oformat?.name ?? 'unknown';
  }

  /**
   * Get format long name.
   *
   * Returns 'Unknown Format' if output is closed or format is not available.
   *
   * @example
   * ```typescript
   * console.log(`Format: ${output.formatLongName}`); // "QuickTime / MOV"
   * ```
   */
  get formatLongName(): string {
    if (this.isClosed) {
      return 'Unknown Format';
    }

    return this.formatContext.oformat?.longName ?? 'Unknown Format';
  }

  /**
   * Get MIME type of the output format.
   *
   * Returns format's native MIME type.
   * Returns null if output is closed or format is not available.
   *
   * @example
   * ```typescript
   * console.log(mp4Output.mimeType); // "video/mp4"
   * ```
   */
  get mimeType(): string | null {
    if (this.isClosed) {
      return null;
    }

    return this.formatContext.oformat?.mimeType ?? null;
  }

  /**
   * Add a stream to the output (encoder-only mode).
   *
   * Configures output stream from encoder. Stream is initialized lazily from first encoded frame.
   * Use this when generating frames programmatically without an input stream.
   *
   * @param encoder - Encoder for encoding frames to packets
   *
   * @param options - Stream configuration options
   *
   * @param options.inputStream - Optional input stream for metadata/properties
   *
   * @returns Stream index for packet writing
   *
   * @throws {Error} If called after packets have been written or output closed
   *
   * @example
   * ```typescript
   * // Encoder-only (e.g., frame generator)
   * const encoder = await Encoder.create(FF_ENCODER_LIBX264);
   * const streamIdx = output.addStream(encoder);
   * ```
   *
   * @example
   * ```typescript
   * // Encoder with input stream for metadata
   * const streamIdx = output.addStream(encoder, {
   *   inputStream: input.video()
   * });
   * ```
   */
  addStream(encoder: Encoder, options?: { inputStream?: Stream; bsf?: BitStreamFilterAPI }): number;

  /**
   * Add a stream to the output (stream copy or transcoding mode).
   *
   * Configures output stream from input stream and optional encoder.
   * Must be called before writing any packets.
   * Returns stream index for packet writing.
   *
   * Automatically copies from input stream:
   * - Codec parameters (stream copy mode)
   * - Metadata
   * - Disposition flags
   * - Frame rates and aspect ratios
   * - Duration hints
   * - HDR/Dolby Vision side data (coded_side_data)
   *
   * When encoder is provided:
   * - Stream is initialized lazily from first encoded frame
   * - Metadata and disposition copied from input stream
   * - Duration hint used for muxer
   *
   * Direct mapping to avformat_new_stream().
   *
   * @param stream - Input stream (source for properties/metadata)
   *
   * @param options - Stream configuration options
   *
   * @param options.encoder - Optional encoder for transcoding
   *
   * @returns Stream index for packet writing
   *
   * @throws {Error} If called after packets have been written or output closed
   *
   * @example
   * ```typescript
   * // Stream copy
   * const videoIdx = output.addStream(input.video());
   * const audioIdx = output.addStream(input.audio());
   * ```
   *
   * @example
   * ```typescript
   * // With encoding
   * const videoIdx = output.addStream(input.video(), {
   *   encoder: videoEncoder
   * });
   * ```
   *
   * @see {@link writePacket} For writing packets to streams
   * @see {@link Encoder} For transcoding source
   */
  addStream(stream: Stream, options?: { encoder?: Encoder; bsf?: BitStreamFilterAPI }): number;
  addStream(streamOrEncoder: Stream | Encoder, options?: { encoder?: Encoder; inputStream?: Stream; bsf?: BitStreamFilterAPI }): number {
    if (this.isClosed) {
      throw new Error('Muxer is closed');
    }

    if (this.headerWritten) {
      throw new Error('Cannot add streams after packets have been written');
    }

    const outStream = this.formatContext.newStream(null);
    if (!outStream) {
      throw new Error('Failed to create new stream');
    }

    // Determine if first parameter is Encoder or Stream
    const isEncoderFirst = streamOrEncoder instanceof Encoder;

    let stream: Stream | undefined;
    let encoder: Encoder | undefined;

    if (isEncoderFirst) {
      // First parameter is Encoder
      encoder = streamOrEncoder;
      stream = options?.inputStream;
    } else {
      // First parameter is Stream
      stream = streamOrEncoder;
      encoder = options?.encoder;
    }

    const isStreamCopy = !encoder;

    // Auto-set GLOBAL_HEADER flag if format requires it
    if (encoder) {
      const oformat = this.formatContext.oformat;
      if (oformat?.hasFlags(AVFMT_GLOBALHEADER)) {
        encoder.setCodecFlags(AV_CODEC_FLAG_GLOBAL_HEADER);
      }
    }

    // For stream copy, initialize immediately since we have all the info
    if (isStreamCopy) {
      if (!stream) {
        throw new Error('Stream copy mode requires an input stream');
      }

      const ret = stream.codecpar.copy(outStream.codecpar);
      FFmpegError.throwIfError(ret, 'Failed to copy codec parameters');

      // Set the timebases
      const sourceTimeBase = stream.timeBase;

      outStream.timeBase = new Rational(stream.timeBase.num, stream.timeBase.den);

      // Copy frame rates and aspect ratios
      outStream.avgFrameRate = stream.avgFrameRate;
      if (stream.sampleAspectRatio.num > 0) {
        outStream.sampleAspectRatio = stream.sampleAspectRatio;
      }
      outStream.rFrameRate = stream.rFrameRate;

      // Copy duration
      if (stream.duration > 0n) {
        outStream.duration = stream.duration;
      }

      // Copy metadata
      const metadata = stream.metadata;
      if (metadata) {
        outStream.metadata = metadata;
      }

      // Copy disposition
      outStream.disposition = stream.disposition;

      // Copy coded_side_data (HDR/Dolby Vision)
      // Iterate over all side_data entries and copy them
      const allSideData = stream.codecpar.getAllCodedSideData();
      for (const sd of allSideData) {
        outStream.codecpar.addCodedSideData(sd.type, sd.data);
      }

      this._streams.set(outStream.index, {
        initialized: true,
        outputStream: outStream,
        inputStream: stream,
        encoder: undefined,
        sourceTimeBase,
        isStreamCopy: true,
        sqIdxMux: -1, // Will be set if sync queue is needed
        preMuxQueue: [],
        preMuxArrivals: [],
        sqArrivals: [],
        preMuxQueueDataSize: 0,
        eofReceived: false,
        lastMuxDts: AV_NOPTS_VALUE,
        tsRescaleDeltaLast: { value: AV_NOPTS_VALUE },
        streamcopyStarted: false,
      });
    } else {
      // Encoding path - lazy initialization
      // stream is optional here - if provided, we copy metadata/disposition
      // If not provided (encoder-only mode), stream will be initialized from first encoded frame
      this._streams.set(outStream.index, {
        initialized: false,
        outputStream: outStream,
        inputStream: stream,
        encoder,
        bsf: options?.bsf,
        sourceTimeBase: undefined, // Will be set on initialization
        isStreamCopy: false,
        sqIdxMux: -1, // Will be set if sync queue is needed
        preMuxQueue: [],
        preMuxArrivals: [],
        sqArrivals: [],
        preMuxQueueDataSize: 0,
        eofReceived: false,
        lastMuxDts: AV_NOPTS_VALUE,
        tsRescaleDeltaLast: { value: AV_NOPTS_VALUE },
        streamcopyStarted: false,
      });
    }

    return outStream.index;
  }

  /**
   * Get output stream by index.
   *
   * Returns the stream at the specified index.
   * Use the stream index returned by addStream().
   *
   * @param index - Stream index (returned by addStream)
   *
   * @returns Stream or undefined if index is invalid
   *
   * @example
   * ```typescript
   * const output = await Muxer.open('output.mp4');
   * const videoIdx = output.addStream(encoder);
   *
   * // Get the output stream to inspect codec parameters
   * const stream = output.getStream(videoIdx);
   * if (stream) {
   *   console.log(`Output codec: ${stream.codecpar.codecId}`);
   * }
   * ```
   *
   * @see {@link addStream} For adding streams
   * @see {@link video} For getting video streams
   * @see {@link audio} For getting audio streams
   */
  getStream(index: number): Stream | undefined {
    const streams = this.formatContext.streams;
    if (!streams || index < 0 || index >= streams.length) {
      return undefined;
    }
    return streams[index];
  }

  /**
   * Get video stream by index.
   *
   * Returns the nth video stream (0-based index).
   * Returns undefined if stream doesn't exist.
   *
   * @param index - Video stream index (default: 0)
   *
   * @returns Video stream or undefined
   *
   * @example
   * ```typescript
   * const output = await Muxer.open('output.mp4');
   * output.addStream(videoEncoder);
   *
   * // Get first video stream
   * const videoStream = output.video();
   * if (videoStream) {
   *   console.log(`Video output: ${videoStream.codecpar.width}x${videoStream.codecpar.height}`);
   * }
   * ```
   *
   * @see {@link audio} For audio streams
   * @see {@link getStream} For direct stream access
   */
  video(index = 0): Stream | undefined {
    const streams = this.formatContext.streams;
    if (!streams) return undefined;
    const videoStreams = streams.filter((s) => s.codecpar.codecType === AVMEDIA_TYPE_VIDEO);
    return videoStreams[index];
  }

  /**
   * Get audio stream by index.
   *
   * Returns the nth audio stream (0-based index).
   * Returns undefined if stream doesn't exist.
   *
   * @param index - Audio stream index (default: 0)
   *
   * @returns Audio stream or undefined
   *
   * @example
   * ```typescript
   * const output = await Muxer.open('output.mp4');
   * output.addStream(audioEncoder);
   *
   * // Get first audio stream
   * const audioStream = output.audio();
   * if (audioStream) {
   *   console.log(`Audio output: ${audioStream.codecpar.sampleRate}Hz`);
   * }
   * ```
   *
   * @see {@link video} For video streams
   * @see {@link getStream} For direct stream access
   */
  audio(index = 0): Stream | undefined {
    const streams = this.formatContext.streams;
    if (!streams) return undefined;
    const audioStreams = streams.filter((s) => s.codecpar.codecType === AVMEDIA_TYPE_AUDIO);
    return audioStreams[index];
  }

  /**
   * Get output format.
   *
   * Returns the output format used for muxing.
   * May be null if format context not initialized.
   *
   * @returns Output format or null
   *
   * @example
   * ```typescript
   * const output = await Muxer.open('output.mp4');
   * const format = output.outputFormat();
   * if (format) {
   *   console.log(`Output format: ${format.name}`);
   * }
   * ```
   *
   * @see {@link OutputFormat} For format details
   */
  outputFormat(): OutputFormat | null {
    return this.formatContext.oformat;
  }

  /**
   * Write a packet to the output.
   *
   * Writes muxed packet to the specified stream.
   * Automatically handles:
   * - Stream initialization on first packet (lazy initialization)
   * - Codec parameter configuration from encoder or input stream
   * - Header writing on first packet
   * - Timestamp rescaling between source and output timebases
   * - Sync queue for proper interleaving
   *
   * For encoder sources, the encoder must have processed at least one frame
   * before packets can be written (encoder must be initialized).
   *
   * Uses FFmpeg CLI's sync queue pattern: buffers packets per stream and writes
   * them in DTS order using av_compare_ts for timebase-aware comparison.
   *
   * To signal EOF for a stream, pass null as the packet.
   * This tells the muxer that no more packets will be sent for this stream.
   * The trailer is written only when close() is called.
   *
   * Direct mapping to avformat_write_header() (on first packet) and av_interleaved_write_frame().
   *
   * @param packet - Packet to write (or null to signal EOF for the stream)
   *
   * @param streamIndex - Target stream index
   *
   * @throws {Error} If stream invalid or encoder not initialized
   *
   * @throws {Error} On a timestamp discontinuity the output cannot take (see {@link MuxerOptions.dtsBackwardThreshold}).
   * With the background write queue (more than one stream) it surfaces from a later writePacket() or close().
   *
   * @throws {FFmpegError} If write fails
   *
   * @example
   * ```typescript
   * // Write encoded packet - header written automatically on first packet
   * const packet = await encoder.encode(frame);
   * if (packet) {
   *   await output.writePacket(packet, videoIdx);
   *   packet.free();
   * }
   * ```
   *
   * @example
   * ```typescript
   * // Stream copy with packet processing
   * for await (const packet of input.packets()) {
   *   if (packet.streamIndex === inputVideoIdx) {
   *     await output.writePacket(packet, outputVideoIdx);
   *   }
   *   packet.free();
   * }
   * ```
   *
   * @see {@link addStream} For adding streams
   */
  async writePacket(packet: Packet | null | undefined, streamIndex: number): Promise<void> {
    this.signal?.throwIfAborted();

    // A previous background write failed - surface it instead of buffering more packets
    if (this.writeWorkerError) {
      throw this.writeWorkerError;
    }

    if (this.isClosed) {
      throw new Error('Muxer is closed');
    }

    if (this.trailerWritten) {
      throw new Error('Cannot write packets after output is finalized');
    }

    if (!this._streams.get(streamIndex)) {
      throw new Error(`Invalid stream index: ${streamIndex}`);
    }

    // Initialize any encoder streams that are ready
    for (const streamInfo of this._streams.values()) {
      if (!streamInfo.initialized && streamInfo.encoder) {
        const encoder = streamInfo.encoder;
        const codecContext = encoder.getCodecContext();

        // Skip if encoder not ready yet
        if (!encoder.isEncoderInitialized || !codecContext) {
          continue;
        }

        // If a trailing bitstream filter is present, wait until it is initialized
        // so its output parameters (e.g. modified extradata) are available.
        if (streamInfo.bsf && !streamInfo.bsf.isInitialized) {
          continue;
        }

        // This encoder is ready, initialize it now
        // Read codecType from codecContext, not from stream (which is still uninitialized)
        // const codecType = codecContext.codecType;

        // 1. Set stream timebase
        if (streamInfo.outputStream.timeBase.num <= 0 || streamInfo.outputStream.timeBase.den <= 0) {
          const tb = avAddQ(codecContext.timeBase, { num: 0, den: 1 });
          streamInfo.outputStream.timeBase = new Rational(tb.num, tb.den);
        }

        // 2. Set stream avg_frame_rate, r_frame_rate and sample_aspect_ratio
        const fr = codecContext.framerate;
        streamInfo.outputStream.avgFrameRate = new Rational(fr.num, fr.den);
        streamInfo.outputStream.sampleAspectRatio = codecContext.sampleAspectRatio;

        // 3. Copy codec parameters from encoder context
        const ret = streamInfo.outputStream.codecpar.fromContext(codecContext);
        FFmpegError.throwIfError(ret, 'Failed to copy codec parameters from encoder');

        // 3b. Overlay the trailing bitstream filter's output parameters, so
        // container-level fields (e.g. extradata/level rewritten by h264_metadata)
        // reflect the filter's output rather than the raw encoder output.
        const bsfParams = streamInfo.bsf?.outputCodecParameters;
        if (bsfParams) {
          const bsfRet = bsfParams.copy(streamInfo.outputStream.codecpar);
          FFmpegError.throwIfError(bsfRet, 'Failed to copy codec parameters from bitstream filter');
        }

        // 4. Copy metadata from input stream
        if (streamInfo.inputStream) {
          const metadata = streamInfo.inputStream.metadata;
          if (metadata) {
            streamInfo.outputStream.metadata = metadata;
          }

          // 5. Copy disposition from input stream
          streamInfo.outputStream.disposition = streamInfo.inputStream.disposition;

          // 5b. Copy coded_side_data from input stream (display matrix / rotation,
          // HDR mastering display & content light level). The encoder path only
          // copied codec parameters, so without this these are lost on transcode
          // (e.g. a portrait phone video would play sideways). Mirrors the stream
          // copy path.
          const inputSideData = streamInfo.inputStream.codecpar.getAllCodedSideData();
          for (const sd of inputSideData) {
            streamInfo.outputStream.codecpar.addCodedSideData(sd.type, sd.data);
          }

          // 6. Copy duration hint from input stream
          if (streamInfo.inputStream.duration > 0n) {
            const inputTb = streamInfo.inputStream.timeBase;
            const outputTb = streamInfo.outputStream.timeBase;
            const rescaledDuration = avRescaleQ(streamInfo.inputStream.duration, inputTb, outputTb);
            streamInfo.outputStream.duration = rescaledDuration;
          }
        }

        // Update the source timebase for timestamp rescaling
        streamInfo.sourceTimeBase = codecContext.timeBase;

        // Mark as initialized
        streamInfo.initialized = true;
      }
    }

    const streamInfo = this._streams.get(streamIndex)!;

    // Handle NULL packet - signals EOF for this stream (FFmpeg pattern: av_interleaved_write_frame(s, NULL))
    // FFmpeg's behavior:
    // - If muxer not started (uninitialized streams), buffer NULL in PreMuxQueue as EOF marker
    // - If muxer started, send NULL to SyncQueue to signal EOF and flush
    if (!packet) {
      // Mark stream as EOF received
      streamInfo.eofReceived = true;

      // Check if any streams are still uninitialized (PreMuxQueue phase)
      const uninitialized = Array.from(this._streams.values()).some((s) => !s.initialized);

      // PHASE 1: Before muxer starts - buffer NULL packet in PreMuxQueue
      // This matches FFmpeg's mux_queue_packet() which writes NULL to PreMuxQueue FIFO
      if (uninitialized || this.headerWritePromise) {
        // Buffer NULL as EOF marker (no size contribution)
        streamInfo.preMuxQueue.push(null);
        streamInfo.preMuxArrivals.push(0);
        return;
      }

      // PHASE 2: After muxer started - send EOF to SyncQueue and flush
      if (!this.headerWritten) {
        return;
      }

      // If using SyncQueue, send EOF for this stream
      if (this.syncQueue && streamInfo.sqIdxMux >= 0) {
        // Send NULL to signal EOF to sync queue
        // Native side handles null correctly (sets sqframe.p = nullptr)
        const ret = this.syncQueue.send(streamInfo.sqIdxMux, null);

        if (ret < 0 && ret !== AVERROR_EOF) {
          if (this.options.exitOnError) {
            FFmpegError.throwIfError(ret, 'Failed to send EOF to sync queue');
          }
        }

        // Receive and write any remaining packets from sync queue
        while (!this.isClosed) {
          const recvRet = this.syncQueue.receive(-1, this.sqPacket!);
          if (recvRet === AVERROR_EAGAIN) {
            break; // No more packets ready
          }
          if (recvRet === AVERROR_EOF) {
            break; // All streams finished
          }
          if (recvRet >= 0) {
            const recvStreamInfo = this._streams.get(recvRet)!;
            const pkt = this.sqPacket!.clone();
            if (!pkt) {
              throw new Error('Failed to clone packet from sync queue');
            }
            pkt.streamIndex = recvRet;
            await this.write(pkt, recvStreamInfo, recvRet, recvStreamInfo.sqArrivals.shift() ?? 0);
          }
        }
      }

      return; // EOF signaled, nothing more to do
    }

    // Clone packet immediately - we will modify it and caller retains ownership
    const clonedPacket = packet.clone();
    if (!clonedPacket) {
      throw new Error('Failed to clone packet for writing');
    }

    // The forward check compares DTS steps with the time between packets as
    // they reach the muxer. Taken here and carried through the pre-mux, sync
    // and write queues, so time a packet spends queued does not count.
    const arrival = this.forwardThresholdMs > 0 ? this.clock() : 0;

    // Apply streamcopy filtering BEFORE buffering
    // This ensures rejected packets never enter the queue/buffer
    if (streamInfo.isStreamCopy) {
      const shouldWrite = this.ofStreamcopy(clonedPacket, streamInfo, streamIndex);
      if (!shouldWrite) {
        clonedPacket.free(); // Free the clone since we won't use it
        return;
      }
    } else if (this.options.startTime !== undefined) {
      // For encoded (non-streamcopy) streams, strip the device's startTime base.
      this.applyStartTimeOffset(clonedPacket, streamInfo);
    }

    // Announced on acceptance, so the observer also counts what waits in the
    // pre-mux queue for the header.
    const observed = this.announcePacket(clonedPacket, streamIndex);

    // Check if any streams are still uninitialized or header is being written
    const uninitialized = Array.from(this._streams.values()).some((s) => !s.initialized);

    // PHASE 1: Before header write - ALWAYS buffer in PreMuxQueue
    // PreMuxQueue is used during initialization phase ONLY (regardless of SyncQueue presence)
    // After header write, PreMuxQueue is flushed in DTS-sorted order
    if (uninitialized || this.headerWritePromise) {
      // Check PreMuxQueue limits
      const maxPackets = this.options.maxMuxingQueueSize ?? MAX_MUXING_QUEUE_SIZE;
      const dataThreshold = this.options.muxingQueueDataThreshold ?? MUXING_QUEUE_DATA_THRESHOLD;

      const currentPackets = streamInfo.preMuxQueue.length;
      const currentBytes = streamInfo.preMuxQueueDataSize;
      const packetSize = clonedPacket.size;

      const thresholdReached = currentBytes + packetSize > dataThreshold;
      const effectiveMaxPackets = thresholdReached ? maxPackets : Number.MAX_SAFE_INTEGER;

      // Check if we would exceed packet limit (only if threshold reached)
      if (currentPackets >= effectiveMaxPackets) {
        clonedPacket.free(); // Free the clone since we can't buffer it
        if (observed) {
          this.packetObserver?.onPacketRejected(streamIndex);
        }
        throw new Error(
          // eslint-disable-next-line @stylistic/max-len
          `Too many packets buffered for output stream ${streamIndex} (packets: ${currentPackets}, bytes: ${currentBytes}, threshold: ${dataThreshold}, max: ${maxPackets})`,
        );
      }

      // Buffer in PreMuxQueue (per-stream FIFO)
      streamInfo.preMuxQueue.push(clonedPacket);
      streamInfo.preMuxArrivals.push(arrival);
      streamInfo.preMuxQueueDataSize += packetSize;

      return; // Don't proceed to header write yet
    }
    // Automatically write header if not written yet
    if (!this.headerWritten) {
      this.headerWritePromise ??= (async () => {
        this.startWriteWorker();
        this.prepareHeaderWrite();

        const ret = await this.formatContext.writeHeader();
        FFmpegError.throwIfError(ret, 'Failed to write header');

        this.headerWritten = true;
        this.readHeaderSetup();

        // PHASE 2: Flush PreMuxQueue in DTS-sorted order (once after header write)
        // Packets go: PreMuxQueue → SyncQueue (if present) → Muxer
        // Concurrent writers keep queueing while headerWritePromise is set, also
        // after a flush found the queues empty. Drain until they are empty and
        // clear the promise in that same tick, or such packets are never written.
        do {
          await this.flushPreMuxQueues();
        } while (this.hasPreMuxPackets());
        this.headerWritePromise = undefined;
      })();

      await this.headerWritePromise;

      if (this.headerWritten) {
        this.headerWritePromise = undefined;
      }
    }

    // PHASE 3: Write packet - normal muxing after header
    if (this.syncQueue && streamInfo.sqIdxMux >= 0) {
      // Use SyncQueue for packet interleaving
      // NOTE: Do NOT set clonedPacket.timeBase here!
      // Packet must keep its source timebase (encoder timebase) so muxFixupTs can rescale correctly

      // Send packet to sync queue
      const ret = this.syncQueue.send(streamInfo.sqIdxMux, clonedPacket);

      // Handle errors from sq_send
      if (ret < 0) {
        if (observed) {
          this.packetObserver?.onPacketRejected(streamIndex);
        }
        if (ret === AVERROR_EOF) {
          // Stream finished - this is normal, just return
          return;
        }

        if (this.options.exitOnError) {
          FFmpegError.throwIfError(ret, 'Failed to send packet to sync queue');
        }
        return;
      }
      // The sync queue keeps each stream's packets in order and drops none.
      streamInfo.sqArrivals.push(arrival);

      // Receive synchronized packets from queue and write to muxer
      while (!this.isClosed) {
        const recvRet = this.syncQueue.receive(-1, this.sqPacket!);
        if (recvRet === AVERROR_EAGAIN) {
          break; // No more packets ready
        }
        if (recvRet === AVERROR_EOF) {
          break; // All streams finished
        }
        if (recvRet >= 0) {
          // recvRet is the stream index
          const recvStreamInfo = this._streams.get(recvRet)!;

          // Clone packet before writing (muxer takes ownership and will unref it)
          // We need to keep sqPacket alive for the next receive() call
          const pkt = this.sqPacket!.clone();
          if (!pkt) {
            throw new Error('Failed to clone packet from sync queue');
          }
          pkt.streamIndex = recvRet;

          // Write packet (muxer takes ownership)
          await this.write(pkt, recvStreamInfo, recvRet, recvStreamInfo.sqArrivals.shift() ?? 0);
        }
      }
    } else {
      // No sync queue needed - write directly
      clonedPacket.streamIndex = streamIndex;
      await this.write(clonedPacket, streamInfo, streamIndex, arrival);
    }
  }

  /**
   * Write a packet to the output synchronously.
   * Synchronous version of writePacket.
   *
   * Writes muxed packet to the specified stream.
   * Automatically handles:
   * - Stream initialization on first packet (lazy initialization)
   * - Codec parameter configuration from encoder or input stream
   * - Header writing on first packet
   * - Timestamp rescaling between source and output timebases
   * - Sync queue for proper interleaving
   *
   * For encoder sources, the encoder must have processed at least one frame
   * before packets can be written (encoder must be initialized).
   *
   * Uses FFmpeg CLI's sync queue pattern: buffers packets per stream and writes
   * them in DTS order using av_compare_ts for timebase-aware comparison.
   *
   * To signal EOF for a stream, pass null as the packet.
   * This tells the muxer that no more packets will be sent for this stream.
   * The trailer is written only when close() is called.
   *
   * Direct mapping to avformat_write_header() (on first packet) and av_interleaved_write_frame().
   *
   * @param packet - Packet to write (or null/undefined to signal EOF)
   *
   * @param streamIndex - Target stream index
   *
   * @throws {Error} If stream invalid or encoder not initialized
   *
   * @throws {Error} On a timestamp discontinuity the output cannot take (see {@link MuxerOptions.dtsBackwardThreshold})
   *
   * @throws {FFmpegError} If write fails
   *
   * @example
   * ```typescript
   * // Write encoded packet - header written automatically on first packet
   * const packet = encoder.encodeSync(frame);
   * if (packet) {
   *   output.writePacketSync(packet, videoIdx);
   *   packet.free();
   * }
   * ```
   *
   * @example
   * ```typescript
   * // Stream copy with packet processing
   * for (const packet of input.packetsSync()) {
   *   if (packet.streamIndex === inputVideoIdx) {
   *     output.writePacketSync(packet, outputVideoIdx);
   *   }
   *   packet.free();
   * }
   * ```
   *
   * @see {@link writePacket} For async version
   */
  writePacketSync(packet: Packet | null | undefined, streamIndex: number): void {
    if (this.isClosed) {
      throw new Error('Muxer is closed');
    }

    if (this.trailerWritten) {
      throw new Error('Cannot write packets after output is finalized');
    }

    if (!this._streams.get(streamIndex)) {
      throw new Error(`Invalid stream index: ${streamIndex}`);
    }

    // Initialize any encoder streams that are ready
    for (const streamInfo of this._streams.values()) {
      if (!streamInfo.initialized && streamInfo.encoder) {
        const encoder = streamInfo.encoder;
        const codecContext = encoder.getCodecContext();

        // Skip if encoder not ready yet
        if (!encoder.isEncoderInitialized || !codecContext) {
          continue;
        }

        // If a trailing bitstream filter is present, wait until it is initialized
        // so its output parameters (e.g. modified extradata) are available.
        if (streamInfo.bsf && !streamInfo.bsf.isInitialized) {
          continue;
        }

        // This encoder is ready, initialize it now
        // Read codecType from codecContext, not from stream (which is still uninitialized)
        const codecType = codecContext.codecType;

        // 1. Set stream timebase
        // Use encoder's timebase unless user specified custom timebase
        if (streamInfo.timeBase) {
          // User specified custom timebase
          streamInfo.outputStream.timeBase = new Rational(streamInfo.timeBase.num, streamInfo.timeBase.den);
        } else {
          // Use encoder's timebase directly
          // The encoder timebase is already set from the first frame in Encoder.initialize()
          streamInfo.outputStream.timeBase = new Rational(codecContext.timeBase.num, codecContext.timeBase.den);
        }

        // 2. Set stream avg_frame_rate, r_frame_rate and sample_aspect_ratio
        if (codecType === AVMEDIA_TYPE_VIDEO) {
          const fr = codecContext.framerate;
          streamInfo.outputStream.avgFrameRate = new Rational(fr.num, fr.den);
          streamInfo.outputStream.rFrameRate = new Rational(fr.num, fr.den);
          streamInfo.outputStream.sampleAspectRatio = codecContext.sampleAspectRatio;
        }

        // 3. Copy codec parameters from encoder context
        const ret = streamInfo.outputStream.codecpar.fromContext(codecContext);
        FFmpegError.throwIfError(ret, 'Failed to copy codec parameters from encoder');

        // 3b. Overlay the trailing bitstream filter's output parameters, so
        // container-level fields (e.g. extradata/level rewritten by h264_metadata)
        // reflect the filter's output rather than the raw encoder output.
        const bsfParams = streamInfo.bsf?.outputCodecParameters;
        if (bsfParams) {
          const bsfRet = bsfParams.copy(streamInfo.outputStream.codecpar);
          FFmpegError.throwIfError(bsfRet, 'Failed to copy codec parameters from bitstream filter');
        }

        // 4. Copy metadata from input stream
        if (streamInfo.inputStream) {
          const metadata = streamInfo.inputStream.metadata;
          if (metadata) {
            streamInfo.outputStream.metadata = metadata;
          }

          // 5. Copy disposition from input stream
          streamInfo.outputStream.disposition = streamInfo.inputStream.disposition;

          // 5b. Copy coded_side_data from input stream (display matrix / rotation,
          // HDR mastering display & content light level). The encoder path only
          // copied codec parameters, so without this these are lost on transcode
          // (e.g. a portrait phone video would play sideways). Mirrors the stream
          // copy path.
          const inputSideData = streamInfo.inputStream.codecpar.getAllCodedSideData();
          for (const sd of inputSideData) {
            streamInfo.outputStream.codecpar.addCodedSideData(sd.type, sd.data);
          }

          // 6. Copy duration hint from input stream
          if (streamInfo.inputStream.duration > 0n) {
            const inputTb = streamInfo.inputStream.timeBase;
            const outputTb = streamInfo.outputStream.timeBase;
            const rescaledDuration = avRescaleQ(streamInfo.inputStream.duration, inputTb, outputTb);
            streamInfo.outputStream.duration = rescaledDuration;
          }
        }

        // Update the source timebase for timestamp rescaling
        streamInfo.sourceTimeBase = codecContext.timeBase;

        // Mark as initialized
        streamInfo.initialized = true;
      }
    }

    const streamInfo = this._streams.get(streamIndex)!;

    // Handle NULL packet - signals EOF for this stream (FFmpeg pattern: av_interleaved_write_frame(s, NULL))
    // FFmpeg's behavior:
    // - If muxer not started (uninitialized streams), buffer NULL in PreMuxQueue as EOF marker
    // - If muxer started, send NULL to SyncQueue to signal EOF and flush
    if (!packet) {
      // Mark stream as EOF received
      streamInfo.eofReceived = true;

      // Check if any streams are still uninitialized (PreMuxQueue phase)
      const uninitialized = Array.from(this._streams.values()).some((s) => !s.initialized);

      // PHASE 1: Before muxer starts - buffer NULL packet in PreMuxQueue
      // This matches FFmpeg's mux_queue_packet() which writes NULL to PreMuxQueue FIFO
      if (uninitialized || this.headerWritePromise) {
        // Buffer NULL as EOF marker (no size contribution)
        streamInfo.preMuxQueue.push(null);
        streamInfo.preMuxArrivals.push(0);
        return;
      }

      // PHASE 2: After muxer started - send EOF to SyncQueue and flush
      if (!this.headerWritten) {
        return;
      }

      // If using SyncQueue, send EOF for this stream
      if (this.syncQueue && streamInfo.sqIdxMux >= 0) {
        // Send NULL to signal EOF to sync queue
        // Native side handles null correctly (sets sqframe.p = nullptr)
        const ret = this.syncQueue.send(streamInfo.sqIdxMux, null);

        if (ret < 0 && ret !== AVERROR_EOF) {
          if (this.options.exitOnError) {
            FFmpegError.throwIfError(ret, 'Failed to send EOF to sync queue');
          }
        }

        // Receive and write any remaining packets from sync queue
        while (!this.isClosed) {
          const recvRet = this.syncQueue.receive(-1, this.sqPacket!);
          if (recvRet === AVERROR_EAGAIN) {
            break; // No more packets ready
          }
          if (recvRet === AVERROR_EOF) {
            break; // All streams finished
          }
          if (recvRet >= 0) {
            const recvStreamInfo = this._streams.get(recvRet)!;
            const pkt = this.sqPacket!.clone();
            if (!pkt) {
              throw new Error('Failed to clone packet from sync queue');
            }
            pkt.streamIndex = recvRet;
            this.writeSync(pkt, recvStreamInfo, recvRet, recvStreamInfo.sqArrivals.shift() ?? 0);
          }
        }
      }

      return; // EOF signaled, nothing more to do
    }

    // Clone packet immediately - we will modify it and caller retains ownership
    const clonedPacket = packet.clone();
    if (!clonedPacket) {
      throw new Error('Failed to clone packet for writing');
    }

    const arrival = this.forwardThresholdMs > 0 ? this.clock() : 0;

    // Apply streamcopy filtering BEFORE buffering
    // This ensures rejected packets never enter the queue/buffer
    if (streamInfo.isStreamCopy) {
      const shouldWrite = this.ofStreamcopy(clonedPacket, streamInfo, streamIndex);
      if (!shouldWrite) {
        clonedPacket.free(); // Free the clone since we won't use it
        return;
      }
    } else if (this.options.startTime !== undefined) {
      // For encoded (non-streamcopy) streams, strip the device's startTime base.
      this.applyStartTimeOffset(clonedPacket, streamInfo);
    }

    // Announced on acceptance, so the observer also counts what waits in the
    // pre-mux queue for the header.
    const observed = this.announcePacket(clonedPacket, streamIndex);

    // Check if any streams are still uninitialized
    const uninitialized = Array.from(this._streams.values()).some((s) => !s.initialized);

    // PHASE 1: Before header write - ALWAYS buffer in PreMuxQueue
    // PreMuxQueue is used during initialization phase ONLY (regardless of SyncQueue presence)
    // After header write, PreMuxQueue is flushed in DTS-sorted order
    if (uninitialized) {
      // Check PreMuxQueue limits
      const maxPackets = this.options.maxMuxingQueueSize ?? MAX_MUXING_QUEUE_SIZE;
      const dataThreshold = this.options.muxingQueueDataThreshold ?? MUXING_QUEUE_DATA_THRESHOLD;

      const currentPackets = streamInfo.preMuxQueue.length;
      const currentBytes = streamInfo.preMuxQueueDataSize;
      const packetSize = clonedPacket.size;

      const thresholdReached = currentBytes + packetSize > dataThreshold;
      const effectiveMaxPackets = thresholdReached ? maxPackets : Number.MAX_SAFE_INTEGER;

      // Check if we would exceed packet limit (only if threshold reached)
      if (currentPackets >= effectiveMaxPackets) {
        clonedPacket.free(); // Free the clone since we can't buffer it
        if (observed) {
          this.packetObserver?.onPacketRejected(streamIndex);
        }
        throw new Error(
          // eslint-disable-next-line @stylistic/max-len
          `Too many packets buffered for output stream ${streamIndex} (packets: ${currentPackets}, bytes: ${currentBytes}, threshold: ${dataThreshold}, max: ${maxPackets})`,
        );
      }

      // Buffer in PreMuxQueue (per-stream FIFO)
      streamInfo.preMuxQueue.push(clonedPacket);
      streamInfo.preMuxArrivals.push(arrival);
      streamInfo.preMuxQueueDataSize += packetSize;

      return; // Don't proceed to header write yet
    }

    // Automatically write header if not written yet
    if (!this.headerWritten) {
      this.prepareHeaderWrite();

      const ret = this.formatContext.writeHeaderSync();
      FFmpegError.throwIfError(ret, 'Failed to write header');
      this.headerWritten = true;
      this.readHeaderSetup();

      // PHASE 2: Flush PreMuxQueue in DTS-sorted order (once after header write)
      // Packets go: PreMuxQueue → SyncQueue (if present) → Muxer
      this.flushPreMuxQueuesSync();
    }

    // PHASE 3: Write packet - normal muxing after header
    if (this.syncQueue && streamInfo.sqIdxMux >= 0) {
      // Use SyncQueue for packet interleaving
      // NOTE: Do NOT set clonedPacket.timeBase here!
      // Packet must keep its source timebase (encoder timebase) so muxFixupTs can rescale correctly

      // Send packet to sync queue
      const ret = this.syncQueue.send(streamInfo.sqIdxMux, clonedPacket);

      // Handle errors from sq_send
      if (ret < 0) {
        if (observed) {
          this.packetObserver?.onPacketRejected(streamIndex);
        }
        if (ret === AVERROR_EOF) {
          // Stream finished - this is normal, just return
          return;
        }

        if (this.options.exitOnError) {
          FFmpegError.throwIfError(ret, 'Failed to send packet to sync queue');
        }
        return;
      }
      streamInfo.sqArrivals.push(arrival);

      // Receive synchronized packets from queue and write to muxer
      while (!this.isClosed) {
        const recvRet = this.syncQueue.receive(-1, this.sqPacket!);
        if (recvRet === AVERROR_EAGAIN) {
          break; // No more packets ready
        }
        if (recvRet === AVERROR_EOF) {
          break; // All streams finished
        }
        if (recvRet >= 0) {
          // recvRet is the stream index
          const recvStreamInfo = this._streams.get(recvRet)!;

          // Clone packet before writing (muxer takes ownership and will unref it)
          // We need to keep sqPacket alive for the next receive() call
          const pkt = this.sqPacket!.clone();
          if (!pkt) {
            throw new Error('Failed to clone packet from sync queue');
          }
          pkt.streamIndex = recvRet;

          // Write packet (muxer takes ownership)
          this.writeSync(pkt, recvStreamInfo, recvRet, recvStreamInfo.sqArrivals.shift() ?? 0);
        }
      }
    } else {
      // No sync queue needed - write directly
      clonedPacket.streamIndex = streamIndex;
      this.writeSync(clonedPacket, streamInfo, streamIndex, arrival);
    }
  }

  /**
   * Close muxer and free resources.
   *
   * Automatically writes trailer if header was written.
   * Closes the output file and releases all resources.
   * Safe to call multiple times.
   * Automatically called by Symbol.asyncDispose.
   *
   * @example
   * ```typescript
   * const output = await Muxer.open('output.mp4');
   * try {
   *   // Use output - trailer written automatically on close
   * } finally {
   *   await output.close();
   * }
   * ```
   *
   * @throws {Error} If a background write failed and was not yet observed by the caller (resources are still released; a second close() is a no-op)
   *
   * @see {@link Symbol.asyncDispose} For automatic cleanup
   */
  async close(): Promise<void> {
    if (this.isClosed) {
      return;
    }

    this.isClosed = true;
    // Detached first, so the final flush can never fail on the observer.
    this.packetObserver = undefined;

    // A header write launched by a concurrent writePacket() must settle before
    // teardown: nulling pb / freeing the format context under a running
    // avformat_write_header() crashes on the worker thread. This happens when a
    // pipeline is stopped mid-startup - the reader task rejects the shared
    // completion while the writer task is still inside its first writePacket().
    if (this.headerWritePromise) {
      try {
        await this.headerWritePromise;
      } catch {
        // Ignore errors - teardown proceeds either way
      }
    }

    // Close write queue and wait for worker to finish.
    // The worker catches its own errors, but guard the await anyway so a
    // failed worker can never abort cleanup - resources below must always
    // be freed even after a write failure.
    if (this.writeQueue) {
      this.writeQueue.close();
      try {
        await this.writeWorkerPromise;
      } catch (error) {
        this.writeWorkerError ??= error instanceof Error ? error : new Error(String(error));
      }
      this.writeQueue.clear(); // Free any job packet the worker never consumed
    }

    // Free PreMuxQueue packets
    for (const streamInfo of this._streams.values()) {
      // Free any packets in PreMuxQueue
      for (const pkt of streamInfo.preMuxQueue) {
        pkt?.free();
      }
      streamInfo.preMuxQueue = [];
      streamInfo.preMuxArrivals = [];
    }

    // Free sync queue resources
    if (this.sqPacket) {
      this.sqPacket.free();
      this.sqPacket = undefined;
    }
    if (this.syncQueue) {
      this.syncQueue.free();
      this.syncQueue = undefined;
    }

    // Try to write trailer if header was written but trailer wasn't
    try {
      if (this.headerWritten && !this.trailerWritten && !this.trailerDiscarded) {
        await this.formatContext.writeTrailer();
        this.trailerWritten = true;
      }
    } catch {
      // Ignore errors
    }

    // Clear pb reference first to prevent use-after-free
    if (this.ioContext) {
      this.formatContext.pb = null;
    }

    // For file-based IO, close the file handle via closep - freeContext() alone
    // would release the AVIOContext but leak the underlying protocol handle,
    // leaving the file locked (EBUSY on Windows) until the process exits.
    // For custom IO, the context will be freed below
    if (this.ioContext && !this.customIO) {
      try {
        await this.ioContext.closep();
      } catch {
        // Ignore errors
      }
    }

    // Free format context
    if (this.formatContext) {
      try {
        this.formatContext.freeContext();
      } catch {
        // Ignore errors
      }
    }

    // Now free custom IO context if present
    if (this.ioContext && this.customIO) {
      try {
        this.ioContext.freeContext();
      } catch {
        // Ignore errors
      }
    }

    // Surface a background write failure the caller may not have observed yet.
    // Thrown only after all resources are freed - a second close() is a no-op.
    if (this.writeWorkerError) {
      throw this.writeWorkerError;
    }
  }

  /**
   * Close muxer and free resources synchronously.
   * Synchronous version of close.
   *
   * Automatically writes trailer if header was written.
   * Closes the output file and releases all resources.
   * Safe to call multiple times.
   * Automatically called by Symbol.dispose.
   *
   * @example
   * ```typescript
   * const output = Muxer.openSync('output.mp4');
   * try {
   *   // Use output - trailer written automatically on close
   * } finally {
   *   output.closeSync();
   * }
   * ```
   *
   * @see {@link close} For async version
   */
  closeSync(): void {
    if (this.isClosed) {
      return;
    }

    this.isClosed = true;
    this.packetObserver = undefined;

    // Free PreMuxQueue packets
    for (const streamInfo of this._streams.values()) {
      // Free any packets in PreMuxQueue
      for (const pkt of streamInfo.preMuxQueue) {
        pkt?.free();
      }
      streamInfo.preMuxQueue = [];
      streamInfo.preMuxArrivals = [];
    }

    // Free sync queue resources
    if (this.sqPacket) {
      this.sqPacket.free();
      this.sqPacket = undefined;
    }
    if (this.syncQueue) {
      this.syncQueue.free();
      this.syncQueue = undefined;
    }

    // Try to write trailer if header was written but trailer wasn't
    try {
      if (this.headerWritten && !this.trailerWritten && !this.trailerDiscarded) {
        this.formatContext.writeTrailerSync();
        this.trailerWritten = true;
      }
    } catch {
      // Ignore errors
    }

    // Clear pb reference first to prevent use-after-free
    if (this.ioContext) {
      this.formatContext.pb = null;
    }

    // For file-based IO, close the file handle via closep
    // For custom IO, the context will be freed below
    if (this.ioContext && !this.customIO) {
      try {
        this.ioContext.closepSync();
      } catch {
        // Ignore errors
      }
    }

    // Free format context
    if (this.formatContext) {
      try {
        this.formatContext.freeContext();
      } catch {
        // Ignore errors
      }
    }

    // Now free custom IO context if present
    if (this.ioContext && this.customIO) {
      try {
        this.ioContext.freeContext();
      } catch {
        // Ignore errors
      }
    }
  }

  /**
   * Get underlying format context.
   *
   * Returns the internal format context for advanced operations.
   *
   * @returns Format context
   *
   * @internal
   */
  getFormatContext(): FormatContext {
    return this.formatContext;
  }

  /**
   * Follow the packets this muxer accepts for writing.
   *
   * The observer hears about every packet with payload once it is accepted
   * (before it waits in the pre-mux queue or reaches libavformat) and about
   * every such packet that is dropped later, so together with the output it
   * knows what the muxer holds. close() detaches it.
   *
   * @param observer - Observer, or undefined to detach
   *
   * @internal
   */
  setPacketObserver(observer: MuxerPacketObserver | undefined): void {
    this.packetObserver = observer;
  }

  /**
   * Replace the clock that stamps packet arrival times for the dtsForwardThreshold check.
   *
   * Lets tests drive real time deterministically. Set it before the first packet.
   *
   * @param clock - Monotonic time in ms
   *
   * @internal
   */
  setClock(clock: () => number): void {
    this.clock = clock;
  }

  /**
   * Make close() skip the trailer.
   *
   * For owners that drop whatever the muxer still emits, such as FMP4Stream
   * after a failed session: the trailer would only push libavformat's backlog
   * into the void, and movenc asserts on some track states a failed session
   * can leave behind. The backlog is freed with the format context instead.
   *
   * @internal
   */
  discardOnClose(): void {
    this.trailerDiscarded = true;
  }

  /**
   * Announce a packet the muxer has accepted to the packet observer.
   *
   * @param pkt - The muxer's clone of the packet
   *
   * @param streamIndex - Output stream index
   *
   * @returns True when the observer now tracks the packet
   *
   * @throws {Error} If the observer fails the write (the clone is freed)
   *
   * @internal
   */
  private announcePacket(pkt: Packet, streamIndex: number): boolean {
    // movenc drops packets without payload instead of storing a sample.
    if (this.packetObserver === undefined || pkt.size <= 0) {
      return false;
    }
    try {
      this.packetObserver.onPacket(streamIndex);
    } catch (error) {
      pkt.free();
      throw error;
    }
    return true;
  }

  /**
   * Apply shared pre-header setup for writePacket and writePacketSync.
   *
   * Configures sync queues, dispositions and container metadata, then applies
   * user-provided context options and the configure callback. Must run
   * immediately before writing the header so both variants stay in sync.
   *
   * @internal
   */
  private prepareHeaderWrite(): void {
    this.setupSyncQueues();
    this.updateDefaultDisposition();
    this.copyContainerMetadata();

    applyContextOptions(this.formatContext, this.options.context);
    this.options.configure?.(this.formatContext);

    const oformat = this.formatContext.oformat;
    this.movSampleLimit = MOV_FAMILY_FORMATS.has(oformat?.name ?? '');
    this.tsNonStrict = oformat?.hasFlags(AVFMT_TS_NONSTRICT) ?? false;
  }

  /**
   * Read the muxing setup libavformat settles while writing the header.
   *
   * movenc decides on edit lists only then: without one (fragmented output
   * without delay_moov) it shifts the output to start at 0 and puts each
   * track's first sample there, which {@link checkMovLateStart} guards.
   *
   * @internal
   */
  private readHeaderSetup(): void {
    if (!this.movSampleLimit) {
      return;
    }

    const ctx = this.formatContext;
    this.movZeroStart = ctx.getOption('use_editlist', AV_OPT_TYPE_BOOL) === false && ctx.getOption('avoid_negative_ts', AV_OPT_TYPE_INT) === AVFMT_AVOID_NEG_TS_MAKE_ZERO;
    this.interleaveDeltaUs = ctx.maxInterleaveDelta;
  }

  /**
   * Setup sync queues based on stream configuration.
   *
   * Called before writing header.
   * Muxing sync queue is created only if nb_interleaved > nb_av_enc
   * (i.e., when there are streamcopy streams).
   *
   * All streams are added as non-limiting (FFmpeg default without -shortest),
   * which means no timestamp-based synchronization - frames are output immediately.
   *
   * @internal
   */
  private setupSyncQueues(): void {
    const nbInterleaved = this._streams.size; // All streams are interleaved (no attachments)
    const nbAvEnc = Array.from(this._streams.values()).filter((s) => !s.isStreamCopy).length;

    // FFmpeg's condition: if there are streamcopy streams (nb_interleaved > nb_av_enc),
    // then ALL streams use the sync queue (but as non-limiting, so no actual sync happens)
    const needsSyncQueue = this.options.useSyncQueue && nbInterleaved > nbAvEnc;

    if (needsSyncQueue && !this.syncQueue) {
      // Create sync queue
      const bufDurationSec = this.options.syncQueueBufferDuration ?? SYNC_BUFFER_DURATION;
      const bufSizeUs = bufDurationSec * 1000000; // Convert to microseconds
      this.syncQueue = SyncQueue.create(SyncQueueType.PACKETS, bufSizeUs);
      this.sqPacket = new Packet();
      this.sqPacket.alloc();

      // Add all streams to sync queue
      // FFmpeg standard (without -shortest): limiting = 0 (non-limiting)
      // This means frames are output immediately without synchronization
      for (const streamInfo of this._streams.values()) {
        streamInfo.sqIdxMux = this.syncQueue.addStream(0); // 0 = non-limiting
      }
    } else if (!needsSyncQueue && this.syncQueue) {
      // Free sync queue if we don't need it anymore
      this.sqPacket?.free();
      this.sqPacket = undefined;
      this.syncQueue.free();
      this.syncQueue = undefined;

      // Reset all sqIdxMux to -1
      for (const streamInfo of this._streams.values()) {
        streamInfo.sqIdxMux = -1;
      }
    }
  }

  /**
   * Whether any stream still holds packets (or an EOF marker) in its pre-mux queue.
   *
   * @returns True if a pre-mux queue is not empty
   *
   * @internal
   */
  private hasPreMuxPackets(): boolean {
    for (const streamInfo of this._streams.values()) {
      if (streamInfo.preMuxQueue.length > 0) {
        return true;
      }
    }
    return false;
  }

  /**
   * Flush all PreMuxQueues in DTS-sorted order.
   *
   * Implements FFmpeg's PreMuxQueue flush algorithm from mux_task_start().
   * Repeatedly finds the stream with the earliest DTS packet and sends it:
   * - WITH SyncQueue: Sends to SyncQueue for interleaving
   * - WITHOUT SyncQueue: Writes directly to muxer
   * NULL packets (EOF markers) and packets with AV_NOPTS_VALUE have priority (sent first).
   *
   * @internal
   */
  private async flushPreMuxQueues(): Promise<void> {
    while (true) {
      let minStreamInfo: StreamDescription | null = null;
      let minStreamIndex = -1;
      let minDts = AV_NOPTS_VALUE;
      let minTimeBase: IRational = { num: 1, den: 1 };

      // 1. Find stream with earliest DTS across all PreMuxQueues
      // FFmpeg logic: NULL packets and AV_NOPTS_VALUE packets have priority
      for (const [streamIndex, streamInfo] of this._streams) {
        if (streamInfo.preMuxQueue.length === 0) {
          continue;
        }

        const pkt = streamInfo.preMuxQueue[0]; // Peek at first packet (can be null)

        // NULL packets (EOF markers) have highest priority (FFmpeg: if (!pkt) -> priority)
        // Packets with AV_NOPTS_VALUE also have priority
        if (!pkt || pkt.dts === AV_NOPTS_VALUE) {
          minStreamInfo = streamInfo;
          minStreamIndex = streamIndex;
          break;
        }

        // Compare DTS with current minimum
        if (minDts === AV_NOPTS_VALUE || avCompareTs(pkt.dts, pkt.timeBase, minDts, minTimeBase) < 0) {
          minStreamInfo = streamInfo;
          minStreamIndex = streamIndex;
          minDts = pkt.dts;
          minTimeBase = pkt.timeBase;
        }
      }

      // 2. No more packets - all queues empty
      if (!minStreamInfo) {
        break;
      }

      // 3. Take packet from stream with earliest DTS (or NULL for EOF)
      const pkt = minStreamInfo.preMuxQueue.shift()!;
      const arrival = minStreamInfo.preMuxArrivals.shift() ?? 0;

      // 4. Handle NULL packet (EOF marker)
      // FFmpeg: if (pkt) { send packet } else { tq_send_finish() }
      if (!pkt) {
        // Signal EOF to SyncQueue for this stream
        if (this.syncQueue && minStreamInfo.sqIdxMux >= 0) {
          const ret = this.syncQueue.send(minStreamInfo.sqIdxMux, null);
          if (ret < 0 && ret !== AVERROR_EOF) {
            if (this.options.exitOnError) {
              FFmpegError.throwIfError(ret, 'Failed to send EOF to sync queue during PreMuxQueue flush');
            }
          }
        }
        // If not using SyncQueue, nothing to do - stream finished without data
        continue;
      }

      // 5. Normal packet - update data size and send
      minStreamInfo.preMuxQueueDataSize -= pkt.size;

      // 6. Send to SyncQueue or write directly
      pkt.streamIndex = minStreamIndex;
      if (this.syncQueue && minStreamInfo.sqIdxMux >= 0) {
        // Send to SyncQueue for interleaving
        // NOTE: Do NOT set pkt.timeBase here!
        // Packet must keep its source timebase so muxFixupTs can rescale correctly
        // pkt.timeBase = minStreamInfo.stream.timeBase;  // ❌ WRONG!
        const size = pkt.size;
        const ret = this.syncQueue.send(minStreamInfo.sqIdxMux, pkt);
        if (ret < 0 && size > 0) {
          this.packetObserver?.onPacketRejected(minStreamIndex);
        }
        if (ret >= 0) {
          minStreamInfo.sqArrivals.push(arrival);
        } else if (ret !== AVERROR_EOF) {
          if (this.options.exitOnError) {
            FFmpegError.throwIfError(ret, 'Failed to send packet to sync queue during PreMuxQueue flush');
          }
        }
      } else {
        // Write directly to muxer
        await this.write(pkt, minStreamInfo, minStreamIndex, arrival);
      }
    }

    // If using SyncQueue, receive and write all interleaved packets
    if (this.syncQueue) {
      while (!this.isClosed) {
        const recvRet = this.syncQueue.receive(-1, this.sqPacket!);
        if (recvRet === AVERROR_EAGAIN) {
          break; // No more packets ready
        }
        if (recvRet === AVERROR_EOF) {
          break; // All streams finished
        }
        if (recvRet >= 0) {
          // recvRet is the stream index
          const recvStreamInfo = this._streams.get(recvRet)!;

          // Clone packet before writing (muxer takes ownership and will unref it)
          const pkt = this.sqPacket!.clone();
          if (!pkt) {
            throw new Error('Failed to clone packet from sync queue during PreMuxQueue flush');
          }
          pkt.streamIndex = recvRet;

          // Write packet (muxer takes ownership)
          await this.write(pkt, recvStreamInfo, recvRet, recvStreamInfo.sqArrivals.shift() ?? 0);
        }
      }
    }
  }

  /**
   * Flush all PreMuxQueues in DTS-sorted order (synchronous version).
   *
   * Implements FFmpeg's PreMuxQueue flush algorithm from mux_task_start().
   * Repeatedly finds the stream with the earliest DTS packet and sends it:
   * - WITH SyncQueue: Sends to SyncQueue for interleaving
   * - WITHOUT SyncQueue: Writes directly to muxer
   * NULL packets (EOF markers) and packets with AV_NOPTS_VALUE have priority (sent first).
   *
   * @internal
   */
  private flushPreMuxQueuesSync(): void {
    while (true) {
      let minStreamInfo: StreamDescription | null = null;
      let minStreamIndex = -1;
      let minDts = AV_NOPTS_VALUE;
      let minTimeBase: IRational = { num: 1, den: 1 };

      // 1. Find stream with earliest DTS across all PreMuxQueues
      // FFmpeg logic: NULL packets and AV_NOPTS_VALUE packets have priority
      for (const [streamIndex, streamInfo] of this._streams) {
        if (streamInfo.preMuxQueue.length === 0) continue;

        const pkt = streamInfo.preMuxQueue[0]; // Peek at first packet (can be null)

        // NULL packets (EOF markers) have highest priority (FFmpeg: if (!pkt) -> priority)
        // Packets with AV_NOPTS_VALUE also have priority
        if (!pkt || pkt.dts === AV_NOPTS_VALUE) {
          minStreamInfo = streamInfo;
          minStreamIndex = streamIndex;
          break;
        }

        // Compare DTS with current minimum
        if (minDts === AV_NOPTS_VALUE || avCompareTs(pkt.dts, pkt.timeBase, minDts, minTimeBase) < 0) {
          minStreamInfo = streamInfo;
          minStreamIndex = streamIndex;
          minDts = pkt.dts;
          minTimeBase = pkt.timeBase;
        }
      }

      // 2. No more packets - all queues empty
      if (!minStreamInfo) break;

      // 3. Take packet from stream with earliest DTS (or NULL for EOF)
      const pkt = minStreamInfo.preMuxQueue.shift()!;
      const arrival = minStreamInfo.preMuxArrivals.shift() ?? 0;

      // 4. Handle NULL packet (EOF marker)
      // FFmpeg: if (pkt) { send packet } else { tq_send_finish() }
      if (!pkt) {
        // Signal EOF to SyncQueue for this stream
        if (this.syncQueue && minStreamInfo.sqIdxMux >= 0) {
          const ret = this.syncQueue.send(minStreamInfo.sqIdxMux, null);
          if (ret < 0 && ret !== AVERROR_EOF) {
            if (this.options.exitOnError) {
              FFmpegError.throwIfError(ret, 'Failed to send EOF to sync queue during PreMuxQueue flush');
            }
          }
        }
        // If not using SyncQueue, nothing to do - stream finished without data
        continue;
      }

      // 5. Normal packet - update data size and send
      minStreamInfo.preMuxQueueDataSize -= pkt.size;

      // 6. Send to SyncQueue or write directly
      pkt.streamIndex = minStreamIndex;
      if (this.syncQueue && minStreamInfo.sqIdxMux >= 0) {
        // Send to SyncQueue for interleaving
        // NOTE: Do NOT set pkt.timeBase here!
        // Packet must keep its source timebase so muxFixupTs can rescale correctly
        // pkt.timeBase = minStreamInfo.stream.timeBase;  // ❌ WRONG!
        const size = pkt.size;
        const ret = this.syncQueue.send(minStreamInfo.sqIdxMux, pkt);
        if (ret < 0 && size > 0) {
          this.packetObserver?.onPacketRejected(minStreamIndex);
        }
        if (ret >= 0) {
          minStreamInfo.sqArrivals.push(arrival);
        } else if (ret !== AVERROR_EOF) {
          if (this.options.exitOnError) {
            FFmpegError.throwIfError(ret, 'Failed to send packet to sync queue during PreMuxQueue flush');
          }
        }
      } else {
        // Write directly to muxer
        this.writeSync(pkt, minStreamInfo, minStreamIndex, arrival);
      }
    }

    // If using SyncQueue, receive and write all interleaved packets
    if (this.syncQueue) {
      while (!this.isClosed) {
        const recvRet = this.syncQueue.receive(-1, this.sqPacket!);
        if (recvRet === AVERROR_EAGAIN) {
          break; // No more packets ready
        }
        if (recvRet === AVERROR_EOF) {
          break; // All streams finished
        }
        if (recvRet >= 0) {
          // recvRet is the stream index
          const recvStreamInfo = this._streams.get(recvRet)!;

          // Clone packet before writing (muxer takes ownership and will unref it)
          const pkt = this.sqPacket!.clone();
          if (!pkt) {
            throw new Error('Failed to clone packet from sync queue during PreMuxQueue flush');
          }
          pkt.streamIndex = recvRet;

          // Write packet (muxer takes ownership)
          this.writeSync(pkt, recvStreamInfo, recvRet, recvStreamInfo.sqArrivals.shift() ?? 0);
        }
      }
    }
  }

  /**
   * Write a packet to the output.
   *
   * @param pkt - Packet to write
   *
   * @param streamInfo - Stream description
   *
   * @param streamIndex - Stream index
   *
   * @param arrival - When the packet reached the muxer (ms on the arrival clock)
   *
   * @internal
   */
  private async write(pkt: Packet, streamInfo: StreamDescription, streamIndex: number, arrival: number): Promise<void> {
    if (this.writeQueue) {
      // Use async queue for serialized writes.
      // If the worker died with a write error, the queue is poisoned and send()
      // rethrows that error - free the clone since it never reaches the worker.
      try {
        await this.writeQueue.send({ pkt, streamInfo, streamIndex, arrival });
      } catch (error) {
        pkt.free();
        throw error;
      }
    } else {
      // Direct write without serialization
      await this.writeInternal(pkt, streamInfo, streamIndex, arrival);
    }
  }

  /**
   * Internal write implementation.
   * Called either directly or through the write worker.
   *
   * @param pkt - Packet to write
   *
   * @param streamInfo - Stream description
   *
   * @param streamIndex - Stream index
   *
   * @param arrival - When the packet reached the muxer (ms on the arrival clock)
   *
   * @internal
   */
  private async writeInternal(pkt: Packet, streamInfo: StreamDescription, streamIndex: number, arrival: number): Promise<void> {
    // Read before the write moves the payload out (see announcePacket()).
    const observed = this.packetObserver !== undefined && pkt.size > 0;
    let accepted = false;
    try {
      // Fix timestamps (rescale, DTS>PTS fix, monotonic DTS enforcement)
      this.muxFixupTs(pkt, streamInfo, streamIndex, arrival);

      // Write the packet (muxer takes ownership and will unref it)
      // NOTE: Caller must clone packet if they need to keep it (e.g., for SyncQueue)
      const ret = await this.formatContext.interleavedWriteFrame(pkt);
      accepted = ret >= 0;

      // Handle write errors
      if (ret < 0 && ret !== AVERROR_EOF) {
        if (this.options.exitOnError) {
          FFmpegError.throwIfError(ret, 'Failed to write packet');
        }
      }
    } finally {
      if (observed && !accepted) {
        this.packetObserver?.onPacketRejected(streamIndex);
      }
      // Every packet reaching here is a clone this class made, and the write
      // has consumed its contents. Release the struct now instead of leaving a
      // GC-sized backlog of them behind - this is the last owner.
      pkt.free();
    }
  }

  /**
   * Start background worker for async write queue.
   * Processes write jobs sequentially to prevent race conditions.
   *
   * @internal
   */
  private startWriteWorker(): void {
    if (!this.options.useAsyncWrite || this._streams.size <= 1) {
      return;
    }

    this.writeQueue ??= new AsyncQueue<WriteJob>(1, (job) => job.pkt.free()); // size=1 for strict serialization

    this.writeWorkerPromise ??= (async () => {
      try {
        while (true) {
          const job = await this.writeQueue!.receive();
          if (!job) break; // Queue closed
          await this.writeInternal(job.pkt, job.streamInfo, job.streamIndex, job.arrival);
        }
      } catch (error) {
        // A write failure kills the worker. Without propagation the next send()
        // would block forever on a queue nobody drains (pipeline deadlock), so
        // store the error and poison the queue: pending and future send() calls
        // throw it instead of hanging. close() surfaces it after cleanup.
        const err = error instanceof Error ? error : new Error(String(error));
        this.writeWorkerError = err;
        this.writeQueue?.closeWithError(err);
        this.writeQueue?.clear(); // Free any job packet still buffered
      }
    })();
  }

  /**
   * Write a packet to the output synchronously.
   * Synchronous version of write.
   *
   * @param pkt - Packet to write
   *
   * @param streamInfo - Stream description
   *
   * @param streamIndex - Stream index
   *
   * @param arrival - When the packet reached the muxer (ms on the arrival clock)
   *
   * @internal
   */
  private writeSync(pkt: Packet, streamInfo: StreamDescription, streamIndex: number, arrival: number): void {
    const observed = this.packetObserver !== undefined && pkt.size > 0;
    let accepted = false;
    try {
      // Fix timestamps (rescale, DTS>PTS fix, monotonic DTS enforcement)
      this.muxFixupTs(pkt, streamInfo, streamIndex, arrival);

      // Write the packet (muxer takes ownership and will unref it)
      // NOTE: Caller must clone packet if they need to keep it (e.g., for SyncQueue)
      const ret = this.formatContext.interleavedWriteFrameSync(pkt);
      accepted = ret >= 0;

      FFmpegError.throwIfError(ret, 'Failed to write packet');
    } finally {
      if (observed && !accepted) {
        this.packetObserver?.onPacketRejected(streamIndex);
      }
      // See writeInternal(): this is the last owner of the clone.
      pkt.free();
    }
  }

  /**
   * Streamcopy packet filtering and timestamp offset.
   *
   * Applies streamcopy-specific logic before muxing:
   * 1. Recording time limit check
   * 2. Skip non-keyframe packets at start (unless copyInitialNonkeyframes)
   * 3. Skip packets before ts_copy_start (unless copyPriorStart)
   * 4. Skip packets before startTime
   * 5. Apply start_time timestamp offset
   *
   * @param pkt - Packet to process
   *
   * @param streamInfo - Stream description
   *
   * @param streamIndex - Stream index
   *
   * @returns true if packet should be written, false if packet should be skipped
   *
   * @throws {Error} If recording time limit reached
   *
   * @internal
   */

  /**
   * Apply the configured `startTime` offset to an encoded packet, per stream.
   *
   * `startTime` exists to strip a device's boot-relative timestamp base (e.g. the
   * mach uptime avfoundation reports). But not every stream of an output carries
   * that base (e.g. zero-based audio next to device video), so subtracting a large
   * device startTime from such a stream would push its timestamps hugely negative and
   * produce a broken/overflowed edit list that strict players (QuickTime) reject. The
   * effective offset is therefore decided once on the stream's first packet and
   * clamped to what the stream actually carries —
   * `min(startTime, max(0, firstPts))`: boot-relative streams normalize to zero,
   * already-zero-based streams are left untouched.
   *
   * @param packet - Cloned packet to adjust in place
   *
   * @param streamInfo - Per-stream muxing state
   *
   * @internal
   */
  private applyStartTimeOffset(packet: Packet, streamInfo: StreamDescription): void {
    if (this.options.startTime === undefined) {
      return;
    }

    if (streamInfo.startTimeOffset === undefined) {
      const startTimeUs = BigInt(Math.floor(this.options.startTime * 1000000));
      const requested = avRescaleQ(startTimeUs, AV_TIME_BASE_Q, packet.timeBase);
      const firstTs = packet.pts !== AV_NOPTS_VALUE ? packet.pts : packet.dts;
      const carried = firstTs !== AV_NOPTS_VALUE && firstTs > 0n ? firstTs : 0n;
      streamInfo.startTimeOffset = requested < carried ? requested : carried;
    }

    const offset = streamInfo.startTimeOffset;
    if (offset === 0n) {
      return;
    }
    if (packet.pts !== AV_NOPTS_VALUE) {
      packet.pts -= offset;
    }
    if (packet.dts !== AV_NOPTS_VALUE) {
      packet.dts -= offset;
    }
  }

  private ofStreamcopy(pkt: Packet, streamInfo: StreamDescription, streamIndex: number): boolean {
    const outputStream = this.formatContext.streams[streamIndex];
    if (!outputStream) {
      return false;
    }

    // Get DTS in AV_TIME_BASE for comparison
    // Use packet DTS directly
    const dts = pkt.dts !== AV_NOPTS_VALUE ? avRescaleQ(pkt.dts, pkt.timeBase, AV_TIME_BASE_Q) : AV_NOPTS_VALUE;
    const startTimeUs = this.options.startTime !== undefined ? BigInt(Math.floor(this.options.startTime * 1000000)) : AV_NOPTS_VALUE;

    // 1. Skip non-keyframes at start
    const copyInitialNonkeyframes = this.options.copyInitialNonkeyframes ?? false;
    if (!streamInfo.streamcopyStarted && !pkt.isKeyframe && !copyInitialNonkeyframes) {
      return false; // skip packet
    }

    // 2. Copy from specific start point
    if (!streamInfo.streamcopyStarted) {
      const copyPriorStart = this.options.copyPriorStart ?? -1;

      // Calculate ts_copy_start
      // Since we don't have input file timestamps, ts_copy_start is simply startTime or 0
      const tsCopyStart = startTimeUs !== AV_NOPTS_VALUE ? startTimeUs : 0n;

      // Only check ts_copy_start if copyPriorStart is not set (0 or -1)
      if (copyPriorStart !== 1 && tsCopyStart > 0n) {
        const pktTsUs = pkt.pts !== AV_NOPTS_VALUE ? avRescaleQ(pkt.pts, pkt.timeBase, AV_TIME_BASE_Q) : dts;

        if (pktTsUs !== AV_NOPTS_VALUE && pktTsUs < tsCopyStart) {
          return false; // skip packet
        }
      }

      // 3. Skip packets before startTime
      if (startTimeUs !== AV_NOPTS_VALUE && dts !== AV_NOPTS_VALUE && dts < startTimeUs) {
        return false; // skip packet
      }
    }

    // 4. Apply start_time timestamp offset
    // FFmpeg uses: start_time = (of->start_time == AV_NOPTS_VALUE) ? 0 : of->start_time
    const startForOffset = startTimeUs !== AV_NOPTS_VALUE ? startTimeUs : 0n;
    const tsOffset = avRescaleQ(startForOffset, AV_TIME_BASE_Q, pkt.timeBase);

    if (pkt.pts !== AV_NOPTS_VALUE) {
      pkt.pts -= tsOffset;
    }

    if (pkt.dts === AV_NOPTS_VALUE) {
      // If DTS missing, use our estimated DTS
      if (dts !== AV_NOPTS_VALUE) {
        pkt.dts = avRescaleQ(dts, AV_TIME_BASE_Q, pkt.timeBase);
      }
    } else if (outputStream.codecpar.codecType === AVMEDIA_TYPE_AUDIO) {
      // Audio: PTS = DTS - ts_offset
      pkt.pts = pkt.dts - tsOffset;
    }

    if (pkt.dts !== AV_NOPTS_VALUE) {
      pkt.dts -= tsOffset;
    }

    // Mark streamcopy as started
    streamInfo.streamcopyStarted = true;

    return true; // Packet should be written
  }

  /**
   * Fix packet timestamps before muxing.
   *
   * Performs timestamp corrections:
   * 1. Rescales timestamps to output timebase (av_rescale_delta for audio streamcopy)
   * 2. Sets pkt.timeBase to output stream timebase
   * 3. Rejects backward jumps beyond dtsBackwardThreshold
   * 4. Fixes invalid DTS > PTS relationships
   * 5. Enforces monotonic DTS (never decreasing), shrinking a clamped packet's duration to the clamped step
   * 6. Rejects forward jumps that run ahead of real time beyond dtsForwardThreshold
   * 7. Rejects DTS steps/durations a movenc output cannot store, and a late stream's first packet before its start
   *
   * The stream's last muxed DTS only advances when the packet is accepted and
   * carries a DTS.
   *
   * @param pkt - Packet to fix
   *
   * @param streamInfo - Stream description
   *
   * @param streamIndex - Stream index
   *
   * @param arrival - When the packet reached the muxer (ms on the arrival clock)
   *
   * @throws {Error} On a rejected timestamp discontinuity
   *
   * @internal
   */
  private muxFixupTs(pkt: Packet, streamInfo: StreamDescription, streamIndex: number, arrival: number): void {
    const outputStream = streamInfo.outputStream;
    // Both are final once the header is written, which happens before the
    // first packet gets here.
    const dstTb = (streamInfo.muxTimeBase ??= outputStream.timeBase);
    const codecType = (streamInfo.muxCodecType ??= outputStream.codecpar.codecType);
    const lastMuxDts = streamInfo.lastMuxDts;

    // Every timestamp getter is a native call returning a new BigInt, so each
    // value is read once, corrected in locals, and only changes are written back.
    let dts = pkt.dts;
    let pts = pkt.pts;

    // Check if timestamps are valid before rescaling
    // FFmpeg's av_rescale_q/av_rescale_delta don't accept AV_NOPTS_VALUE
    if (dts === AV_NOPTS_VALUE && pts === AV_NOPTS_VALUE) {
      // Set packet timebase anyway for muxer
      pkt.timeBase = dstTb;
      return;
    }

    // 1. Rescale timestamps to the stream timebase
    const srcTb = streamInfo.sourceTimeBase!;
    if (codecType === AVMEDIA_TYPE_AUDIO && streamInfo.isStreamCopy) {
      const codecpar = outputStream.codecpar;
      let duration = avGetAudioFrameDuration2(codecpar, pkt.size);
      if (!duration) {
        duration = codecpar.frameSize;
      }

      const fsTb: IRational = { num: 1, den: codecpar.sampleRate };

      dts = avRescaleDelta(srcTb, dts, fsTb, duration, streamInfo.tsRescaleDeltaLast, dstTb);
      pts = dts;
      pkt.dts = dts;
      pkt.pts = pts;

      pkt.duration = avRescaleQ(pkt.duration, srcTb, dstTb);
    } else {
      // For video or encoded audio, use regular rescaling
      pkt.rescaleTs(srcTb, dstTb);
      dts = pkt.dts;
      pts = pkt.pts;
    }

    // 2. Set packet timeBase
    // av_interleaved_write_frame uses this for sorting!
    pkt.timeBase = dstTb;

    const isAudioVideo = codecType === AVMEDIA_TYPE_AUDIO || codecType === AVMEDIA_TYPE_VIDEO;

    // 3. Reject a large backward jump while it is still visible - the corrections
    // below would turn it into a run of one-tick steps
    if (isAudioVideo) {
      this.checkBackwardDts(dts, lastMuxDts, dstTb, streamIndex);
    }

    // 4. Fix DTS > PTS (invalid relationship)
    // FFmpeg formula: median of (pts, dts, last_mux_dts+1)
    if (dts !== AV_NOPTS_VALUE && pts !== AV_NOPTS_VALUE && dts > pts) {
      const last = lastMuxDts !== AV_NOPTS_VALUE ? lastMuxDts + 1n : 0n;
      const min = pts < dts ? (pts < last ? pts : last) : dts < last ? dts : last;
      const max = pts > dts ? (pts > last ? pts : last) : dts > last ? dts : last;
      const median = pts + dts + last - min - max;
      pts = median;
      dts = median;
      pkt.pts = median;
      pkt.dts = median;
    }

    // 5. Enforce monotonic DTS
    let clampedDuration: bigint | undefined;
    if (isAudioVideo && dts !== AV_NOPTS_VALUE && lastMuxDts !== AV_NOPTS_VALUE) {
      // FFmpeg: max = last_mux_dts + !(oformat->flags & AVFMT_TS_NONSTRICT)
      // AVFMT_TS_NONSTRICT allows non-strict monotonic timestamps (equal DTS is OK)
      const max = lastMuxDts + (this.tsNonStrict ? 0n : 1n);
      if (dts < max) {
        // Adjust PTS if it would create invalid relationship
        if (pts !== AV_NOPTS_VALUE && pts >= dts && pts < max) {
          pts = max;
          pkt.pts = max;
        }
        dts = max;
        pkt.dts = max;

        // The clamped packet must not keep its source duration: after a fragment
        // flush movenc continues the track at the previous DTS plus its duration,
        // which then lies ahead of the clamped timeline. movenc corrects that by
        // moving later DTS itself and can end with a negative sample duration
        // (av_assert0 in get_cluster_duration). A duration of 0 does not help -
        // mux.c guesses a new one - so use the clamped step.
        if (max > lastMuxDts) {
          clampedDuration = max - lastMuxDts;
          pkt.duration = clampedDuration;
        }
      }
    }

    // mux.c derives a missing DTS from the PTS and never above it (its PTS-0
    // fallback aside, which only steps one frame), so the PTS stands in for the
    // DTS of such a packet in the checks below.
    const ts = dts !== AV_NOPTS_VALUE ? dts : pts;

    // 6. Reject a forward jump on the DTS libavformat would see, before the
    // packet enters it: once in, movenc takes the jump as the duration of the
    // stream's previous sample.
    let forwardOffset = NaN;
    if (isAudioVideo && this.forwardThresholdMs > 0) {
      forwardOffset = this.checkForwardDts(ts, arrival, streamInfo, streamIndex);
    }

    // 7. Reject what movenc cannot store before it reaches its abort
    if (this.movSampleLimit) {
      const duration = clampedDuration ?? pkt.duration;
      this.checkMovSampleDuration(ts, duration, lastMuxDts, dstTb, streamIndex);
      if (this.movZeroStart && streamInfo.firstMuxTs === undefined) {
        this.checkMovLateStart(ts, duration, dstTb, streamIndex);
      }
    }

    // 8. Update last mux DTS for next packet. mux.c fills a missing DTS itself
    // and rejects it unless it lies past the previous one, so the last known
    // DTS stays a valid reference: the clamp and the guards remain armed for
    // the next packet instead of letting it through unchecked.
    if (dts !== AV_NOPTS_VALUE) {
      streamInfo.lastMuxDts = dts;
    }
    streamInfo.firstMuxTs ??= ts;
    if (streamInfo.forward && !Number.isNaN(forwardOffset)) {
      this.recordForwardDts(streamInfo.forward, ts, forwardOffset, arrival);
    }
  }

  /**
   * Reject a packet whose DTS lies further behind the stream's last muxed DTS
   * than the configured dtsBackwardThreshold.
   *
   * Expects the DTS already rescaled to the output stream time base. No-op when
   * the threshold is unset or 0.
   *
   * @param dts - Packet DTS in the output time base
   *
   * @param lastMuxDts - The stream's last muxed DTS
   *
   * @param timeBase - Output stream time base
   *
   * @param streamIndex - Stream index
   *
   * @throws {Error} If the backward jump exceeds the threshold
   *
   * @internal
   */
  private checkBackwardDts(dts: bigint, lastMuxDts: bigint, timeBase: IRational, streamIndex: number): void {
    const threshold = this.options.dtsBackwardThreshold;
    if (!threshold || dts === AV_NOPTS_VALUE || lastMuxDts === AV_NOPTS_VALUE || dts >= lastMuxDts) {
      return;
    }

    const regression = lastMuxDts - dts;
    const thresholdUs = BigInt(Math.round(threshold * 1_000_000));
    if (avCompareTs(regression, timeBase, thresholdUs, AV_TIME_BASE_Q) <= 0) {
      return;
    }

    const seconds = ((Number(regression) * timeBase.num) / timeBase.den).toFixed(3);
    throw new Error(`Timestamp discontinuity on output stream ${streamIndex}: DTS jumped back ${seconds}s, more than dtsBackwardThreshold (${threshold}s)`);
  }

  /**
   * Reject a packet whose DTS runs further ahead of real time than the
   * configured dtsForwardThreshold.
   *
   * Tracks per stream how real time and media time move apart (the offset) and
   * compares the packet's offset with the lowest one of the stream's recent
   * packets, see FORWARD_WINDOW_BUCKET. A gap in a live source leaves the
   * offset level, since the wait comes with it; a jump lowers it by the size
   * of the jump. The stream's first packet only sets the starting point.
   *
   * @param ts - Final packet DTS (PTS without DTS) in the output time base
   *
   * @param arrival - When the packet reached the muxer (ms on the arrival clock)
   *
   * @param streamInfo - Stream description
   *
   * @param streamIndex - Stream index
   *
   * @returns The packet's offset, for {@link recordForwardDts} once the packet is accepted
   *
   * @throws {Error} If the DTS runs ahead of real time by more than the threshold
   *
   * @internal
   */
  private checkForwardDts(ts: bigint, arrival: number, streamInfo: StreamDescription, streamIndex: number): number {
    const tb = streamInfo.muxTimeBase!;
    const state = (streamInfo.forward ??= {
      msPerTick: (1000 * tb.num) / tb.den,
      lastTs: AV_NOPTS_VALUE,
      lastArrival: NaN,
      offset: 0,
      windowMin: Infinity,
      windowPrevMin: Infinity,
      windowCount: 0,
    });
    if (Number.isNaN(state.lastArrival)) {
      return 0;
    }

    const stepMs = Number(ts - state.lastTs) * state.msPerTick;
    const elapsedMs = arrival - state.lastArrival;
    const offset = state.offset + elapsedMs - stepMs;
    const reference = state.windowMin < state.windowPrevMin ? state.windowMin : state.windowPrevMin;
    if (reference - offset <= this.forwardThresholdMs) {
      return offset;
    }

    const jump = `DTS jumped forward ${(stepMs / 1000).toFixed(3)}s while ${(elapsedMs / 1000).toFixed(3)}s passed`;
    throw new Error(`Timestamp discontinuity on output stream ${streamIndex}: ${jump}, more than dtsForwardThreshold (${this.options.dtsForwardThreshold}s)`);
  }

  /**
   * Make an accepted packet the reference of the stream's next forward check.
   *
   * @param state - The stream's forward check state
   *
   * @param ts - The packet's DTS (PTS without DTS) in the output time base
   *
   * @param offset - The packet's offset from {@link checkForwardDts}
   *
   * @param arrival - When the packet reached the muxer (ms on the arrival clock)
   *
   * @internal
   */
  private recordForwardDts(state: ForwardDtsState, ts: bigint, offset: number, arrival: number): void {
    state.lastTs = ts;
    state.offset = offset;
    state.lastArrival = arrival;
    if (offset < state.windowMin) {
      state.windowMin = offset;
    }
    // Two buckets keep the window between one and two buckets long in O(1).
    if (++state.windowCount >= FORWARD_WINDOW_BUCKET) {
      state.windowPrevMin = state.windowMin;
      state.windowMin = Infinity;
      state.windowCount = 0;
    }
  }

  /**
   * Reject a packet whose DTS step or duration a movenc output cannot store.
   *
   * Runs after the monotonic clamp, on the DTS movenc will see. Steps are
   * measured against the stream's last muxed DTS.
   *
   * @param dts - Final packet DTS, or its PTS for a packet without DTS
   *
   * @param duration - Final packet duration
   *
   * @param lastMuxDts - The stream's last muxed DTS
   *
   * @param timeBase - Output stream time base
   *
   * @param streamIndex - Stream index
   *
   * @throws {Error} If the step or duration reaches INT_MAX ticks
   *
   * @internal
   */
  private checkMovSampleDuration(dts: bigint, duration: bigint, lastMuxDts: bigint, timeBase: IRational, streamIndex: number): void {
    const step = dts !== AV_NOPTS_VALUE && lastMuxDts !== AV_NOPTS_VALUE ? dts - lastMuxDts : 0n;
    const ticks = step >= MOV_SAMPLE_DURATION_LIMIT ? step : duration >= MOV_SAMPLE_DURATION_LIMIT ? duration : undefined;
    if (ticks === undefined) {
      return;
    }

    const what = ticks === step ? 'DTS jumped forward' : 'packet duration is';
    const seconds = ((Number(ticks) * timeBase.num) / timeBase.den).toFixed(3);
    const format = this.formatContext.oformat?.name ?? 'mov';
    const detail = `${what} ${ticks} ticks (${seconds}s at time base ${timeBase.num}/${timeBase.den})`;
    throw new Error(
      `Timestamp discontinuity on output stream ${streamIndex}: ${detail}, but ${format} sample durations must stay below ${MOV_SAMPLE_DURATION_LIMIT} ticks`,
    );
  }

  /**
   * Reject a stream's first packet that ends before the output's start.
   *
   * Without an edit list movenc puts each track's first sample at the output's
   * start, so a first packet that ends before it becomes a sample of negative
   * duration, and movenc aborts the process (av_assert0 in
   * get_cluster_duration) at the next fragment or the trailer unless a second
   * sample reaches it first. libavformat sets that start from the lowest DTS
   * it holds when it writes its first packet. It holds every packet until each
   * stream has sent one or its queue spans max_interleave_delta, so only a
   * stream that starts that much later than the others can land before it.
   *
   * @param ts - Packet DTS (PTS without DTS) in the output time base
   *
   * @param duration - Packet duration
   *
   * @param timeBase - Output stream time base
   *
   * @param streamIndex - Stream index
   *
   * @throws {Error} If the packet ends before a start libavformat may already have set
   *
   * @internal
   */
  private checkMovLateStart(ts: bigint, duration: bigint, timeBase: IRational, streamIndex: number): void {
    if (this.interleaveDeltaUs <= 0n) {
      return;
    }

    // The other streams' earliest and latest timestamp so far, in µs
    let start: { ts: bigint; timeBase: IRational; index: number } | undefined;
    let startUs = 0n;
    let latestUs = 0n;
    for (const [index, other] of this._streams) {
      const first = other.firstMuxTs;
      const otherTb = other.muxTimeBase;
      if (first === undefined || !otherTb) {
        continue;
      }
      const firstUs = avRescaleQ(first, otherTb, AV_TIME_BASE_Q);
      const lastUs = other.lastMuxDts !== AV_NOPTS_VALUE ? avRescaleQ(other.lastMuxDts, otherTb, AV_TIME_BASE_Q) : firstUs;
      if (!start) {
        latestUs = lastUs;
      } else if (lastUs > latestUs) {
        latestUs = lastUs;
      }
      if (!start || firstUs < startUs) {
        start = { ts: first, timeBase: otherTb, index };
        startUs = firstUs;
      }
    }
    // Until its queue spans max_interleave_delta, libavformat has written nothing
    // and will start the output at this packet if it is the lowest.
    if (!start || latestUs - startUs <= this.interleaveDeltaUs) {
      return;
    }

    const end = ts + (duration > 0n ? duration : 0n);
    if (avCompareTs(end, timeBase, start.ts, start.timeBase) >= 0) {
      return;
    }

    const seconds = (Number(startUs - avRescaleQ(end, timeBase, AV_TIME_BASE_Q)) / 1_000_000).toFixed(3);
    const format = this.formatContext.oformat?.name ?? 'mov';
    const detail = `its first packet ends ${seconds}s before the start of output stream ${start.index}`;
    throw new Error(`Timestamp discontinuity on output stream ${streamIndex}: ${detail}, which ${format} without an edit list cannot store`);
  }

  /**
   * Copy container metadata from input to output.
   *
   * Automatically copies global metadata from input Demuxer to output format context.
   * Only copies once (on first call). Removes duration/creation_time metadata.
   *
   * @internal
   */
  private copyContainerMetadata(): void {
    if (this.containerMetadataCopied || !this.options.input) {
      return;
    }

    const demuxer = 'input' in this.options.input ? this.options.input.input : this.options.input;
    const inputFormatContext = demuxer.getFormatContext();
    const inputMetadata = inputFormatContext.metadata;

    if (inputMetadata) {
      // Keys that FFmpeg removes after copying
      const keysToSkip = new Set(['duration', 'creation_time', 'company_name', 'product_name', 'product_version']);

      // Get all input metadata entries
      const entries = inputMetadata.getAll();

      // Filter out keys that should be skipped
      const filteredEntries: Record<string, string> = {};
      for (const [key, value] of Object.entries(entries)) {
        if (!keysToSkip.has(key)) {
          filteredEntries[key] = value;
        }
      }

      // Create new dictionary with filtered entries
      const metadata = Dictionary.fromObject(filteredEntries);

      // Set metadata to format context. The setter copies the content via
      // av_dict_copy, so the local dictionary must be freed afterwards.
      try {
        this.formatContext.metadata = metadata;
      } finally {
        metadata.free();
      }
    }

    this.containerMetadataCopied = true;
  }

  /**
   * Auto-set DEFAULT disposition for first stream of each type.
   *
   * FFmpeg automatically sets DEFAULT flag for the first stream of each type
   * if no stream of that type has DEFAULT set yet.
   *
   * @internal
   */
  private updateDefaultDisposition(): void {
    // Group streams by media type
    const streamsByType = new Map<number, Stream[]>();

    for (const streamInfo of this._streams.values()) {
      const codecType = streamInfo.outputStream.codecpar.codecType;
      if (!streamsByType.has(codecType)) {
        streamsByType.set(codecType, []);
      }
      streamsByType.get(codecType)!.push(streamInfo.outputStream);
    }

    // For each media type, check if any stream has DEFAULT disposition
    // If not, set DEFAULT on first stream
    for (const [_, streams] of streamsByType.entries()) {
      // Skip if only one stream of this type
      if (streams.length < 2) {
        continue;
      }

      // Check if any stream already has DEFAULT disposition
      const hasDefault = streams.some((s) => s.hasDisposition(AV_DISPOSITION_DEFAULT));

      if (!hasDefault) {
        // Find first stream that is not an attached picture
        const firstNonAttachedPic = streams.find((s) => !s.hasDisposition(AV_DISPOSITION_ATTACHED_PIC));

        if (firstNonAttachedPic) {
          // Set DEFAULT on first non-attached-picture stream
          firstNonAttachedPic.setDisposition(AV_DISPOSITION_DEFAULT);
        }
      }
    }
  }

  /**
   * Dispose of muxer.
   *
   * Implements AsyncDisposable interface for automatic cleanup.
   * Equivalent to calling close().
   *
   * @example
   * ```typescript
   * {
   *   await using output = await Muxer.open('output.mp4');
   *   // Use output...
   * } // Automatically closed
   * ```
   *
   * @see {@link close} For manual cleanup
   */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  /**
   * Dispose of muxer synchronously.
   *
   * Implements Disposable interface for automatic cleanup.
   * Equivalent to calling closeSync().
   *
   * @example
   * ```typescript
   * {
   *   using output = Muxer.openSync('output.mp4');
   *   // Use output...
   * } // Automatically closed
   * ```
   *
   * @see {@link closeSync} For manual cleanup
   */
  [Symbol.dispose](): void {
    this.closeSync();
  }
}
