/**
 * Box types (big-endian fourcc) the watchdog reads from the fMP4 output.
 *
 * @internal
 */
const BOX = {
  moof: 0x6d6f6f66,
  moov: 0x6d6f6f76,
  traf: 0x74726166,
  tfhd: 0x74666864,
  trun: 0x7472756e,
  trak: 0x7472616b,
  tkhd: 0x746b6864,
  mdia: 0x6d646961,
  minf: 0x6d696e66,
  stbl: 0x7374626c,
  stsz: 0x7374737a,
  stz2: 0x73747a32,
} as const;

/**
 * Largest moof/moov collected across output chunks; anything larger is treated as corrupt framing.
 *
 * @internal
 */
const MAX_COLLECTED_BOX = 32 * 1024 * 1024;

/**
 * Longest time between two packets (ms) that counts towards packet ages; a longer pause of the whole input counts as this much.
 *
 * @internal
 */
const MAX_COUNTED_GAP_MS = 2000;

/**
 * FIFO of packet arrival times (ms on the watchdog's input clock) for one output stream, kept in a growable ring buffer.
 *
 * @internal
 */
class ArrivalQueue {
  private ring = new Float64Array(256);
  private head = 0;
  private _count = 0;

  /**
   * Number of packets waiting for a fragment.
   *
   * @returns Pending packet count
   *
   * @internal
   */
  get count(): number {
    return this._count;
  }

  /**
   * Arrival time of the oldest pending packet.
   *
   * @returns Time in ms, or NaN when nothing is pending
   *
   * @internal
   */
  oldest(): number {
    return this._count > 0 ? this.ring[this.head] : NaN;
  }

  /**
   * Append the arrival time of a packet the muxer accepted.
   *
   * @param time - Arrival time in ms
   *
   * @internal
   */
  push(time: number): void {
    if (this._count === this.ring.length) {
      // Doubling keeps pushes amortised O(1); the ring only grows while a
      // stream is held back, which the watchdog bounds.
      const grown = new Float64Array(this.ring.length * 2);
      const tail = this.ring.subarray(this.head);
      grown.set(tail);
      grown.set(this.ring.subarray(0, this.head), tail.length);
      this.ring = grown;
      this.head = 0;
    }
    this.ring[(this.head + this._count) & (this.ring.length - 1)] = time;
    this._count++;
  }

  /**
   * Remove the most recent arrival (a packet the muxer dropped).
   *
   * @internal
   */
  dropNewest(): void {
    if (this._count > 0) {
      this._count--;
    }
  }

  /**
   * Remove the oldest arrivals (packets emitted in a fragment).
   *
   * Removes at most what is pending: more emitted samples than recorded
   * packets cannot be credited to later packets.
   *
   * @param n - Number of emitted samples
   *
   * @internal
   */
  dropOldest(n: number): void {
    const k = Math.min(n, this._count);
    this.head = (this.head + k) & (this.ring.length - 1);
    this._count -= k;
  }
}

/**
 * Bounds how long an fMP4 muxer may hold a packet before emitting it in a fragment.
 *
 * Remembers when each packet reached the muxer, per output stream and in order, and
 * forgets packets as the fragments carrying them are written. When the oldest pending
 * packet of any stream is older than the limit, the next packet write fails with a
 * descriptive error. The age does not depend on packet timestamps, so it also bounds
 * retention caused by missing, constant or runaway timestamps. It counts the time
 * while packets arrive: a pause of the whole input counts at most 2 s, so a source
 * that goes quiet and resumes is not mistaken for a stalled muxer.
 *
 * @example
 * ```typescript
 * const watchdog = new PacketAgeWatchdog(60, (index) => `stream ${index}`);
 * const output = await Muxer.open(
 *   {
 *     write: (chunk) => {
 *       watchdog.consumeChunk(chunk);
 *       return chunk.length;
 *     },
 *   },
 *   { format: 'mp4', options: { movflags: '+frag_keyframe+empty_moov' } },
 * );
 * output.setPacketObserver(watchdog);
 * ```
 *
 * @see {@link Muxer.setPacketObserver} For registering it with a muxer
 *
 * @internal
 */
export class PacketAgeWatchdog {
  private readonly limitMs: number;
  private readonly limitSeconds: number;
  private readonly describeStream: (streamIndex: number) => string;
  private queues: (ArrivalQueue | undefined)[] = [];
  // Input clock (ms): advances with performance.now() between packets, by at
  // most MAX_COUNTED_GAP_MS per gap. Arrival times and ages are on this clock.
  private clock = 0;
  private lastArrival = performance.now();
  // Chunk mode framing: header bytes of the current top-level box, bytes left to
  // skip in a box nobody needs (mdat), and a moof/moov collected across chunks.
  private header = Buffer.alloc(16);
  private headerFill = 0;
  private skipRemaining = 0;
  private partialBox: Buffer | null = null;
  private partialFill = 0;
  private blind = false;

  /**
   * @param limitSeconds - Maximum age of a pending packet in seconds (> 0)
   *
   * @param describeStream - Label for an output stream in the error message (e.g. its media type)
   *
   * @internal
   */
  constructor(limitSeconds: number, describeStream: (streamIndex: number) => string) {
    this.limitSeconds = limitSeconds;
    this.limitMs = limitSeconds * 1000;
    this.describeStream = describeStream;
  }

  /**
   * Number of packets of a stream that have not been emitted in a fragment yet.
   *
   * @param streamIndex - Output stream index
   *
   * @returns Pending packet count
   *
   * @internal
   */
  pendingPackets(streamIndex: number): number {
    return this.queues[streamIndex]?.count ?? 0;
  }

  /**
   * Age of the oldest pending packet of a stream, as the next packet would see it.
   *
   * @param streamIndex - Output stream index
   *
   * @param now - Current time in ms (performance.now() clock)
   *
   * @returns Age in ms of input time, or 0 when nothing is pending
   *
   * @internal
   */
  pendingAge(streamIndex: number, now = performance.now()): number {
    const queue = this.queues[streamIndex];
    if (!queue || queue.count === 0) {
      return 0;
    }
    return this.clock + Math.min(now - this.lastArrival, MAX_COUNTED_GAP_MS) - queue.oldest();
  }

  /**
   * Record a packet the muxer accepted.
   *
   * Checks every stream first, so a stream that is held back is caught by the
   * packets of the streams that still flow.
   *
   * @param streamIndex - Output stream index
   *
   * @throws {Error} If a pending packet of any stream is older than the limit
   *
   * @internal
   */
  onPacket(streamIndex: number): void {
    if (this.blind) {
      return;
    }
    // Ages count input time, not wall-clock time. mux.c keeps the last packet
    // of each stream until the next one arrives and movenc emits a sample only
    // when a later packet closes its fragment, so a few packets are always
    // pending. Across a pause of the whole input (a stalled source, host
    // suspend) they would otherwise age and fail the first packet after it,
    // although nothing piled up. Packets pile up only while packets flow, with
    // gaps far below the cap, so capping each gap does not delay detection.
    const now = performance.now();
    this.clock += Math.min(now - this.lastArrival, MAX_COUNTED_GAP_MS);
    this.lastArrival = now;
    const clock = this.clock;
    for (let i = 0; i < this.queues.length; i++) {
      const queue = this.queues[i];
      if (queue && queue.count > 0 && clock - queue.oldest() > this.limitMs) {
        throw this.violation(i, clock - queue.oldest(), queue.count);
      }
    }
    (this.queues[streamIndex] ??= new ArrivalQueue()).push(clock);
  }

  /**
   * Forget a packet of a stream that the muxer accepted but dropped.
   *
   * @param streamIndex - Output stream index
   *
   * @internal
   */
  onPacketRejected(streamIndex: number): void {
    // Usually the dropped packet is the newest one, but libavformat can reject a
    // packet while later ones already wait behind it. Removing the newest keeps
    // the count exact and errs towards older arrival times, by no more than the
    // packets queued behind it.
    // A failed av_interleaved_write_frame() is reported against the packet the
    // muxer submitted, but mux.c also returns the error of writing out an
    // earlier buffered packet, possibly of another stream. The total stays
    // exact; per stream one entry can land in the wrong queue, which skews
    // ages by about one packet interval and leaves one entry that ages if the
    // stream that really lost the packet then goes quiet. movenc fails that
    // late only on I/O and allocation errors and a few packet checks (a PTS
    // 2^31 or more ticks from its DTS, a malformed first AAC packet). An AVIO
    // error is sticky and fails every later write, so the age limit ending such
    // a session is wanted, not a false alarm.
    this.queues[streamIndex]?.dropNewest();
  }

  /**
   * Stop judging packet ages for the rest of the session.
   *
   * For a caller that frames the output itself and lost the box boundaries:
   * emitted samples can no longer be counted, and pending packets would
   * otherwise look stalled. Drops what it has recorded and records nothing
   * more, so a blind session holds no state.
   *
   * @internal
   */
  onFramingLost(): void {
    this.blind = true;
    this.queues = [];
    this.partialBox = null;
    this.skipRemaining = 0;
    this.headerFill = 0;
  }

  /**
   * Account for one complete top-level box of the muxer output.
   *
   * Only `moof` (fragment samples) and `moov` (samples of a first fragment
   * written without `empty_moov`) matter; other boxes are ignored.
   *
   * @param box - The whole box including its header
   *
   * @internal
   */
  consumeBox(box: Buffer): void {
    if (box.length < 8) {
      return;
    }
    const type = box.readUInt32BE(4);
    if (type !== BOX.moof && type !== BOX.moov) {
      return;
    }
    const headerSize = box.readUInt32BE(0) === 1 ? 16 : 8;
    if (type === BOX.moof) {
      this.drainFragment(box, headerSize, box.length);
    } else {
      this.drainInitSegment(box, headerSize, box.length);
    }
  }

  /**
   * Account for a raw chunk of the muxer output.
   *
   * Frames top-level boxes across chunk boundaries without buffering media
   * data: only `moof`/`moov` boxes are collected, everything else is skipped.
   * If the framing breaks (a size the muxer never writes), the watchdog stops
   * judging ages for the rest of the session instead of guessing.
   *
   * @param chunk - Output chunk in stream order
   *
   * @internal
   */
  consumeChunk(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length && !this.blind) {
      if (this.skipRemaining > 0) {
        const n = Math.min(this.skipRemaining, chunk.length - offset);
        this.skipRemaining -= n;
        offset += n;
        continue;
      }

      if (this.partialBox) {
        const n = Math.min(this.partialBox.length - this.partialFill, chunk.length - offset);
        chunk.copy(this.partialBox, this.partialFill, offset, offset + n);
        this.partialFill += n;
        offset += n;
        if (this.partialFill === this.partialBox.length) {
          const box = this.partialBox;
          this.partialBox = null;
          this.consumeBox(box);
        }
        continue;
      }

      // The header itself may straddle chunks: 8 bytes, 16 for a 64-bit size.
      let need = this.headerFill < 8 ? 8 : this.header.readUInt32BE(0) === 1 ? 16 : 8;
      if (this.headerFill < need) {
        const n = Math.min(need - this.headerFill, chunk.length - offset);
        chunk.copy(this.header, this.headerFill, offset, offset + n);
        this.headerFill += n;
        offset += n;
        if (this.headerFill < need) {
          continue;
        }
        need = this.header.readUInt32BE(0) === 1 ? 16 : 8;
        if (this.headerFill < need) {
          continue;
        }
      }

      const size32 = this.header.readUInt32BE(0);
      const size = size32 === 1 ? Number(this.header.readBigUInt64BE(8)) : size32;
      const type = this.header.readUInt32BE(4);
      this.headerFill = 0;

      // size 0 ("to the end of the file") cannot be framed in a live stream;
      // movenc writes it only when it could not seek back to patch a box.
      if (size < need) {
        this.onFramingLost();
        return;
      }

      if (type === BOX.moof || type === BOX.moov) {
        if (size > MAX_COLLECTED_BOX) {
          this.onFramingLost();
          return;
        }
        this.partialBox = Buffer.allocUnsafe(size);
        this.header.copy(this.partialBox, 0, 0, need);
        this.partialFill = need;
        if (this.partialFill === size) {
          const box = this.partialBox;
          this.partialBox = null;
          this.consumeBox(box);
        }
      } else {
        this.skipRemaining = size - need;
      }
    }
  }

  /**
   * Drain the samples of every track fragment in a moof.
   *
   * @param buf - Buffer holding the moof
   *
   * @param start - Offset of the moof payload
   *
   * @param end - End offset of the moof
   *
   * @internal
   */
  private drainFragment(buf: Buffer, start: number, end: number): void {
    for (let offset = start; offset + 8 <= end;) {
      const size = childSize(buf, offset, end);
      if (size === 0) {
        return;
      }
      if (buf.readUInt32BE(offset + 4) === BOX.traf) {
        this.drainTrackFragment(buf, offset + headerSizeAt(buf, offset), offset + size);
      }
      offset += size;
    }
  }

  /**
   * Drain the samples of one traf: its tfhd names the track, each trun counts samples.
   *
   * movenc writes several truns per traf when the sample data is not contiguous.
   *
   * @param buf - Buffer holding the traf
   *
   * @param start - Offset of the traf payload
   *
   * @param end - End offset of the traf
   *
   * @internal
   */
  private drainTrackFragment(buf: Buffer, start: number, end: number): void {
    let trackId = 0;
    let samples = 0;
    for (let offset = start; offset + 8 <= end;) {
      const size = childSize(buf, offset, end);
      if (size === 0) {
        break;
      }
      const type = buf.readUInt32BE(offset + 4);
      const payload = offset + headerSizeAt(buf, offset);
      // Both start with version/flags (4 bytes), then track_ID resp. sample_count.
      if ((type === BOX.tfhd || type === BOX.trun) && payload + 8 <= offset + size) {
        if (type === BOX.tfhd) {
          trackId = buf.readUInt32BE(payload + 4);
        } else {
          samples += buf.readUInt32BE(payload + 4);
        }
      }
      offset += size;
    }
    this.drain(trackId, samples);
  }

  /**
   * Drain samples a moov carries in its sample tables.
   *
   * With `empty_moov` the tables are empty. Without it movenc writes the first
   * fragment's samples into the moov instead of a moof.
   *
   * @param buf - Buffer holding the moov
   *
   * @param start - Offset of the moov payload
   *
   * @param end - End offset of the moov
   *
   * @internal
   */
  private drainInitSegment(buf: Buffer, start: number, end: number): void {
    for (let offset = start; offset + 8 <= end;) {
      const size = childSize(buf, offset, end);
      if (size === 0) {
        return;
      }
      if (buf.readUInt32BE(offset + 4) === BOX.trak) {
        const trakEnd = offset + size;
        let trackId = 0;
        let samples = 0;
        for (let child = offset + headerSizeAt(buf, offset); child + 8 <= trakEnd;) {
          const childBoxSize = childSize(buf, child, trakEnd);
          if (childBoxSize === 0) {
            break;
          }
          const type = buf.readUInt32BE(child + 4);
          const payload = child + headerSizeAt(buf, child);
          if (type === BOX.tkhd && payload + 24 <= child + childBoxSize) {
            // track_ID follows creation/modification time: 32-bit in version 0, 64-bit in version 1
            trackId = buf.readUInt32BE(payload + (buf[payload] === 1 ? 20 : 12));
          } else if (type === BOX.mdia) {
            samples = sampleTableCount(buf, payload, child + childBoxSize);
          }
          child += childBoxSize;
        }
        this.drain(trackId, samples);
      }
      offset += size;
    }
  }

  /**
   * Remove emitted samples from the queue of the stream behind a track.
   *
   * movenc numbers the tracks of the muxer's streams stream index + 1; tracks
   * it adds itself (chapters, timecode) have no queue and are ignored.
   *
   * @param trackId - mp4 track_ID
   *
   * @param samples - Number of emitted samples
   *
   * @internal
   */
  private drain(trackId: number, samples: number): void {
    if (trackId > 0 && samples > 0) {
      this.queues[trackId - 1]?.dropOldest(samples);
    }
  }

  /**
   * Build the error for a stream whose oldest pending packet is too old.
   *
   * @param streamIndex - Output stream index
   *
   * @param ageMs - Age of its oldest pending packet in ms
   *
   * @param pending - Number of its pending packets
   *
   * @returns Error describing the stalled stream
   *
   * @internal
   */
  private violation(streamIndex: number, ageMs: number, pending: number): Error {
    const type = this.describeStream(streamIndex);
    const label = type ? ` (${type})` : '';
    const what = `the oldest of ${pending} pending packets has waited ${(ageMs / 1000).toFixed(1)}s without being emitted in a fragment`;
    return new Error(`Muxer stall on output stream ${streamIndex}${label}: ${what}, more than maxPacketAge (${this.limitSeconds}s)`);
  }
}

/**
 * Header size of the box at an offset: 16 for a 64-bit size, else 8.
 *
 * @param buf - Buffer holding the box
 *
 * @param offset - Box start
 *
 * @returns Header size in bytes
 *
 * @internal
 */
function headerSizeAt(buf: Buffer, offset: number): number {
  return buf.readUInt32BE(offset) === 1 ? 16 : 8;
}

/**
 * Size of a child box that must end within its parent.
 *
 * @param buf - Buffer holding the box
 *
 * @param offset - Box start (at least 8 bytes before end)
 *
 * @param end - End offset of the parent
 *
 * @returns Box size, or 0 when the box is malformed or overruns the parent
 *
 * @internal
 */
function childSize(buf: Buffer, offset: number, end: number): number {
  let size = buf.readUInt32BE(offset);
  let header = 8;
  if (size === 1) {
    if (offset + 16 > end) {
      return 0;
    }
    size = Number(buf.readBigUInt64BE(offset + 8));
    header = 16;
  }
  return size >= header && offset + size <= end ? size : 0;
}

/**
 * Sample count of a track's sample table (mdia > minf > stbl > stsz/stz2).
 *
 * @param buf - Buffer holding the mdia
 *
 * @param start - Offset of the mdia payload
 *
 * @param end - End offset of the mdia
 *
 * @returns Number of samples, 0 if absent
 *
 * @internal
 */
function sampleTableCount(buf: Buffer, start: number, end: number): number {
  const path = [BOX.minf, BOX.stbl];
  let level = 0;
  for (let offset = start; offset + 8 <= end;) {
    const size = childSize(buf, offset, end);
    if (size === 0) {
      return 0;
    }
    const type = buf.readUInt32BE(offset + 4);
    const payload = offset + headerSizeAt(buf, offset);
    if (level < path.length && type === path[level]) {
      // Descend: continue with the children of this box.
      level++;
      end = offset + size;
      offset = payload;
      continue;
    }
    // stsz and stz2 both keep sample_count after version/flags and one 32-bit field.
    if (level === path.length && (type === BOX.stsz || type === BOX.stz2) && payload + 12 <= offset + size) {
      return buf.readUInt32BE(payload + 8);
    }
    offset += size;
  }
  return 0;
}
