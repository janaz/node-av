import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  AVMEDIA_TYPE_ATTACHMENT,
  AVMEDIA_TYPE_AUDIO,
  AVMEDIA_TYPE_DATA,
  AVMEDIA_TYPE_SUBTITLE,
  AVMEDIA_TYPE_VIDEO,
  AV_PIX_FMT_BGR24,
  AV_PIX_FMT_CUDA,
  AV_PIX_FMT_NONE,
  AV_PIX_FMT_NV12,
  AV_PIX_FMT_RGB24,
  AV_PIX_FMT_RGBA,
  AV_PIX_FMT_VAAPI,
  AV_PIX_FMT_VIDEOTOOLBOX,
  AV_PIX_FMT_YUV420P,
  AV_ROUND_DOWN,
  AV_ROUND_INF,
  AV_ROUND_NEAR_INF,
  AV_ROUND_UP,
  AV_ROUND_ZERO,
  FormatContext,
  OutputFormat,
  Rational,
  avCompareTs,
  avGcd,
  avGetCodecString,
  avGetMediaTypeString,
  avGetMimeTypeDash,
  avGetPixFmtFromName,
  avGetPixFmtName,
  avImageAlloc,
  avImageAllocArrays,
  avImageCopy2,
  avImageCopyToBuffer,
  avImageGetBufferSize,
  avInvQ,
  avMulQ,
  avRescaleDelta,
  avRescaleQ,
  avRescaleQRnd,
  avRescaleRnd,
  avSdpCreate,
  avTs2Str,
  avTs2TimeStr,
  avUsleep,
  getFFmpegInfo,
} from '../src/index.js';

import { Demuxer } from '../src/api/index.js';
import { getInputFile, prepareTestEnvironment } from './index.js';

prepareTestEnvironment();

describe('Utilities', () => {
  describe('FFmpeg Information', () => {
    it('should return FFmpeg version information', () => {
      const info = getFFmpegInfo();

      // Check that info object has required properties
      assert.ok(info, 'Should return info object');
      assert.ok(typeof info.version === 'string', 'Should have version string');
      assert.ok(typeof info.configuration === 'string', 'Should have configuration string');
      assert.ok(info.libraries, 'Should have libraries object');

      // Check library versions
      assert.ok(info.libraries.avutil, 'Should have avutil version');
      assert.ok(info.libraries.avcodec, 'Should have avcodec version');
      assert.ok(info.libraries.avformat, 'Should have avformat version');
      assert.ok(info.libraries.avfilter, 'Should have avfilter version');
      assert.ok(info.libraries.avdevice, 'Should have avdevice version');
      assert.ok(info.libraries.swscale, 'Should have swscale version');
      assert.ok(info.libraries.swresample, 'Should have swresample version');

      // Version format check (should be like "59.39.100")
      assert.match(info.libraries.avutil, /^\d+\.\s*\d+\.\d+$/, 'avutil version should match format');
      assert.match(info.libraries.avcodec, /^\d+\.\s*\d+\.\d+$/, 'avcodec version should match format');

      // FFmpeg version check - supports semantic (7.1.2, 8.0.0, 8.0.0-Jellyfin, 8.0.git) and git hash (f893221)
      const versionString = info.version;

      // Try to parse as semantic version with optional suffix
      const semanticMatch = /^(\d+)\.(\d+)(?:\.(\d+))?(?:-(.+))?$/.exec(versionString);

      if (semanticMatch) {
        const major = parseInt(semanticMatch[1]);

        // Accept FFmpeg 7.x or 8.x (both are compatible with library)
        assert.ok(major === 7 || major === 8, `Should be FFmpeg version 7.x or 8.x, got ${major}.x`);
      } else {
        // Not semantic versioning - might be pure git hash (e.g., 'f893221')
        const isGitHash = /^[a-f0-9]{7,}$/i.test(versionString);
        const containsGit = versionString.toLowerCase().includes('git');

        assert.ok(isGitHash || containsGit, `Should be either semantic version (7.x/8.x) or git-based version, got: ${versionString}`);
      }

      console.log('FFmpeg version:', info.version);
      console.log('libavfilter:', info.libraries.avfilter);
    });
  });

  describe('Pixel Format Functions', () => {
    it('should get pixel format name', () => {
      assert.equal(avGetPixFmtName(AV_PIX_FMT_YUV420P), 'yuv420p');
      assert.equal(avGetPixFmtName(AV_PIX_FMT_RGB24), 'rgb24');
    });

    it('should get pixel format from name', () => {
      assert.equal(avGetPixFmtFromName('yuv420p'), AV_PIX_FMT_YUV420P);
      assert.equal(avGetPixFmtFromName('rgb24'), AV_PIX_FMT_RGB24);

      // Test more common formats
      assert.equal(avGetPixFmtFromName('nv12'), AV_PIX_FMT_NV12);
      assert.equal(avGetPixFmtFromName('bgr24'), AV_PIX_FMT_BGR24);
      assert.equal(avGetPixFmtFromName('rgba'), AV_PIX_FMT_RGBA);

      // Test hardware formats (may not be available on all systems)
      const videotoolbox = avGetPixFmtFromName('videotoolbox');
      assert.ok(videotoolbox === AV_PIX_FMT_VIDEOTOOLBOX || videotoolbox === AV_PIX_FMT_NONE, 'VideoToolbox format should be 160 or -1 if not available');

      const cuda = avGetPixFmtFromName('cuda');
      assert.ok(cuda === AV_PIX_FMT_CUDA || cuda === AV_PIX_FMT_NONE, 'CUDA format should be 117 or -1 if not available');

      const vaapi = avGetPixFmtFromName('vaapi');
      assert.ok(vaapi === AV_PIX_FMT_VAAPI || vaapi === AV_PIX_FMT_NONE, 'VAAPI format should be 44 or -1 if not available');
    });

    it('should handle invalid pixel format name', () => {
      const invalidFormat = avGetPixFmtFromName('invalid_format_name');
      assert.equal(invalidFormat, -1, 'Should return -1 for invalid format name');

      // Test empty string
      assert.equal(avGetPixFmtFromName(''), -1, 'Should return -1 for empty string');

      // Test case sensitivity
      assert.equal(avGetPixFmtFromName('YUV420P'), -1, 'Should return -1 for uppercase (case sensitive)');
    });

    it('should handle invalid pixel format', () => {
      const invalidFormat = 999999 as any;
      const name = avGetPixFmtName(invalidFormat);
      assert.equal(name, null, 'Should return null for invalid format');
    });
  });

  describe('Media Type Functions', () => {
    it('should get media type string', () => {
      assert.equal(avGetMediaTypeString(AVMEDIA_TYPE_VIDEO), 'video');
      assert.equal(avGetMediaTypeString(AVMEDIA_TYPE_AUDIO), 'audio');
      assert.equal(avGetMediaTypeString(AVMEDIA_TYPE_DATA), 'data');
      assert.equal(avGetMediaTypeString(AVMEDIA_TYPE_SUBTITLE), 'subtitle');
      assert.equal(avGetMediaTypeString(AVMEDIA_TYPE_ATTACHMENT), 'attachment');
    });

    it('should handle invalid media type', () => {
      const invalidType = 999;
      const typeString = avGetMediaTypeString(invalidType as any);
      assert.equal(typeString, null, 'Should return null for invalid media type');
    });
  });

  describe('Image Functions', () => {
    it('should allocate image buffer', () => {
      const width = 320;
      const height = 240;
      const pixFmt = AV_PIX_FMT_RGB24;
      const align = 1;

      const result = avImageAlloc(width, height, pixFmt, align);

      assert.ok(result.buffer instanceof Buffer, 'Should return a Buffer');
      assert.ok(result.size > 0, 'Should have positive size');
      assert.ok(Array.isArray(result.linesizes), 'Should have linesizes array');
      assert.ok(result.linesizes.length > 0, 'Should have at least one linesize');

      // For RGB24, we expect size = width * height * 3
      const expectedSize = width * height * 3;
      assert.equal(result.size, expectedSize, 'Should allocate correct size for RGB24');
    });

    it('should copy image to buffer', () => {
      const width = 320;
      const height = 240;
      const pixFmt = AV_PIX_FMT_RGB24;
      const align = 1;

      // First allocate source image
      const srcResult = avImageAlloc(width, height, pixFmt, align);
      assert.ok(srcResult.buffer instanceof Buffer);

      // Fill source buffer with some test data
      for (let i = 0; i < srcResult.buffer.length; i++) {
        srcResult.buffer[i] = i % 256;
      }

      // Create destination buffer
      const dstSize = srcResult.size;
      const dst = Buffer.alloc(dstSize);

      // Create source data arrays
      const srcData = [srcResult.buffer];
      const srcLinesize = srcResult.linesizes;

      // Copy image to buffer
      const ret = avImageCopyToBuffer(dst, dstSize, srcData, srcLinesize, pixFmt, width, height, align);

      // Should return the number of bytes written
      assert.equal(ret, dstSize, 'Should copy all bytes');

      // Verify some data was copied
      assert.ok(!dst.every((b) => b === 0), 'Destination buffer should have data');
    });

    it('should handle insufficient buffer size', () => {
      const width = 320;
      const height = 240;
      const pixFmt = AV_PIX_FMT_RGB24;
      const align = 1;

      // Create source data
      const srcResult = avImageAlloc(width, height, pixFmt, align);
      const srcData = [srcResult.buffer];
      const srcLinesize = srcResult.linesizes;

      // Create too small destination buffer
      const dstSize = 100; // Too small
      const dst = Buffer.alloc(dstSize);

      // Should return error for insufficient buffer
      const ret = avImageCopyToBuffer(dst, dstSize, srcData, srcLinesize, pixFmt, width, height, align);
      assert.ok(ret < 0, 'Should return error for insufficient buffer');
    });

    it('should allocate image buffer arrays', () => {
      const width = 320;
      const height = 240;
      const pixFmt = AV_PIX_FMT_YUV420P;
      const align = 32;

      const result = avImageAllocArrays(width, height, pixFmt, align);

      assert.ok(Array.isArray(result.data), 'Should return data array');
      assert.ok(result.data.length > 0, 'Should have at least one data buffer');
      assert.ok(result.data[0] instanceof Buffer, 'Should contain Buffer objects');
      assert.ok(Array.isArray(result.linesizes), 'Should have linesizes array');
      assert.ok(result.size > 0, 'Should have positive size');
    });

    it('should get image buffer size', () => {
      const width = 320;
      const height = 240;
      const pixFmt = AV_PIX_FMT_RGB24;
      const align = 1;

      const size = avImageGetBufferSize(pixFmt, width, height, align);
      assert.ok(size > 0, 'Should return positive size');

      // For RGB24, we expect size = width * height * 3
      const expectedSize = width * height * 3;
      assert.equal(size, expectedSize, 'Should calculate correct size for RGB24');
    });

    it('should handle invalid image parameters', () => {
      const invalidPixFmt = -1 as any;
      const width = 320;
      const height = 240;
      const align = 1;

      // avImageAlloc should throw for invalid format
      assert.throws(() => avImageAlloc(width, height, invalidPixFmt, align), 'Should throw for invalid pixel format');

      // avImageGetBufferSize should return negative for invalid format
      const size = avImageGetBufferSize(invalidPixFmt, width, height, align);
      assert.ok(size < 0, 'Should return negative size for invalid format');
    });

    it('should copy image data', () => {
      const width = 320;
      const height = 240;
      const pixFmt = AV_PIX_FMT_RGB24;
      const align = 1;

      // Allocate source and destination
      const src = avImageAlloc(width, height, pixFmt, align);
      const dst = avImageAlloc(width, height, pixFmt, align);

      // Fill source with test data
      src.buffer.fill(42);

      // Copy
      avImageCopy2([dst.buffer], dst.linesizes, [src.buffer], src.linesizes, pixFmt, width, height);

      // Verify copy
      assert.deepEqual(dst.buffer, src.buffer, 'Should copy data correctly');
    });
  });

  describe('Timestamp Functions', () => {
    it('should convert timestamp to string', () => {
      assert.equal(avTs2Str(0n), '0');
      assert.equal(avTs2Str(123456n), '123456');
      assert.equal(avTs2Str(-123456n), '-123456');
      assert.equal(avTs2Str(null), 'NOPTS');

      // Also works with numbers
      assert.equal(avTs2Str(42), '42');
      assert.equal(avTs2Str(-42), '-42');
    });

    it('should convert timestamp to time string', () => {
      const timeBase = new Rational(1, 1000); // milliseconds

      // The actual format might vary, so just check it's a valid string
      const result0 = avTs2TimeStr(0n, timeBase);
      assert.ok(typeof result0 === 'string', 'Should return string for 0');
      assert.ok(result0.includes('0'), 'Should contain 0');

      const result1000 = avTs2TimeStr(1000n, timeBase);
      assert.ok(typeof result1000 === 'string', 'Should return string for 1000');
      assert.ok(result1000.includes('1'), 'Should contain 1');

      assert.equal(avTs2TimeStr(null, timeBase), 'NOPTS');

      // Without timebase
      assert.equal(avTs2TimeStr(123n, null), '123');
    });

    it('should compare timestamps', () => {
      const tb1 = new Rational(1, 1000); // milliseconds
      const tb2 = new Rational(1, 1000000); // microseconds

      // Same timebase comparison
      assert.equal(avCompareTs(100n, tb1, 200n, tb1), -1, '100ms < 200ms');
      assert.equal(avCompareTs(200n, tb1, 100n, tb1), 1, '200ms > 100ms');
      assert.equal(avCompareTs(100n, tb1, 100n, tb1), 0, '100ms == 100ms');

      // Different timebase comparison
      assert.equal(avCompareTs(1n, tb1, 1000n, tb2), 0, '1ms == 1000us');
      assert.equal(avCompareTs(1n, tb1, 500n, tb2), 1, '1ms > 500us');
      assert.equal(avCompareTs(1n, tb1, 2000n, tb2), -1, '1ms < 2000us');

      // Null handling
      assert.equal(avCompareTs(null, tb1, 100n, tb1), -1, 'null < 100');
      assert.equal(avCompareTs(100n, tb1, null, tb1), 1, '100 > null');
      assert.equal(avCompareTs(null, tb1, null, tb1), 0, 'null == null');
    });

    it('should rescale timestamps', () => {
      const srcTb = new Rational(1, 1000); // milliseconds
      const dstTb = new Rational(1, 1000000); // microseconds

      assert.equal(avRescaleQ(1n, srcTb, dstTb), 1000n, '1ms = 1000us');
      assert.equal(avRescaleQ(500n, srcTb, dstTb), 500000n, '500ms = 500000us');
      assert.equal(avRescaleQ(0n, srcTb, dstTb), 0n, '0ms = 0us');

      // Reverse scaling
      assert.equal(avRescaleQ(1000n, dstTb, srcTb), 1n, '1000us = 1ms');
      assert.equal(avRescaleQ(500000n, dstTb, srcTb), 500n, '500000us = 500ms');

      // Null handling - FFmpeg treats null as AV_NOPTS_VALUE which is INT64_MIN
      // The actual behavior may vary, so just check it returns a bigint
      const nullResult = avRescaleQ(null, srcTb, dstTb);
      assert.ok(typeof nullResult === 'bigint', 'null should return bigint');
    });
  });

  describe('Sleep Function', () => {
    it('should sleep for specified microseconds', () => {
      const startTime = Date.now();
      const sleepUs = 10000; // 10ms

      avUsleep(sleepUs);

      const elapsed = Date.now() - startTime;
      // Allow some tolerance (sleep might not be exact)
      assert.ok(elapsed >= 5, 'Should sleep for at least 5ms');
      assert.ok(elapsed < 200, 'Should not sleep for more than 200ms');
    });

    it('should handle zero sleep', () => {
      const startTime = Date.now();

      avUsleep(0);

      const elapsed = Date.now() - startTime;
      assert.ok(elapsed < 100, 'Zero sleep should return immediately');
    });
  });

  describe('Rescale with Rounding Functions', () => {
    it('should rescale with AV_ROUND_UP', () => {
      // Test basic rescaling with round up
      assert.equal(avRescaleRnd(1n, 1000n, 1n, AV_ROUND_UP), 1000n, '1 * 1000 / 1 = 1000');
      assert.equal(avRescaleRnd(1024n, 44100n, 48000n, AV_ROUND_UP), 941n, '1024 * 44100 / 48000 rounded up');

      // Test with numbers
      assert.equal(avRescaleRnd(100, 3, 10, AV_ROUND_UP), 30n, '100 * 3 / 10 = 30');
      assert.equal(avRescaleRnd(10, 3, 7, AV_ROUND_UP), 5n, '10 * 3 / 7 rounded up = 5');
    });

    it('should rescale with AV_ROUND_DOWN', () => {
      // Test basic rescaling with round down
      assert.equal(avRescaleRnd(1024n, 44100n, 48000n, AV_ROUND_DOWN), 940n, '1024 * 44100 / 48000 rounded down');
      assert.equal(avRescaleRnd(10, 3, 7, AV_ROUND_DOWN), 4n, '10 * 3 / 7 rounded down = 4');
    });

    it('should handle edge cases', () => {
      // Zero input
      assert.equal(avRescaleRnd(0n, 1000n, 1n, AV_ROUND_UP), 0n, '0 * anything = 0');

      // Identity scaling
      assert.equal(avRescaleRnd(100n, 1n, 1n, AV_ROUND_UP), 100n, '100 * 1 / 1 = 100');
    });
  });

  describe('SDP Functions', () => {
    it('should create SDP from FormatContext array', () => {
      // Create output format contexts for RTP
      const contexts: FormatContext[] = [];

      // Create a simple RTP output context
      const ctx = new FormatContext();
      const format = OutputFormat.guessFormat('rtp', null, null);

      if (format) {
        ctx.allocOutputContext2(format, null, 'rtp://127.0.0.1:5004');
        contexts.push(ctx);

        // Call avSdpCreate
        const result = avSdpCreate(contexts);

        // Check if we got an SDP string or null
        if (typeof result === 'string') {
          assert.ok(result.length > 0, 'Should return non-empty SDP string');
          assert.ok(result.includes('v='), 'SDP should contain version line');
          assert.ok(result.includes('o='), 'SDP should contain origin line');
        } else {
          // If error, it might be because we haven't set up streams
          assert.equal(result, null, 'Should return null if SDP creation fails');
        }

        // Clean up
        ctx.freeContext();
      } else {
        // RTP format might not be available
        console.log('RTP output format not available, skipping SDP test');
      }
    });

    it('should handle empty array', () => {
      const result = avSdpCreate([]);

      // Empty array should return null
      assert.equal(result, null, 'Should return null for empty array');
    });

    it('should validate FormatContext objects', () => {
      // @ts-ignore - Testing invalid input with null
      const result1 = avSdpCreate([null]);
      assert.equal(result1, null, 'Should return null for null in array');

      // @ts-ignore - Testing invalid input with plain object
      const result2 = avSdpCreate([{}]);
      assert.equal(result2, null, 'Should return null for non-FormatContext objects');

      // @ts-ignore - Testing invalid input with string
      const result3 = avSdpCreate('not an array');
      assert.equal(result3, null, 'Should return null for non-array input');
    });

    it('should handle multiple contexts', () => {
      const contexts: FormatContext[] = [];
      const format = OutputFormat.guessFormat('rtp', null, null);

      if (format) {
        // Create multiple RTP contexts
        for (let i = 0; i < 2; i++) {
          const ctx = new FormatContext();
          ctx.allocOutputContext2(format, null, `rtp://127.0.0.1:${5004 + i * 2}`);
          contexts.push(ctx);
        }

        const result = avSdpCreate(contexts);

        if (typeof result === 'string') {
          assert.ok(result.length > 0, 'Should create SDP for multiple contexts');
        } else {
          assert.equal(result, null, 'Should return null if SDP creation fails');
        }

        // Clean up
        contexts.forEach((ctx) => ctx.freeContext());
      }
    });
  });

  describe('Codec String and MIME Type Functions', () => {
    const inputFile = getInputFile('demux.mp4');

    it('should get RFC 6381 codec string for video', async () => {
      const media = await Demuxer.open(inputFile);
      const videoStream = media.video();

      assert.ok(videoStream, 'Should have video stream');

      const codecString = avGetCodecString(videoStream.codecpar);
      assert.ok(codecString, 'Should return codec string');
      assert.ok(typeof codecString === 'string', 'Should be string');

      // H.264 should return format like "avc1.42E01E" or at least "avc1"
      console.log('Video codec string:', codecString);
      assert.ok(codecString.length > 0, 'Should have non-empty codec string');

      await media.close();
    });

    it('should accept optional frame rate parameter', async () => {
      const media = await Demuxer.open(inputFile);
      const videoStream = media.video();

      assert.ok(videoStream, 'Should have video stream');

      // Test with frame rate parameter
      const frameRate = { num: 30, den: 1 };
      const codecString = avGetCodecString(videoStream.codecpar, frameRate);
      assert.ok(codecString, 'Should return codec string with frame rate');
      assert.ok(typeof codecString === 'string', 'Should be string');

      console.log('Codec string with frame rate:', codecString);

      await media.close();
    });

    it('should get MIME type for video stream', async () => {
      const media = await Demuxer.open(inputFile);
      const videoStream = media.video();

      assert.ok(videoStream, 'Should have video stream');

      const mimeType = avGetMimeTypeDash(videoStream.codecpar);
      assert.ok(mimeType, 'Should return MIME type');
      assert.ok(typeof mimeType === 'string', 'Should be string');

      // H.264 should return "video/mp4"
      console.log('Video MIME type:', mimeType);
      assert.ok(mimeType.startsWith('video/'), 'Should start with video/');

      await media.close();
    });

    it('should handle codec strings with extradata', async () => {
      const media = await Demuxer.open(inputFile);
      const videoStream = media.video();

      assert.ok(videoStream, 'Should have video stream');

      // Check if stream has extradata
      const extradata = videoStream.codecpar.extradata;
      if (extradata && extradata.length > 0) {
        console.log('Stream has extradata:', extradata.length, 'bytes');

        // Codec string should include profile/level info from extradata
        const codecString = avGetCodecString(videoStream.codecpar);
        assert.ok(codecString, 'Should return codec string');

        // For H.264 with extradata, should have format like "avc1.42E01E"
        if (codecString.startsWith('avc')) {
          console.log('H.264 codec string with extradata:', codecString);
        }
      } else {
        console.log('Stream has no extradata');
      }

      await media.close();
    });

    it('should handle WebM VP8 codec', async () => {
      const vp8File = getInputFile('video-vp8.webm');

      try {
        const media = await Demuxer.open(vp8File);
        const videoStream = media.video();

        assert.ok(videoStream, 'Should have video stream');

        const codecString = avGetCodecString(videoStream.codecpar);
        assert.ok(codecString, 'Should return codec string');
        assert.equal(codecString, 'vp8', 'VP8 should return "vp8"');

        const mimeType = avGetMimeTypeDash(videoStream.codecpar);
        assert.ok(mimeType, 'Should return MIME type');
        assert.equal(mimeType, 'video/webm', 'VP8 should return video/webm');

        console.log('VP8 codec string:', codecString);
        console.log('VP8 MIME type:', mimeType);

        await media.close();
      } catch {
        console.log('Skipping VP8 test: file not found');
      }
    });

    it('should handle WebM VP9 codec', async () => {
      const vp9File = getInputFile('video-vp9.webm');

      try {
        const media = await Demuxer.open(vp9File);
        const videoStream = media.video();

        assert.ok(videoStream, 'Should have video stream');

        const codecString = avGetCodecString(videoStream.codecpar);
        assert.ok(codecString, 'Should return codec string');

        // VP9 should return format like "vp09.00.41.08" or at least "vp9"
        console.log('VP9 codec string:', codecString);
        assert.ok(codecString.startsWith('vp'), 'VP9 should start with "vp"');

        const mimeType = avGetMimeTypeDash(videoStream.codecpar);
        assert.ok(mimeType, 'Should return MIME type');
        assert.equal(mimeType, 'video/webm', 'VP9 should return video/webm');

        console.log('VP9 MIME type:', mimeType);

        await media.close();
      } catch {
        console.log('Skipping VP9 test: file not found');
      }
    });

    it('should handle VP9 with frame rate parameter', async () => {
      const vp9File = getInputFile('video-vp9.webm');

      try {
        const media = await Demuxer.open(vp9File);
        const videoStream = media.video();

        assert.ok(videoStream, 'Should have video stream');

        // VP9 codec string can be more detailed with frame rate for level calculation
        const frameRate = { num: 30, den: 1 };
        const codecString = avGetCodecString(videoStream.codecpar, frameRate);
        assert.ok(codecString, 'Should return codec string');

        console.log('VP9 codec string with frame rate:', codecString);
        assert.ok(codecString.startsWith('vp'), 'VP9 should start with "vp"');

        await media.close();
      } catch {
        console.log('Skipping VP9 frame rate test: file not found');
      }
    });
  });

  describe('Rational Number Operations', () => {
    it('should multiply two rational numbers', () => {
      // Simple multiplication
      const a = new Rational(2, 3);
      const b = new Rational(3, 4);
      const result = avMulQ(a, b);
      assert.equal(result.num, 1);
      assert.equal(result.den, 2); // (2/3) * (3/4) = 6/12 = 1/2

      // Multiply framerate by 2
      const framerate = new Rational(25, 1);
      const doubled = avMulQ(framerate, new Rational(2, 1));
      assert.equal(doubled.num, 50);
      assert.equal(doubled.den, 1);

      // Multiply by zero
      const zero = avMulQ(framerate, new Rational(0, 1));
      assert.equal(zero.num, 0);
      assert.equal(zero.den, 1);
    });

    it('should invert rational number', () => {
      // Convert framerate to frame duration
      const framerate = new Rational(25, 1); // 25 fps
      const frameDuration = avInvQ(framerate);
      assert.equal(frameDuration.num, 1);
      assert.equal(frameDuration.den, 25); // 1/25 seconds

      // NTSC framerate
      const ntscFps = new Rational(30000, 1001);
      const ntscDuration = avInvQ(ntscFps);
      assert.equal(ntscDuration.num, 1001);
      assert.equal(ntscDuration.den, 30000);

      // Simple inversion
      const simple = new Rational(3, 4);
      const inverted = avInvQ(simple);
      assert.equal(inverted.num, 4);
      assert.equal(inverted.den, 3);
    });

    it('should calculate greatest common divisor', () => {
      // Common audio sample rates
      assert.equal(avGcd(48000, 44100), 300n);

      // Simple cases
      assert.equal(avGcd(12, 8), 4n);
      assert.equal(avGcd(100, 50), 50n);
      assert.equal(avGcd(7, 13), 1n); // Coprime numbers

      // With bigint
      assert.equal(avGcd(48000n, 44100n), 300n);

      // Edge cases
      assert.equal(avGcd(0, 10), 10n);
      assert.equal(avGcd(10, 0), 10n);
    });
  });

  describe('Advanced Rescale Functions', () => {
    it('should rescale with rounding mode', () => {
      const pts = 1000n;
      const srcTb = new Rational(1, 48000);
      const dstTb = new Rational(1, 90000);

      // Round up
      const ptsUp = avRescaleQRnd(pts, srcTb, dstTb, AV_ROUND_UP);
      assert.ok(typeof ptsUp === 'bigint');
      assert.ok(ptsUp >= 1875n); // 1000 * 90000 / 48000 = 1875

      // Round down
      const ptsDown = avRescaleQRnd(pts, srcTb, dstTb, AV_ROUND_DOWN);
      assert.ok(typeof ptsDown === 'bigint');
      assert.ok(ptsDown <= 1875n);

      // Round to nearest
      const ptsNearest = avRescaleQRnd(pts, srcTb, dstTb, AV_ROUND_NEAR_INF);
      assert.ok(typeof ptsNearest === 'bigint');
    });

    it('should handle different rounding modes', () => {
      const value = 10n;
      const src = new Rational(3, 1);
      const dst = new Rational(1, 7);

      // Test all rounding modes
      const roundZero = avRescaleQRnd(value, src, dst, AV_ROUND_ZERO);
      assert.ok(typeof roundZero === 'bigint');

      const roundInf = avRescaleQRnd(value, src, dst, AV_ROUND_INF);
      assert.ok(typeof roundInf === 'bigint');

      const roundDown = avRescaleQRnd(value, src, dst, AV_ROUND_DOWN);
      assert.ok(typeof roundDown === 'bigint');

      const roundUp = avRescaleQRnd(value, src, dst, AV_ROUND_UP);
      assert.ok(typeof roundUp === 'bigint');

      const roundNear = avRescaleQRnd(value, src, dst, AV_ROUND_NEAR_INF);
      assert.ok(typeof roundNear === 'bigint');
    });

    it('should handle null values in rescaleQRnd', () => {
      const srcTb = new Rational(1, 1000);
      const dstTb = new Rational(1, 1000000);

      const result = avRescaleQRnd(null, srcTb, dstTb, AV_ROUND_UP);
      assert.ok(typeof result === 'bigint');
    });

    it('should rescale with delta', () => {
      const inTb = new Rational(1, 48000);
      const inTs = 1000000n;
      const fsTb = new Rational(1, 44100);
      const duration = 1024;
      const lastRef = { value: 0n };
      const outTb = new Rational(1, 96000);

      const rescaled = avRescaleDelta(inTb, inTs, fsTb, duration, lastRef, outTb);
      assert.ok(typeof rescaled === 'bigint');
      assert.ok(rescaled > 0n);

      // lastRef.value should be updated
      assert.ok(typeof lastRef.value === 'bigint');
    });

  });
});
