# Building node-av on Linux (x64)

## Prerequisites

- Docker
- Node.js 22.18+
- Python 3.x
- pkg-config

## Steps

```bash
# 1. Prep the prefix directory
sudo rm -rf /opt/ffbuild
sudo mkdir -p /opt/ffbuild/prefix
sudo chown -R $USER:$USER /opt/ffbuild

# 2. Pull the Docker build image (has all build tools + pre-built codec libs)
docker pull ghcr.io/seydx/jellyfin-ffmpeg/linux64-gpl:latest

# 3. Build FFmpeg (runs inside Docker, outputs to builder/ffbuild/)
cd externals/jellyfin-ffmpeg/builder
./build.sh linux64 gpl

# 4. Copy results to /opt/ffbuild/prefix
cp -r ffbuild/prefix/* /opt/ffbuild/prefix/

# 5. Copy config headers (needed by the native addon)
cp ffbuild/ffmpeg/config*.h ../

# 6. Extract pre-built codec libs from Docker image (dav1d, webp, etc.)
CONTAINER_ID=$(docker create ghcr.io/seydx/jellyfin-ffmpeg/linux64-gpl:latest)
docker cp "${CONTAINER_ID}:/opt/ffbuild/lib" /tmp/codec-libs 2>/dev/null && \
  cp -n /tmp/codec-libs/*.a /opt/ffbuild/prefix/lib/ 2>/dev/null; \
  rm -rf /tmp/codec-libs
docker cp "${CONTAINER_ID}:/opt/ffbuild/include" /tmp/codec-includes 2>/dev/null && \
  cp -rn /tmp/codec-includes/* /opt/ffbuild/prefix/include/ 2>/dev/null; \
  rm -rf /tmp/codec-includes
docker rm "${CONTAINER_ID}"

# 7. Back to project root
cd ../../..

# 8. Copy the CI binding config (has the stripped library list)
cp binding-jellyfin.gyp binding.gyp

# 9. Generate codec constants, build everything, test
npm run generate
npm run build
npm test
```

## What's included

**Video decoders:** H.264, H.265/HEVC, VP9 (built-in), AV1 (via libdav1d)

**Encoders:** GIF, APNG, PNG (built-in), animated WebP (via libwebp)

**Demuxers:** MOV/MP4, Matroska/WebM (built-in)

**External libraries:** zlib, libiconv, libdav1d, libwebp
