#ifdef __linux__

#include "device.h"
#include <algorithm>
#include <map>
#include <stdexcept>
#include <dirent.h>
#include <fcntl.h>
#include <sys/ioctl.h>
#include <unistd.h>
#include <cstring>
#include <linux/videodev2.h>

namespace ffmpeg {

// V4L2 fourcc → FFmpeg AVPixelFormat
static AVPixelFormat v4l2FormatToAV(uint32_t fourcc) {
  switch (fourcc) {
    case V4L2_PIX_FMT_YUYV:    return AV_PIX_FMT_YUYV422;
    case V4L2_PIX_FMT_UYVY:    return AV_PIX_FMT_UYVY422;
    case V4L2_PIX_FMT_YUV420:  return AV_PIX_FMT_YUV420P;
    case V4L2_PIX_FMT_YVU420:  return AV_PIX_FMT_YUV420P;
    case V4L2_PIX_FMT_NV12:    return AV_PIX_FMT_NV12;
    case V4L2_PIX_FMT_NV21:    return AV_PIX_FMT_NV21;
    case V4L2_PIX_FMT_RGB24:   return AV_PIX_FMT_RGB24;
    case V4L2_PIX_FMT_BGR24:   return AV_PIX_FMT_BGR24;
    case V4L2_PIX_FMT_RGB32:   return AV_PIX_FMT_RGBA;
    case V4L2_PIX_FMT_BGR32:   return AV_PIX_FMT_BGRA;
    case V4L2_PIX_FMT_GREY:    return AV_PIX_FMT_GRAY8;
    default:                   return AV_PIX_FMT_NONE;
  }
}

std::vector<DeviceInfo> enumerateDevices() {
  std::vector<DeviceInfo> devices;

  // Enumerate V4L2 video devices
  DIR* dir = opendir("/dev");
  if (dir) {
    struct dirent* entry;
    bool isFirstVideo = true;

    while ((entry = readdir(dir)) != nullptr) {
      // Look for video devices (video0, video1, etc.)
      if (strncmp(entry->d_name, "video", 5) == 0) {
        std::string devicePath = std::string("/dev/") + entry->d_name;

        int fd = open(devicePath.c_str(), O_RDONLY);
        if (fd >= 0) {
          struct v4l2_capability cap;
          if (ioctl(fd, VIDIOC_QUERYCAP, &cap) == 0) {
            // Check if it's a video capture device
            if (cap.device_caps & V4L2_CAP_VIDEO_CAPTURE) {
              DeviceInfo info;
              info.name = devicePath;
              info.description = std::string(reinterpret_cast<const char*>(cap.card));
              info.type = "video";
              info.isDefault = isFirstVideo;
              isFirstVideo = false;
              devices.push_back(info);
            }
          }
          close(fd);
        }
      }
    }
    closedir(dir);
  }

  // Audio and screen device enumeration removed (not needed for video-only build)

  return devices;
}

std::vector<DeviceMode> enumerateDeviceModes(const std::string& deviceName) {
  std::vector<DeviceMode> modes;

  int fd = open(deviceName.c_str(), O_RDONLY);
  if (fd < 0) {
    throw std::runtime_error("Failed to open device: " + deviceName);
  }

  struct ModeKey {
    int w, h;
    AVPixelFormat pixelFormat;
    bool operator<(const ModeKey& o) const {
      if (w != o.w) return w < o.w;
      if (h != o.h) return h < o.h;
      return pixelFormat < o.pixelFormat;
    }
  };
  std::map<ModeKey, std::pair<double, double>> modeMap;

  // Iterate over all supported pixel formats
  struct v4l2_fmtdesc fmt;
  memset(&fmt, 0, sizeof(fmt));
  fmt.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;

  for (fmt.index = 0; ioctl(fd, VIDIOC_ENUM_FMT, &fmt) == 0; fmt.index++) {
    AVPixelFormat pixFmt = v4l2FormatToAV(fmt.pixelformat);

    struct v4l2_frmsizeenum frmsize;
    memset(&frmsize, 0, sizeof(frmsize));
    frmsize.pixel_format = fmt.pixelformat;

    for (frmsize.index = 0; ioctl(fd, VIDIOC_ENUM_FRAMESIZES, &frmsize) == 0; frmsize.index++) {
      if (frmsize.type == V4L2_FRMSIZE_TYPE_DISCRETE) {
        int w = frmsize.discrete.width;
        int h = frmsize.discrete.height;

        struct v4l2_frmivalenum frmival;
        memset(&frmival, 0, sizeof(frmival));
        frmival.pixel_format = fmt.pixelformat;
        frmival.width = w;
        frmival.height = h;

        double minFps = 1e9, maxFps = 0;

        for (frmival.index = 0; ioctl(fd, VIDIOC_ENUM_FRAMEINTERVALS, &frmival) == 0; frmival.index++) {
          if (frmival.type == V4L2_FRMIVAL_TYPE_DISCRETE) {
            double fps = (double)frmival.discrete.denominator / (double)frmival.discrete.numerator;
            if (fps < minFps) minFps = fps;
            if (fps > maxFps) maxFps = fps;
          } else if (frmival.type == V4L2_FRMIVAL_TYPE_STEPWISE || frmival.type == V4L2_FRMIVAL_TYPE_CONTINUOUS) {
            double fpsMin = (double)frmival.stepwise.max.denominator / (double)frmival.stepwise.max.numerator;
            double fpsMax = (double)frmival.stepwise.min.denominator / (double)frmival.stepwise.min.numerator;
            if (fpsMin < minFps) minFps = fpsMin;
            if (fpsMax > maxFps) maxFps = fpsMax;
            break;
          }
        }

        if (maxFps > 0) {
          ModeKey key{w, h, pixFmt};
          auto it = modeMap.find(key);
          if (it == modeMap.end()) {
            modeMap[key] = {minFps, maxFps};
          } else {
            if (minFps < it->second.first) it->second.first = minFps;
            if (maxFps > it->second.second) it->second.second = maxFps;
          }
        }
      }
    }
  }

  close(fd);

  for (auto& [key, fps] : modeMap) {
    DeviceMode mode;
    mode.width = key.w;
    mode.height = key.h;
    mode.minFrameRate = fps.first;
    mode.maxFrameRate = fps.second;
    mode.pixelFormat = key.pixelFormat;
    modes.push_back(mode);
  }

  std::sort(modes.begin(), modes.end(), [](const DeviceMode& a, const DeviceMode& b) {
    int areaA = a.width * a.height;
    int areaB = b.width * b.height;
    if (areaA != areaB) return areaA > areaB;
    return a.maxFrameRate > b.maxFrameRate;
  });

  return modes;
}

std::vector<AudioDeviceMode> enumerateAudioDeviceModes(const std::string& deviceName) {
  return {};
}

std::string getVideoInputFormat() {
  return "v4l2";
}

std::string getAudioInputFormat() {
  return "alsa";
}

std::string getScreenInputFormat() {
  return "x11grab";
}

bool hasScreenCapturePermission() {
  return true;
}

bool requestScreenCaptureAccess() {
  return true;
}

} // namespace ffmpeg

#endif // __linux__
