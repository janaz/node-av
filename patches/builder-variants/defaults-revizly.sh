# revizly: the trimmed fork build.
#
# This is dropped into the jellyfin-ffmpeg builder (externals/jellyfin-ffmpeg/builder/variants/)
# at CI time by .github/workflows/build-prebuilds.yaml, so the submodule stays pinned at upstream.
# `build.sh <target> revizly` sources variants/<target>-revizly.sh, which sources this file.
#
# It reproduces the old revizly 6.x stripped FFmpeg on top of jellyfin 8.1.3, at two levels:
#   (A) external libraries: build only the ones the resizer uses (keep dav1d, SVT-AV1 and WebP;
#       this is light's FF_SKIP_SCRIPTS minus 50-svtav1 and 50-libwebp). Must stay in sync with
#       the `revizly` variant's excludedLibs in scripts/ffmpeg-variant.js.
#   (B) FFmpeg internal components: narrow the encoder/decoder/muxer/... allowlists so libavcodec
#       and libavformat carry only what we need (gives animated AVIF via libsvtav1 + the avif muxer).
#
# If a jellyfin build step ever breaks on the level-(B) allowlist, drop the FF_CONFIGURE block
# below and keep only the FF_SKIP_SCRIPTS trim; that alone removes the bulk of the size.

source "$(dirname "$BASH_SOURCE")"/defaults-gpl.sh

# (A) external libraries to skip. Build ONLY dav1d (AV1 decode), SVT-AV1 (AV1 encode),
# libwebp, plus the base libiconv/zlib; skip everything else. This matches the `revizly`
# variant's excludedLibs in scripts/ffmpeg-variant.js (which keeps exactly those). A skipped
# script also omits its --enable-* flag, so our --disable-* for hardware accel etc. below is
# not re-enabled. Directory names (45-x11, 47-vulkan, 50-vaapi) cover everything under them.
FF_SKIP_SCRIPTS=(
    25-fftw3f
    25-freetype
    25-fribidi
    25-gmp
    25-libogg
    25-libxml2
    25-openssl
    25-xz
    35-fontconfig
    45-alsalib
    45-brotli
    45-harfbuzz
    45-lcms2
    45-libne10
    45-libudfread
    45-libunibreak
    45-libvorbis
    45-opencl
    45-x11
    47-vulkan
    50-amf
    50-chromaprint
    50-dxva
    50-fdk-aac-stripped
    50-ffnvcodec
    50-libass
    50-libbluray
    50-libjxl
    50-libmp3lame
    50-libopus
    50-libplacebo
    50-libtheora
    50-libvpl
    50-libvpx
    50-mfx
    50-openmpt
    50-rkmpp
    50-rkrga
    50-schannel
    50-srt
    50-vaapi
    50-x264
    50-x265
    50-zimg
    50-zvbi
    60-whisper
)

# (B) FFmpeg component allowlist (mirrors the revizly 6.x stripped ./configure). The scripts.d
# builds for the kept libraries append their own --enable-libdav1d/--enable-libsvtav1/--enable-libwebp
# after this, so the libsvtav1 encoder and avif muxer end up enabled alongside the allowlist below.
FF_CONFIGURE+=" --disable-alsa --disable-xlib --disable-libxcb --disable-libdrm"
FF_CONFIGURE+=" --disable-vaapi --disable-vdpau --disable-vulkan --disable-opencl"
FF_CONFIGURE+=" --disable-libvpl --disable-ffnvcodec --disable-cuda-llvm --disable-hwaccels"
FF_CONFIGURE+=" --disable-encoders --enable-encoder=gif,apng,libwebp,libwebp_anim,png,rawvideo,wrapped_avframe,libsvtav1"
FF_CONFIGURE+=" --disable-decoders --enable-decoder=h264,hevc,vp9,av1,libdav1d,png,apng,gif,webp,rawvideo,wrapped_avframe"
FF_CONFIGURE+=" --disable-muxers --enable-muxer=gif,apng,webp,image2,mov,mp4,matroska,webm,rawvideo,null,avif"
FF_CONFIGURE+=" --disable-demuxers --enable-demuxer=mov,matroska,image2,gif,apng,concat,rawvideo"
FF_CONFIGURE+=" --disable-parsers --enable-parser=h264,hevc,vp9,av1,png,webp"
FF_CONFIGURE+=" --disable-bsfs --enable-bsf=h264_mp4toannexb,hevc_mp4toannexb,vp9_superframe,av1_frame_merge,null,extract_extradata"
FF_CONFIGURE+=" --disable-protocols --enable-protocol=file,pipe,data,concat,unix"
FF_CONFIGURE+=" --disable-devices --disable-indevs --disable-outdevs"
FF_CONFIGURE+=" --disable-filters"
FF_CONFIGURE+=" --enable-filter=buffer,buffersink,null,copy,format,fps,scale,crop,overlay"
FF_CONFIGURE+=" --enable-filter=hflip,vflip,transpose,rotate,split,pad,fade,trim,select"
FF_CONFIGURE+=" --enable-filter=setpts,setsar,setdar,framerate,framestep,concat,fifo"
FF_CONFIGURE+=" --enable-filter=drawbox,color,negate,edgedetect,hstack,vstack,yadif,bwdif"
