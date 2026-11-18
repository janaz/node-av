/**
 * FFmpeg build variant of this package.
 *
 * This fork ships a single `revizly` build (a trimmed GPL FFmpeg, published as @revizly/node-av).
 * The value is kept here so the binding and FFmpeg-CLI loaders resolve the fork's scoped packages.
 *
 * @internal
 */
export const VARIANT: 'gpl' | 'lgpl' | 'light' | 'revizly' = 'revizly';

/**
 * Name prefix of this package's platform packages with the native binding.
 *
 * @returns Package name prefix, e.g. `@revizly/node-av`
 *
 * @internal
 */
export function nativePackagePrefix(): string {
  return '@revizly/node-av';
}

/**
 * Name of this package's FFmpeg CLI package (not published by this fork; the static libs are
 * linked into the native binding, so this is only referenced by optional CLI helpers).
 *
 * @returns Package name, e.g. `@revizly/node-av-ffmpeg`
 *
 * @internal
 */
export function ffmpegPackageName(): string {
  return '@revizly/node-av-ffmpeg';
}
