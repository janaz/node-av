import type { FilterInOut } from './filter-inout.js';
import type { NativeFilterGraphSegment } from './native-types.js';

/**
 * Parsed filter graph segment.
 *
 * Represents a parsed filtergraph segment that separates parsing from initialization.
 * This allows filter contexts to be configured after creation but before initialization.
 * The workflow involves parsing the filter description, creating filter instances,
 * applying options, and finally initializing and linking the filters.
 * Freeing the graph it was parsed into also frees the segment.
 *
 * Direct mapping to FFmpeg's AVFilterGraphSegment.
 *
 * @see [AVFilterGraphSegment](https://ffmpeg.org/doxygen/trunk/structAVFilterGraphSegment.html) - FFmpeg Doxygen
 */
export class FilterGraphSegment implements Disposable {
  private native: NativeFilterGraphSegment;

  /**
   * @param native - The native filter graph segment instance
   *
   * @internal
   */
  constructor(native: NativeFilterGraphSegment) {
    this.native = native;
  }

  /**
   * Create filter instances in the segment.
   *
   * Allocates all filter contexts defined in the segment but does not initialize them.
   * This separation allows configuration of filter properties before the filters are initialized.
   *
   * Direct mapping to avfilter_graph_segment_create_filters().
   *
   * @param flags - Creation flags (default: 0)
   *
   * @returns 0 on success, negative AVERROR on failure:
   *   - AVERROR_EINVAL: Invalid segment
   *   - AVERROR_ENOMEM: Memory allocation failure
   *
   * @example
   * ```typescript
   * import { FFmpegError } from 'node-av';
   *
   * const segment = graph.segmentParse('scale=640:480');
   * if (segment) {
   *   const ret = segment.createFilters();
   *   FFmpegError.throwIfError(ret, 'createFilters');
   * }
   * ```
   *
   * @see {@link applyOpts} To apply options after creation
   * @see {@link apply} To initialize and link filters
   */
  createFilters(flags = 0): number {
    return this.native.createFilters(flags);
  }

  /**
   * Apply options to filter instances.
   *
   * Applies the parsed filter options to their respective filter contexts.
   * This method should be called after creating filters and before initializing them.
   *
   * Direct mapping to avfilter_graph_segment_apply_opts().
   *
   * @param flags - Option flags (default: 0)
   *
   * @returns 0 on success, negative AVERROR on failure:
   *   - AVERROR_EINVAL: Invalid options
   *   - AVERROR_OPTION_NOT_FOUND: Unknown option
   *
   * @example
   * ```typescript
   * import { FFmpegError } from 'node-av';
   *
   * const segment = graph.segmentParse('scale=640:480');
   * if (segment) {
   *   FFmpegError.throwIfError(segment.createFilters(), 'createFilters');
   *   FFmpegError.throwIfError(segment.applyOpts(), 'applyOpts');
   * }
   * ```
   *
   * @see {@link createFilters} To create filter instances first
   * @see {@link apply} To initialize and link after applying options
   */
  applyOpts(flags = 0): number {
    return this.native.applyOpts(flags);
  }

  /**
   * Initialize and link all filters in the segment.
   *
   * Initializes all filter contexts in the segment and creates links between them
   * according to the parsed filter graph description. This is the final step that
   * completes the filter setup. All necessary filter configuration should be done
   * before calling this method.
   *
   * Direct mapping to avfilter_graph_segment_apply().
   *
   * @param inputs - Input filter pads
   *
   * @param outputs - Output filter pads
   *
   * @param flags - Apply flags (default: 0)
   *
   * @returns 0 on success, negative AVERROR on failure:
   *   - AVERROR_EINVAL: Invalid segment or pads
   *   - AVERROR_ENOMEM: Memory allocation failure
   *
   * @example
   * ```typescript
   * import { FFmpegError, FilterInOut } from 'node-av';
   *
   * const segment = graph.segmentParse('scale=640:480');
   * if (segment) {
   *   FFmpegError.throwIfError(segment.createFilters(), 'createFilters');
   *   FFmpegError.throwIfError(segment.applyOpts(), 'applyOpts');
   *
   *   const inputs = new FilterInOut();
   *   const outputs = new FilterInOut();
   *   FFmpegError.throwIfError(segment.apply(inputs, outputs), 'apply');
   *
   *   inputs.free();
   *   outputs.free();
   *   segment.free();
   * }
   * ```
   *
   * @see {@link createFilters} To create filter instances
   * @see {@link applyOpts} To apply options before initialization
   */
  apply(inputs: FilterInOut, outputs: FilterInOut, flags = 0): number {
    return this.native.apply(inputs.getNative(), outputs.getNative(), flags);
  }

  /**
   * Free the segment and all associated resources.
   *
   * Releases all memory and resources allocated for this filter graph segment.
   * After calling this method, the segment cannot be used anymore.
   *
   * Direct mapping to avfilter_graph_segment_free().
   *
   * @example
   * ```typescript
   * const segment = graph.segmentParse('scale=640:480');
   * if (segment) {
   *   // Use segment...
   *   segment.free();
   * }
   * ```
   *
   * @see {@link Symbol.dispose} For automatic cleanup with using statement
   */
  free(): void {
    this.native.free();
  }

  /**
   * Dispose of the segment.
   *
   * Automatically frees the segment when using the `using` statement.
   * This implements the Disposable interface for automatic resource cleanup.
   * Equivalent to calling free().
   *
   * @example
   * ```typescript
   * {
   *   using segment = graph.segmentParse('scale=640:480');
   *   // Use segment...
   * } // Automatically freed
   * ```
   */
  [Symbol.dispose](): void {
    this.native[Symbol.dispose]();
  }
}
