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
