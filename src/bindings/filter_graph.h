#ifndef FFMPEG_FILTER_GRAPH_H
#define FFMPEG_FILTER_GRAPH_H

#include <napi.h>
#include "common.h"
#include "borrow_registry.h"
#include "promise_worker.h"

extern "C" {
#include <libavfilter/avfilter.h>
#include <libavfilter/buffersink.h>
#include <libavfilter/buffersrc.h>
}

namespace ffmpeg {

// Forward declarations
class Filter;
class FilterContext;

class FilterGraph : public Napi::ObjectWrap<FilterGraph>, public Borrower {
public:
  static thread_local Napi::FunctionReference constructor;
  static Napi::Object Init(Napi::Env env, Napi::Object exports);
  FilterGraph(const Napi::CallbackInfo& info);
  ~FilterGraph();

  AVFilterGraph* Get() { 
    return graph_ ? graph_ : unowned_graph_; 
  }
  // Wraps a graph another FilterGraph owns, borrowing from that owner
  void SetUnowned(AVFilterGraph* graph);

  // The registry of the FilterGraph that owns `graph`, for wrappers pointing
  // into it (null if no FilterGraph owns it)
  static std::shared_ptr<BorrowRegistry> BorrowersOf(const AVFilterGraph* graph);

protected:
  void Invalidate() override { unowned_graph_ = nullptr; }

private:
  friend class AVOptionWrapper;
  friend class FilterContext;


  AVFilterGraph* graph_ = nullptr;
  AVFilterGraph* unowned_graph_ = nullptr;

  // In-flight threadpool operations (config/requestOldest); free/replace
  // paths wait on this so they cannot free graph_ under a worker.
  AsyncOpCounter async_ops_;

  // Wrappers pointing into graph_ (its filter contexts, segments, unowned
  // graph wrappers); graph_->opaque points back here so they can find it
  std::shared_ptr<BorrowRegistry> borrowers_ = std::make_shared<BorrowRegistry>();

  bool GuardWorkers(Napi::Env env);
  void FreeGraph();

  Napi::Value Alloc(const Napi::CallbackInfo& info);
  Napi::Value Free(const Napi::CallbackInfo& info);
  Napi::Value CreateFilter(const Napi::CallbackInfo& info);
  Napi::Value AllocFilter(const Napi::CallbackInfo& info);
  Napi::Value GetFilter(const Napi::CallbackInfo& info);
  Napi::Value ConfigAsync(const Napi::CallbackInfo& info);
  Napi::Value ConfigSync(const Napi::CallbackInfo& info);
  Napi::Value Parse(const Napi::CallbackInfo& info);
  Napi::Value Parse2(const Napi::CallbackInfo& info);
  Napi::Value ParsePtr(const Napi::CallbackInfo& info);
  Napi::Value SegmentParse(const Napi::CallbackInfo& info);
  Napi::Value Validate(const Napi::CallbackInfo& info);
  Napi::Value RequestOldestAsync(const Napi::CallbackInfo& info);
  Napi::Value RequestOldestSync(const Napi::CallbackInfo& info);
  Napi::Value Dump(const Napi::CallbackInfo& info);
  Napi::Value SendCommand(const Napi::CallbackInfo& info);
  Napi::Value QueueCommand(const Napi::CallbackInfo& info);
  Napi::Value Dispose(const Napi::CallbackInfo& info);

  Napi::Value GetNbFilters(const Napi::CallbackInfo& info);

  Napi::Value GetFilters(const Napi::CallbackInfo& info);

  Napi::Value GetThreadType(const Napi::CallbackInfo& info);
  void SetThreadType(const Napi::CallbackInfo& info, const Napi::Value& value);

  Napi::Value GetNbThreads(const Napi::CallbackInfo& info);
  void SetNbThreads(const Napi::CallbackInfo& info, const Napi::Value& value);

  Napi::Value GetScaleSwsOpts(const Napi::CallbackInfo& info);
  void SetScaleSwsOpts(const Napi::CallbackInfo& info, const Napi::Value& value);

  Napi::Value GetAresampleSwrOpts(const Napi::CallbackInfo& info);
  void SetAresampleSwrOpts(const Napi::CallbackInfo& info, const Napi::Value& value);
};

} // namespace ffmpeg

#endif // FFMPEG_FILTER_GRAPH_H