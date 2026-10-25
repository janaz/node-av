/**
 * Resolve a scale target where -1 keeps the source aspect ratio.
 *
 * Like the scale filter's -2: the derived side is rounded to an even number so
 * 4:2:0 encoders accept it. Both sides -1 keeps the source size.
 *
 * @param srcWidth - Source width
 *
 * @param srcHeight - Source height
 *
 * @param width - Target width, or -1 to derive it from the height
 *
 * @param height - Target height, or -1 to derive it from the width
 *
 * @returns The target size
 *
 * @internal
 */
export function resolveScaleSize(srcWidth: number, srcHeight: number, width: number, height: number): { width: number; height: number } {
  if (width < 0 && height < 0) {
    return { width: srcWidth, height: srcHeight };
  }
  if (width < 0) {
    return { width: Math.max(2, Math.round((height * srcWidth) / srcHeight / 2) * 2), height };
  }
  if (height < 0) {
    return { width, height: Math.max(2, Math.round((width * srcHeight) / srcWidth / 2) * 2) };
  }
  return { width, height };
}

/**
 * Scale target and output size of a transcode, never larger than the source.
 *
 * A requested width or height above the source keeps the source size, since a
 * bigger picture only raises the bitrate.
 *
 * @param srcWidth - Source width, 0 when unknown before the first frame
 *
 * @param srcHeight - Source height, 0 when unknown before the first frame
 *
 * @param width - Requested width, or -1 to derive it from the height
 *
 * @param height - Requested height, or -1 to derive it from the width
 *
 * @returns The target for the scale filter (-1 follows the source) and the
 * resolved output size, undefined while the source size is unknown
 *
 * @internal
 */
export function transcodeScale(
  srcWidth: number,
  srcHeight: number,
  width = -1,
  height = -1,
): { target: { width: number; height: number }; output?: { width: number; height: number } } {
  const known = srcWidth > 0 && srcHeight > 0;
  const target = known && (width > srcWidth || height > srcHeight) ? { width: -1, height: -1 } : { width, height };
  return { target, output: known ? resolveScaleSize(srcWidth, srcHeight, target.width, target.height) : undefined };
}
