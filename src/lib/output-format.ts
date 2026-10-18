import { bindings } from './binding.js';

import type { AVCodecID, AVFormatConstants, AVFormatFlag } from '../constants/constants.js';
import type { NativeOutputFormat, NativeWrapper } from './native-types.js';

/**
 * Output format descriptor for muxing media files.
 *
 * Represents a muxer that can write specific media container formats.
 * Each format handles specific file types (e.g., MP4, MKV, AVI) and knows how to
 * combine streams and write them to output. Contains default codec suggestions
 * for audio, video, and subtitles.
 *
 * Direct mapping to FFmpeg's AVOutputFormat.
 *
 * @example
 * ```typescript
 * import { OutputFormat, FormatContext, FFmpegError } from 'node-av';
 * import { AV_CODEC_ID_H264, AV_CODEC_ID_AAC } from 'node-av/constants';
 *
 * // Guess format from filename
 * const format = OutputFormat.guessFormat(null, 'output.mp4', null);
 * if (!format) {
 *   throw new Error('Could not determine output format');
 * }
 *
 * console.log(`Format: ${format.name}`);
 * console.log(`Description: ${format.longName}`);
 * console.log(`Default video codec: ${format.videoCodec}`);
 * console.log(`Default audio codec: ${format.audioCodec}`);
 *
 * // Use specific format
 * const mkvFormat = OutputFormat.guessFormat('matroska', null, null);
 *
 * // Use with format context
 * const formatContext = new FormatContext();
 * formatContext.outputFormat = format;
 * const ret = await formatContext.allocOutputContext('output.mp4');
 * FFmpegError.throwIfError(ret, 'allocOutputContext');
 * ```
 *
 * @see [AVOutputFormat](https://ffmpeg.org/doxygen/trunk/structAVOutputFormat.html) - FFmpeg Doxygen
 * @see {@link FormatContext} For using formats to write files
 * @see {@link InputFormat} For demuxing formats
 */
export class OutputFormat implements NativeWrapper<NativeOutputFormat> {
  private native: NativeOutputFormat;

  /**
   * @param native - The native output format instance
   *
   * @internal
   */
  constructor(native: NativeOutputFormat) {
    this.native = native;
  }

  /**
   * Guess output format from name, filename, or MIME type.
   *
   * Determines the appropriate output format based on provided hints.
   * At least one parameter should be non-null.
   *
   * Direct mapping to av_guess_format().
   *
   * @param shortName - Format short name (e.g., 'mp4', 'mkv', null to ignore)
   *
   * @param filename - Output filename for extension detection (null to ignore)
   *
   * @param mimeType - MIME type hint (null to ignore)
   *
   * @returns Detected format, or null if not determined
   *
   * @example
   * ```typescript
   * // Guess from filename extension
   * const format1 = OutputFormat.guessFormat(null, 'video.mp4', null);
   * // Returns MP4 format
   *
   * // Use specific format
   * const format2 = OutputFormat.guessFormat('matroska', null, null);
   * // Returns MKV format
   *
   * // Guess from MIME type
   * const format3 = OutputFormat.guessFormat(null, null, 'video/mp4');
   * // Returns MP4 format
   *
   * // Priority: shortName > filename > mimeType
   * const format4 = OutputFormat.guessFormat('mkv', 'video.mp4', null);
   * // Returns MKV format (shortName takes precedence)
   * ```
   */
  static guessFormat(shortName: string | null, filename: string | null, mimeType: string | null): OutputFormat | null {
    const native = bindings.OutputFormat.guessFormat(shortName, filename, mimeType);
    if (!native) {
      return null;
    }
    return new OutputFormat(native);
  }

  /**
   * Format short name.
   *
   * Short identifier for the format (e.g., 'mp4', 'mkv').
   *
   * Direct mapping to AVOutputFormat->name.
   */
  get name(): string | null {
    return this.native.name;
  }

  /**
   * Format long name.
   *
   * Human-readable description of the format.
   *
   * Direct mapping to AVOutputFormat->long_name.
   */
  get longName(): string | null {
    return this.native.longName;
  }

  /**
   * File extensions.
   *
   * Comma-separated list of file extensions for this format.
   *
   * Direct mapping to AVOutputFormat->extensions.
   */
  get extensions(): string | null {
    return this.native.extensions;
  }

  /**
   * MIME type.
   *
   * MIME type(s) associated with this format.
   *
   * Direct mapping to AVOutputFormat->mime_type.
   */
  get mimeType(): string | null {
    return this.native.mimeType;
  }

  /**
   * Default audio codec.
   *
   * Suggested audio codec for this format.
   *
   * Direct mapping to AVOutputFormat->audio_codec.
   */
  get audioCodec(): AVCodecID {
    return this.native.audioCodec;
  }

  /**
   * Default video codec.
   *
   * Suggested video codec for this format.
   *
   * Direct mapping to AVOutputFormat->video_codec.
   */
  get videoCodec(): AVCodecID {
    return this.native.videoCodec;
  }

  /**
   * Default subtitle codec.
   *
   * Suggested subtitle codec for this format.
   *
   * Direct mapping to AVOutputFormat->subtitle_codec.
   */
  get subtitleCodec(): AVCodecID {
    return this.native.subtitleCodec;
  }

  /**
   * Format flags.
   *
   * Combination of AVFMT_* flags indicating format capabilities.
   *
   * Direct mapping to AVOutputFormat->flags.
   */
  get flags(): AVFormatFlag {
    return this.native.flags;
  }

  /**
   * Check if output format has specific flags.
   *
   * Tests whether all specified flags are set using bitwise AND.
   *
   * @param flags - One or more flag values to check
   *
   * @returns true if all specified flags are set, false otherwise
   *
   * @example
   * ```typescript
   * import { AVFMT_GLOBALHEADER } from 'node-av/constants';
   *
   * if (outputFormat.hasFlags(AVFMT_GLOBALHEADER)) {
   *   console.log('This format requires global headers');
   * }
   * ```
   *
   * @see {@link flags} For direct flags access
   */
  hasFlags(...flags: (AVFormatFlag | AVFormatConstants)[]): boolean {
    for (const flag of flags) {
      if ((this.native.flags & flag) !== flag) {
        return false;
      }
    }
    return true;
  }

  /**
   * Get the codec tag this format stores for a codec.
   *
   * Looks the codec up in the format's codec tag table.
   *
   * Direct mapping to av_codec_get_tag2() on AVOutputFormat->codec_tag.
   *
   * @param codecId - Codec to look up
   *
   * @returns The tag (FourCC), or null if the format has no tag for this codec
   *
   * @example
   * ```typescript
   * import { AV_CODEC_ID_H264 } from 'node-av/constants';
   *
   * const mp4 = OutputFormat.guessFormat('mp4', null, null);
   * console.log(mp4?.getCodecTag(AV_CODEC_ID_H264)); // 0x31637661 ('avc1')
   * ```
   *
   * @see {@link getCodecId} For the reverse lookup
   */
  getCodecTag(codecId: AVCodecID): number | null {
    return this.native.getCodecTag(codecId);
  }

  /**
   * Get the codec a codec tag stands for in this format.
   *
   * Looks the tag up in the format's codec tag table.
   *
   * Direct mapping to av_codec_get_id() on AVOutputFormat->codec_tag.
   *
   * @param tag - Codec tag (FourCC)
   *
   * @returns The codec, or AV_CODEC_ID_NONE if the format does not know the tag
   *
   * @example
   * ```typescript
   * const mkv = OutputFormat.guessFormat('matroska', null, null);
   * const id = mkv?.getCodecId(stream.codecpar.codecTag);
   * ```
   *
   * @see {@link getCodecTag} For the reverse lookup
   */
  getCodecId(tag: number): AVCodecID {
    return this.native.getCodecId(tag);
  }

  /**
   * Get the underlying native OutputFormat object.
   *
   * @returns The native OutputFormat binding object
   *
   * @internal
   */
  getNative(): NativeOutputFormat {
    return this.native;
  }
}
