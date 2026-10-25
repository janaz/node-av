#ifndef FFMPEG_FILTER_GRAPH_SEGMENT_H
#define FFMPEG_FILTER_GRAPH_SEGMENT_H

#include <napi.h>
#include "common.h"
#include "borrow_registry.h"

extern "C" {
#include <libavfilter/avfilter.h>
}

namespace ffmpeg {

// Forward declarations
class FilterGraph;

class FilterGraphSegment : public Napi::ObjectWrap<FilterGraphSegment>, public Borrower {
public:
  static thread_local Napi::FunctionReference constructor;
  static Napi::Object Init(Napi::Env env, Napi::Object exports);
  FilterGraphSegment(const Napi::CallbackInfo& info);
  ~FilterGraphSegment();

  AVFilterGraphSegment* Get() { return segment_; }

  // Takes ownership of a segment parsed into a graph, borrowing from the
  // FilterGraph owning that graph
  void SetSegment(AVFilterGraphSegment* segment);

protected:
  // Useless without its graph; freeing it touches only its own allocations
  void Invalidate() override { avfilter_graph_segment_free(&segment_); }

private:
  friend class FilterGraph;


  AVFilterGraphSegment* segment_ = nullptr;

  Napi::Value Free(const Napi::CallbackInfo& info);
  Napi::Value CreateFilters(const Napi::CallbackInfo& info);
  Napi::Value ApplyOpts(const Napi::CallbackInfo& info);
  Napi::Value Apply(const Napi::CallbackInfo& info);
  Napi::Value Dispose(const Napi::CallbackInfo& info);
};

} // namespace ffmpeg

#endif // FFMPEG_FILTER_GRAPH_SEGMENT_H
