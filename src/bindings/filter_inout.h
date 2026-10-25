#ifndef FFMPEG_FILTER_INOUT_H
#define FFMPEG_FILTER_INOUT_H

#include <napi.h>
#include "common.h"
#include "borrow_registry.h"

extern "C" {
#include <libavfilter/avfilter.h>
}

namespace ffmpeg {

// Forward declaration
class FilterContext;

class FilterInOut : public Napi::ObjectWrap<FilterInOut>, public Borrower {
public:
  static thread_local Napi::FunctionReference constructor;
  static Napi::Object Init(Napi::Env env, Napi::Object exports);
  FilterInOut(const Napi::CallbackInfo& info);
  ~FilterInOut();

  AVFilterInOut* Get() { return inout_; }

  // Takes ownership of a list, e.g. one FFmpeg returned to the caller
  void SetOwned(AVFilterInOut* inout) {
    FreeList();
    inout_ = inout;
    is_owned_ = true;
    StopBorrowing();
  }

  // Copies a whole list for FFmpeg functions that consume or rewrite theirs,
  // so the FilterInOut passed in keeps its own
  static int CopyList(const AVFilterInOut* list, AVFilterInOut** copy);

protected:
  void Invalidate() override { inout_ = nullptr; }

private:
  friend class FilterGraph;


  AVFilterInOut* inout_ = nullptr;
  bool is_owned_ = true;

  // Wrappers pointing into this list (its next elements, lists appended to it)
  // while this wrapper owns it
  std::shared_ptr<BorrowRegistry> borrowers_ = std::make_shared<BorrowRegistry>();

  // Where wrappers into this list register: here if this wrapper owns it,
  // else with the wrapper that does
  std::shared_ptr<BorrowRegistry> ListOwner() { return is_owned_ ? borrowers_ : BorrowedFrom(); }
  void FreeList();

  Napi::Value Alloc(const Napi::CallbackInfo& info);
  Napi::Value Free(const Napi::CallbackInfo& info);
  Napi::Value Dispose(const Napi::CallbackInfo& info);

  Napi::Value GetName(const Napi::CallbackInfo& info);
  void SetName(const Napi::CallbackInfo& info, const Napi::Value& value);

  Napi::Value GetFilterCtx(const Napi::CallbackInfo& info);
  void SetFilterCtx(const Napi::CallbackInfo& info, const Napi::Value& value);

  Napi::Value GetPadIdx(const Napi::CallbackInfo& info);
  void SetPadIdx(const Napi::CallbackInfo& info, const Napi::Value& value);

  Napi::Value GetNext(const Napi::CallbackInfo& info);
  void SetNext(const Napi::CallbackInfo& info, const Napi::Value& value);
};

} // namespace ffmpeg

#endif // FFMPEG_FILTER_INOUT_H