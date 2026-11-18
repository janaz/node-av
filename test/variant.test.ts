/**
 * Checks the FFmpeg variant the binding was built for. This fork ships a single
 * variant, `revizly`: a size-trimmed FFmpeg for the image / animated-AVIF resizer
 * (SVT-AV1 encoder + avif muxer, WebP, AV1 decode via dav1d). Audio, live streaming
 * (rtp/rtsp), the GPL x264/x265 encoders, whisper, vpx and jxl are deliberately left
 * out, so this asserts both the components we keep and the ones we drop. The trim is
 * defined in patches/builder-variants/defaults-revizly.sh (FFmpeg component allowlist)
 * and scripts/ffmpeg-variant.js (linked libraries). Runs as part of npm run test:all.
 */

import assert from 'node:assert';
import { describe, it } from 'node:test';

import { Decoder, Demuxer, Encoder, Muxer } from '../src/api/index.js';
import { FF_ENCODER_LIBSVTAV1 } from '../src/constants/index.js';
import { BitStreamFilter, Codec, Filter, InputFormat, OutputFormat, getFFmpegInfo } from '../src/lib/index.js';
import { getInputFile, getOutputFile, prepareTestEnvironment } from './index.js';

import type { FFDecoderCodec, FFEncoderCodec } from '../src/constants/index.js';

prepareTestEnvironment();

const variant = process.env.NODE_AV_VARIANT ?? 'revizly';
const configuration = getFFmpegInfo().configuration;

// Components the trimmed revizly build keeps: still images, animated WebP and animated
// AVIF (libsvtav1 + the avif muxer), plus AV1 decode through libdav1d.
const required = {
  encoders: ['png', 'apng', 'gif', 'libwebp', 'libwebp_anim', 'libsvtav1', 'rawvideo', 'wrapped_avframe'],
  decoders: ['h264', 'hevc', 'vp9', 'av1', 'libdav1d', 'png', 'apng', 'gif', 'webp', 'rawvideo'],
  muxers: ['mp4', 'matroska', 'webm', 'webp', 'gif', 'image2', 'avif', 'null'],
  demuxers: ['mov', 'matroska', 'image2', 'gif', 'apng', 'concat'],
  filters: ['buffer', 'buffersink', 'format', 'fps', 'scale', 'crop', 'overlay', 'pad', 'transpose', 'hflip', 'vflip', 'split', 'concat', 'yadif', 'bwdif'],
  bsfs: ['h264_mp4toannexb', 'hevc_mp4toannexb', 'extract_extradata'],
};

// Components the trim removes: the GPL x264/x265 encoders, all audio (no aac/opus/fdk),
// MJPEG, and the whisper/vpx libraries. None of these may be present.
const excluded = {
  encoders: ['libx264', 'libx265', 'libfdk_aac', 'aac', 'libopus', 'mjpeg', 'libvpx'],
  decoders: ['aac', 'libopus', 'libfdk_aac'],
  filters: ['whisper', 'subtitles', 'drawtext'],
};

const hasEncoder = (name: string) => Codec.findEncoderByName(name as FFEncoderCodec) !== null;
const hasDecoder = (name: string) => Codec.findDecoderByName(name as FFDecoderCodec) !== null;
const hasFilter = (name: string) => Filter.getByName(name) !== null;
const missing = (names: string[], has: (name: string) => boolean) => names.filter((name) => !has(name));
const present = (names: string[], has: (name: string) => boolean) => names.filter((name) => has(name));

describe(`FFmpeg variant (${variant})`, () => {
  it('should be the revizly variant', () => {
    assert.strictEqual(variant, 'revizly', `Unexpected NODE_AV_VARIANT ${variant}`);
  });

  it('should carry the license of the variant', () => {
    // revizly builds on the GPL base image (patches/builder-variants/defaults-revizly.sh
    // sources defaults-gpl.sh); it must stay redistributable (not nonfree).
    assert.match(configuration, /--enable-gpl/);
    assert.doesNotMatch(configuration, /--enable-nonfree/);
  });

  it('should have the components for image and animated-AVIF resizing', () => {
    assert.deepStrictEqual(missing(required.encoders, hasEncoder), [], 'encoders');
    assert.deepStrictEqual(missing(required.decoders, hasDecoder), [], 'decoders');
    assert.deepStrictEqual(missing(required.filters, hasFilter), [], 'filters');
    assert.deepStrictEqual(
      missing(required.muxers, (name) => OutputFormat.guessFormat(name, null, null) !== null),
      [],
      'muxers',
    );
    assert.deepStrictEqual(
      missing(required.demuxers, (name) => InputFormat.findInputFormat(name) !== null),
      [],
      'demuxers',
    );
    assert.deepStrictEqual(
      missing(required.bsfs, (name) => BitStreamFilter.getByName(name) !== null),
      [],
      'bitstream filters',
    );
  });

  it('should leave out the components the trim drops', () => {
    assert.deepStrictEqual(present(excluded.encoders, hasEncoder), [], 'encoders');
    assert.deepStrictEqual(present(excluded.decoders, hasDecoder), [], 'decoders');
    assert.deepStrictEqual(present(excluded.filters, hasFilter), [], 'filters');
  });

  it('should encode AV1 (animated AVIF path) to mp4', async () => {
    const outputFile = getOutputFile(`variant-${variant}.mp4`);
    await using input = await Demuxer.open(getInputFile('video.mp4'));
    const stream = input.video();
    assert.ok(stream, 'Should have a video stream');

    using decoder = await Decoder.create(stream);
    // libsvtav1 is the trimmed build's only video encoder (animated AVIF uses the same encoder)
    using encoder = await Encoder.create(FF_ENCODER_LIBSVTAV1, { decoder, maxBFrames: 0 });
    const output = await Muxer.open(outputFile);
    const index = output.addStream(encoder);

    let frames = 0;
    for await (using packet of input.packets(stream.index)) {
      for await (using frame of decoder.frames(packet)) {
        if (frame === null || frames >= 10) continue;
        frames++;
        for await (using encoded of encoder.packets(frame)) {
          await output.writePacket(encoded, index);
        }
      }
      if (frames >= 10) break;
    }
    for await (using encoded of encoder.packets(null)) {
      await output.writePacket(encoded, index);
    }
    await output.close();

    await using check = await Demuxer.open(outputFile);
    assert.strictEqual(check.video()?.codecpar.codecId, encoder.getCodec().id);
  });
});
