import {
  AVCOL_RANGE_MPEG,
  AV_CODEC_CAP_EXPERIMENTAL,
  AV_CODEC_CAP_HARDWARE,
  AV_HWDEVICE_TYPE_CUDA,
  AV_HWDEVICE_TYPE_D3D11VA,
  AV_HWDEVICE_TYPE_DRM,
  AV_HWDEVICE_TYPE_DXVA2,
  AV_HWDEVICE_TYPE_OPENCL,
  AV_HWDEVICE_TYPE_VAAPI,
  AV_HWDEVICE_TYPE_VDPAU,
  AV_HWDEVICE_TYPE_VIDEOTOOLBOX,
  AV_LOG_WARNING,
  AV_PIX_FMT_NV12,
  AV_PIX_FMT_YUV420P,
  AV_PIX_FMT_YUVJ420P,
} from '../../constants/constants.js';
import { Codec } from '../../lib/codec.js';
import { Filter } from '../../lib/filter.js';
import { Frame } from '../../lib/frame.js';
import { Log } from '../../lib/log.js';
import { Rational } from '../../lib/rational.js';
import { avGetPixFmtName, avIsHardwarePixelFormat } from '../../lib/utilities.js';
import { Decoder } from '../decoder.js';
import { Encoder } from '../encoder.js';
import { FilterPreset } from '../filter-presets.js';
import { FilterAPI } from '../filter.js';
import { pickSupportedPixelFormat } from './codec-format.js';
import { resolveScaleSize } from './scale-size.js';

import type { AVCodecID, AVHWDeviceType, AVPixelFormat, FFEncoderCodec } from '../../constants/index.js';
import type { Stream } from '../../lib/stream.js';
import type { DecoderOptions } from '../decoder.js';
import type { EncoderOptions } from '../encoder.js';
import type { BaseCodecName, HardwareContext } from '../hardware.js';

/**
 * What the video encoder of a transcode has to receive.
 *
 * @internal
 */
export interface VideoTranscodeTarget {
  /** Output width, -1 to keep the source width or follow the height */
  width: number;
  /** Output height, -1 to keep the source height or follow the width */
  height: number;
  /** Output frame rate, when it changes */
  fps?: number;
  /** The encoder */
  encoder: Codec;
  /** The device the frames are decoded and filtered on */
  hardware?: HardwareContext | null;
}

/**
 * A frame as the transcode graph sees it.
 *
 * @internal
 */
export interface VideoGraphInput {
  /** The frame lives on a device */
  hw: boolean;
  /** The frame lives on the transcode's device */
  onDevice: boolean;
  /** Pixel format, the software format of device frames */
  format: AVPixelFormat;
  width: number;
  height: number;
}

/**
 * Filters a device has for a transcode.
 *
 * @internal
 */
export interface DeviceFilters {
  /** Scales and converts the pixel format on the device */
  scaler: boolean;
  /** Uploads software frames well enough to scale them there instead of on the CPU */
  upload: boolean;
}

/**
 * Devices whose upload and scaler are proven together; elsewhere software frames are scaled on the CPU.
 *
 * @internal
 */
const UPLOAD_SCALE_DEVICES: readonly AVHWDeviceType[] = [AV_HWDEVICE_TYPE_VAAPI, AV_HWDEVICE_TYPE_CUDA, AV_HWDEVICE_TYPE_VIDEOTOOLBOX];

/**
 * Devices without encoders of their own, they borrow one from a GPU vendor.
 *
 * @internal
 */
const BORROWING_DEVICES: readonly AVHWDeviceType[] = [
  AV_HWDEVICE_TYPE_D3D11VA,
  AV_HWDEVICE_TYPE_DXVA2,
  AV_HWDEVICE_TYPE_OPENCL,
  AV_HWDEVICE_TYPE_VDPAU,
  AV_HWDEVICE_TYPE_DRM,
];

/**
 * The vendor encoders such a device borrows, in the order {@link HardwareContext.getEncoderCodec} looks for them.
 *
 * @internal
 */
const VENDOR_ENCODERS = ['nvenc', 'qsv', 'amf'] as const;

/**
 * How long a hardware encoder that failed its test stays passed over, a busy GPU can recover.
 *
 * @internal
 */
const FAILED_PROBE_RETRY_MS = 60_000;

/**
 * Size of the test frame a hardware encoder has to encode, when the caller names none.
 *
 * @internal
 */
const PROBE_SIZE = { width: 640, height: 360 };

/**
 * Test encodes per device and encoder, failures with the time they failed.
 *
 * @internal
 */
const encoderProbes = new Map<string, { usable: Promise<boolean>; failedAt?: number }>();

/**
 * No scaler and no upload for scaling, the graph of a device whose filters failed.
 *
 * @internal
 */
const NO_DEVICE_FILTERS: DeviceFilters = { scaler: false, upload: false };

/**
 * Filters per device type, the build decides which exist.
 *
 * @internal
 */
const deviceFilterCache = new Map<AVHWDeviceType, DeviceFilters>();

/**
 * Build the filter graph that brings a decoded frame to the video encoder of a transcode.
 *
 * Frames stay on the device whenever the encoder takes them there, and scaling
 * and format conversion run on the device whenever it has a scaler. Hardware
 * encoders get 8-bit 4:2:0 in NV12: VAAPI decodes JPEG into planar or 4:2:2
 * surfaces and 10-bit sources come as P010, which H.264 hardware encoders reject.
 * Software encoders get yuv420p when the frames have to be converted anyway, it
 * is the layout every browser and HomeKit decodes (unlike the 4:2:2 profile x264
 * picks for a 4:2:2 JPEG camera). Packed sources such as yuyv422 are converted
 * too, swscale cannot scale them in place.
 *
 * Decided per frame, not per stream: a hardware decoder falls back to software
 * frames for input it cannot handle, e.g. 4:2:2 JPEG on NVDEC.
 *
 * @param input - The frame
 *
 * @param target - The encoder's needs
 *
 * @param filters - What the target's device has, see {@link findDeviceFilters}
 *
 * @returns The filter description, `null` when the frame can go to the encoder as it is
 *
 * @internal
 */
export function videoTranscodeGraph(input: VideoGraphInput, target: VideoTranscodeTarget, filters: DeviceFilters): string {
  const { encoder, hardware } = target;
  const size = resolveScaleSize(input.width, input.height, target.width, target.height);
  const parts: string[] = [];
  let resize = size.width !== input.width || size.height !== input.height;
  let format = input.format;

  // a frame dropped first costs no later stage anything
  if (target.fps !== undefined) parts.push(`fps=${target.fps}`);

  const takesDevice = !!hardware && encoderTakesDevice(encoder, hardware);

  if (input.hw) {
    if (input.onDevice && filters.scaler) {
      // the scaler converts in the same pass, and a software encoder gets NV12 downloaded
      if (resize || format !== AV_PIX_FMT_NV12) parts.push(deviceScale(hardware!, resize ? size : undefined));
      if (takesDevice) return finish(parts);
      parts.push('hwdownload', 'format=nv12');
      format = AV_PIX_FMT_NV12;
      resize = false;
    } else if (input.onDevice && takesDevice && !resize && format === AV_PIX_FMT_NV12) {
      return finish(parts);
    } else {
      parts.push('hwdownload', `format=${pixFmtName(format)}`);
    }
  }

  // software frames from here on
  const softwareFormat = encoderSoftwareFormat(encoder);
  if (hardware && (softwareFormat === null || (takesDevice && resize && filters.upload && filters.scaler))) {
    // the encoder takes device frames only, or the device scales cheaper than the CPU
    const scaleOnDevice = resize && filters.scaler;
    if (resize && !scaleOnDevice) parts.push(`scale=${size.width}:${size.height}`);
    parts.push('format=nv12', FilterPreset.chain(hardware).hwupload().build());
    if (scaleOnDevice) parts.push(deviceScale(hardware, size));
    return finish(parts);
  }

  if (resize) parts.push(`scale=${size.width}:${size.height}`);
  if (resize || !takesAsIs(encoder, format)) parts.push(`format=${pixFmtName(softwareFormat ?? AV_PIX_FMT_NV12)}`);
  return finish(parts);
}

/**
 * Describe a decoded frame for {@link videoTranscodeGraph}.
 *
 * @param frame - The frame
 *
 * @param hardware - The transcode's device, if any
 *
 * @returns Where the frame lives, its format and size
 *
 * @internal
 */
export function describeVideoFrame(frame: Frame, hardware?: HardwareContext | null): VideoGraphInput {
  const hw = frame.isHwFrame();
  return {
    hw,
    onDevice: hw && !!hardware && frame.format === hardware.devicePixelFormat,
    format: hw ? (frame.hwFramesCtx?.swFormat ?? AV_PIX_FMT_NV12) : (frame.format as AVPixelFormat),
    width: frame.width,
    height: frame.height,
  };
}

/**
 * Create the filter between the video decoder (or frame source) and the encoder of a transcode.
 *
 * The graph is built by {@link videoTranscodeGraph} from the first frame and
 * again whenever the frames change, e.g. when the decoder falls back to software.
 * A graph whose device filters fail to configure is replaced by one that
 * converts in software.
 *
 * @param target - The encoder's needs
 *
 * @param filters - The device's filters, found by default
 *
 * @returns The filter
 *
 * @internal
 */
export function createVideoTranscodeFilter(target: VideoTranscodeTarget, filters: DeviceFilters = findDeviceFilters(target.hardware)): FilterAPI {
  return FilterAPI.create(
    (frame, failure) => {
      const input = describeVideoFrame(frame, target.hardware);
      if (!failure) {
        return videoTranscodeGraph(input, target, filters);
      }
      Log.log(AV_LOG_WARNING, `Video filters on ${target.hardware?.deviceTypeName ?? 'the CPU'} failed (${failure.message}), converting in software\n`);
      return videoTranscodeGraph(input, target, NO_DEVICE_FILTERS);
    },
    { hardware: target.hardware },
  );
}

/**
 * Open the video decoder of a transcode, on the device unless it fails to open there.
 *
 * A device decoder that opens but then produces nothing moves to software on
 * its own ({@link DecoderOptions.hardwareFallback}).
 *
 * @param stream - The video stream
 *
 * @param hardware - The device to decode on, if any
 *
 * @param options - Decoder options besides the device
 *
 * @returns The decoder
 *
 * @throws {FFmpegError} If no software decoder opens either
 *
 * @internal
 */
export async function openTranscodeDecoder(stream: Stream, hardware: HardwareContext | null | undefined, options: DecoderOptions): Promise<Decoder> {
  if (hardware) {
    try {
      return await Decoder.create(stream, { ...options, hardware, hardwareFallback: true });
    } catch (error) {
      Log.log(AV_LOG_WARNING, `Video decoder failed to open on ${hardware.deviceTypeName}, decoding in software: ${(error as Error).message}\n`);
    }
  }
  return await Decoder.create(stream, options);
}

/**
 * Find the software encoder for a codec.
 *
 * FFmpeg picks the first encoder registered for a codec. The Linux arm64
 * builds register the Rockchip MPP encoders ahead of libx264 and libx265, and
 * those fail to open on every other arm64 machine, e.g. a Raspberry Pi.
 *
 * @param codecId - The codec to encode
 *
 * @returns The first encoder for the codec that is no hardware encoder, FFmpeg's pick when there is none
 *
 * @internal
 */
export function findSoftwareEncoder(codecId: AVCodecID): Codec | null {
  let opaque: bigint | null = null;
  let result;
  while ((result = Codec.iterateCodecs(opaque))) {
    const { codec } = result;
    if (codec.isEncoder() && codec.id === codecId && !codec.hasCapabilities(AV_CODEC_CAP_HARDWARE) && !codec.hasCapabilities(AV_CODEC_CAP_EXPERIMENTAL)) {
      return codec;
    }
    opaque = result.opaque;
  }
  return Codec.findEncoder(codecId);
}

/**
 * Find the device's encoder for a codec, if it works on this machine.
 *
 * @param hardware - The device, if any
 *
 * @param codec - The codec to encode
 *
 * @param options - Encoder options the encoder will get, some drivers need them to open (e.g. `low_power`)
 *
 * @param size - The size it will encode, hardware encoders have a maximum that differs per GPU
 *
 * @param size.width - Width
 *
 * @param size.height - Height
 *
 * @returns The hardware encoder, or null to encode in software
 *
 * @internal
 */
export async function findUsableHardwareEncoder(
  hardware: HardwareContext | null | undefined,
  codec: BaseCodecName | AVCodecID,
  options?: EncoderOptions['options'],
  size?: { width: number; height: number },
): Promise<Codec | null> {
  const encoder = hardware?.getEncoderCodec(codec);
  if (!encoder || !hardware) {
    return null;
  }
  for (const candidate of encoderCandidates(encoder, hardware)) {
    if (await canEncodeOnDevice(candidate, hardware, options, size)) {
      return candidate;
    }
  }
  return null;
}

/**
 * The encoders to try for a device, the one it names first.
 *
 * A device without encoders of its own names the first vendor encoder the
 * build has, NVENC on every Windows build. On an AMD or Intel GPU that one
 * cannot work but the vendor's own can.
 *
 * @param encoder - The encoder the device names
 *
 * @param hardware - The device
 *
 * @returns The encoders in the order to try them
 *
 * @internal
 */
function encoderCandidates(encoder: Codec, hardware: HardwareContext): Codec[] {
  const name = encoder.name;
  if (!name || !BORROWING_DEVICES.includes(hardware.deviceType)) {
    return [encoder];
  }
  const base = name.slice(0, name.lastIndexOf('_'));
  const others = VENDOR_ENCODERS.map((vendor) => Codec.findEncoderByName(`${base}_${vendor}` as FFEncoderCodec)).filter(
    (candidate): candidate is Codec => !!candidate?.isHardwareAcceleratedEncoder() && candidate.name !== name,
  );
  return [encoder, ...others];
}

/**
 * Check whether a hardware encoder works on this machine, by encoding a test frame once.
 *
 * Finding an encoder says nothing about the driver: NVENC refuses to open
 * when the driver is older than the API it was built against, many GPUs have
 * no encoder at all. A failed encoder is passed over for a minute, then tried
 * again. Concurrent callers share one test.
 *
 * @param encoder - The hardware encoder
 *
 * @param hardware - The device it encodes on
 *
 * @param options - Encoder options the encoder will get
 *
 * @param size - Size of the test frame
 *
 * @param size.width - Width
 *
 * @param size.height - Height
 *
 * @returns Whether it encoded the frame
 *
 * @internal
 */
export async function canEncodeOnDevice(
  encoder: Codec,
  hardware: HardwareContext,
  options?: EncoderOptions['options'],
  size: { width: number; height: number } = PROBE_SIZE,
): Promise<boolean> {
  const settings = JSON.stringify(options ?? {}, (_key, value: unknown) => (typeof value === 'bigint' ? String(value) : value));
  const key = `${hardware.deviceTypeName}:${encoder.name}:${size.width}x${size.height}:${settings}`;
  const known = encoderProbes.get(key);
  if (known && (known.failedAt === undefined || Date.now() - known.failedAt < FAILED_PROBE_RETRY_MS)) {
    return known.usable;
  }

  const probe: { usable: Promise<boolean>; failedAt?: number } = { usable: probeEncoder(encoder, hardware, options, size) };
  encoderProbes.set(key, probe);
  const usable = await probe.usable;
  if (!usable) {
    probe.failedAt = Date.now();
    Log.log(
      AV_LOG_WARNING,
      `Hardware encoder ${encoder.name} failed to encode a ${size.width}x${size.height} test frame on ${hardware.deviceTypeName}, encoding video in software\n`,
    );
  }
  return usable;
}

/**
 * Encode one frame with a hardware encoder.
 *
 * @param codec - The hardware encoder
 *
 * @param hardware - The device it encodes on
 *
 * @param options - Encoder options
 *
 * @param size - Size of the test frame
 *
 * @param size.width - Width
 *
 * @param size.height - Height
 *
 * @returns Whether a packet came out
 *
 * @internal
 */
async function probeEncoder(codec: Codec, hardware: HardwareContext, options: EncoderOptions['options'], size: { width: number; height: number }): Promise<boolean> {
  try {
    using frame = Frame.fromVideoBuffer(Buffer.alloc((size.width * size.height * 3) / 2), {
      width: size.width,
      height: size.height,
      format: AV_PIX_FMT_NV12,
      timeBase: { num: 1, den: 25 },
      pts: 0n,
    });
    // an unset range makes some encoders warn
    frame.colorRange = AVCOL_RANGE_MPEG;
    using upload = encoderSoftwareFormat(codec) === null ? FilterAPI.create(FilterPreset.chain(hardware).hwupload().build(), { hardware }) : undefined;
    using encoder = await Encoder.create(codec, {
      maxBFrames: 0,
      options,
      configure: (context) => {
        context.framerate = new Rational(25, 1);
      },
    });

    const inputs = upload ? await upload.processAll(frame) : [frame];
    let packets = 0;
    try {
      for (const input of inputs) {
        for (const packet of await encoder.encodeAll(input)) {
          packets++;
          packet.free();
        }
      }
    } finally {
      if (upload) inputs.forEach((input) => input.free());
    }
    for await (using _packet of encoder.flushPackets()) packets++;
    return packets > 0;
  } catch {
    return false;
  }
}

/**
 * Whether an encoder takes the frames of a device as they are.
 *
 * @param encoder - The encoder
 *
 * @param hardware - The device
 *
 * @returns True for a hardware encoder that lists the device's pixel format
 *
 * @internal
 */
function encoderTakesDevice(encoder: Codec, hardware: HardwareContext): boolean {
  return encoder.isHardwareAcceleratedEncoder() && (encoder.pixelFormats?.includes(hardware.devicePixelFormat) ?? false);
}

/**
 * The software format to convert frames to for an encoder.
 *
 * @param encoder - The encoder
 *
 * @returns NV12 for hardware encoders and yuv420p for software ones when listed,
 * otherwise the closest listed software format; `null` if it takes device frames only
 *
 * @internal
 */
function encoderSoftwareFormat(encoder: Codec): AVPixelFormat | null {
  const formats = encoder.pixelFormats;
  if (!formats || formats.length === 0) return AV_PIX_FMT_YUV420P;
  const preferred = encoder.isHardwareAcceleratedEncoder() ? [AV_PIX_FMT_NV12, AV_PIX_FMT_YUV420P] : [AV_PIX_FMT_YUV420P, AV_PIX_FMT_NV12];
  const listed = preferred.find((format) => formats.includes(format));
  if (listed !== undefined) return listed;
  const software = formats.filter((format) => !avIsHardwarePixelFormat(format));
  return software.length > 0 ? pickSupportedPixelFormat(AV_PIX_FMT_YUV420P, software) : null;
}

/**
 * Whether an encoder takes a software frame without conversion.
 *
 * @param encoder - The encoder
 *
 * @param format - The frame's pixel format
 *
 * @returns True for 8-bit 4:2:0 the encoder lists
 *
 * @internal
 */
function takesAsIs(encoder: Codec, format: AVPixelFormat): boolean {
  const is420 = format === AV_PIX_FMT_YUV420P || format === AV_PIX_FMT_YUVJ420P || format === AV_PIX_FMT_NV12;
  return is420 && (encoder.pixelFormats?.includes(format) ?? true);
}

/**
 * The device scaler converting to NV12, scaling too when given a size.
 *
 * @param hardware - The device
 *
 * @param size - Output size, if it changes
 *
 * @param size.width - Output width
 *
 * @param size.height - Output height
 *
 * @returns The filter
 *
 * @internal
 */
function deviceScale(hardware: HardwareContext, size?: { width: number; height: number }): string {
  const chain = FilterPreset.chain(hardware);
  return (size ? chain.scale(size.width, size.height, { format: 'nv12' }) : chain.scaleFormat(AV_PIX_FMT_NV12)).build();
}

/**
 * Find out which transcode filters a device has in this FFmpeg build.
 *
 * @param hardware - The device, if any
 *
 * @returns Its filters, none without a device
 *
 * @internal
 */
export function findDeviceFilters(hardware: HardwareContext | null | undefined): DeviceFilters {
  if (!hardware) return NO_DEVICE_FILTERS;
  let filters = deviceFilterCache.get(hardware.deviceType);
  if (!filters) {
    const exists = (description: string): boolean => Filter.getByName(description.split('=')[0]) !== null;
    const scaler = FilterPreset.chain(hardware).supports('scale') && exists(FilterPreset.chain(hardware).scaleFormat(AV_PIX_FMT_NV12).build());
    const upload = UPLOAD_SCALE_DEVICES.includes(hardware.deviceType) && exists(FilterPreset.chain(hardware).hwupload().build());
    filters = { scaler, upload };
    deviceFilterCache.set(hardware.deviceType, filters);
  }
  return filters;
}

/**
 * Join the filters of a graph.
 *
 * @param parts - The filters
 *
 * @returns The description, `null` for none
 *
 * @internal
 */
function finish(parts: string[]): string {
  return parts.length > 0 ? parts.join(',') : 'null';
}

/**
 * Name of a pixel format for a filter description.
 *
 * @param format - The pixel format
 *
 * @returns Its name
 *
 * @internal
 */
function pixFmtName(format: AVPixelFormat): string {
  return avGetPixFmtName(format) ?? 'nv12';
}
