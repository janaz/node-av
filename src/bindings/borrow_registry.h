#ifndef FFMPEG_BORROW_REGISTRY_H
#define FFMPEG_BORROW_REGISTRY_H

#include <memory>
#include <unordered_set>

namespace ffmpeg {

class BorrowRegistry;

// A wrapper pointing into memory another native object owns: a Stream into
// its AVFormatContext, a CodecParameters into a stream's or bitstream filter's
// codecpar. The JS object can outlive that memory, so the owner invalidates
// its borrowers before freeing it, and they read their defaults afterwards
// instead of freed memory.
//
// JS thread only: borrowers are created, used and finalized there, and owners
// invalidate them there before the memory is freed (also before handing it to
// a worker that frees it), so neither side needs a lock.
class Borrower {
public:
  Borrower() = default;
  Borrower(const Borrower&) = delete;
  Borrower& operator=(const Borrower&) = delete;
  virtual ~Borrower();

  // Registers with the owner of the memory this wrapper now points into
  // (replacing a previous registration)
  void BorrowFrom(const std::shared_ptr<BorrowRegistry>& registry);

  // Leaves the current owner's registry, e.g. when the wrapper takes
  // ownership of its own memory
  void StopBorrowing();

  // The registry this wrapper borrows from, for wrappers it hands out in turn
  const std::shared_ptr<BorrowRegistry>& BorrowedFrom() const { return registry_; }

protected:
  // Drops every pointer into the owner's memory
  virtual void Invalidate() = 0;

private:
  friend class BorrowRegistry;
  std::shared_ptr<BorrowRegistry> registry_;
};

// Held by the owner of the memory; borrowers keep it alive with their own
// reference, so either side may be finalized first
class BorrowRegistry {
public:
  // Invalidates every current borrower; call before freeing the memory they
  // point into. The registry stays usable for the owner's next allocation.
  void InvalidateAll() {
    std::unordered_set<Borrower*> borrowers;
    borrowers.swap(borrowers_);
    for (Borrower* borrower : borrowers) {
      borrower->registry_.reset();
      borrower->Invalidate();
    }
  }

private:
  friend class Borrower;
  std::unordered_set<Borrower*> borrowers_;
};

inline Borrower::~Borrower() {
  StopBorrowing();
}

inline void Borrower::BorrowFrom(const std::shared_ptr<BorrowRegistry>& registry) {
  StopBorrowing();
  if (registry) {
    registry_ = registry;
    registry_->borrowers_.insert(this);
  }
}

inline void Borrower::StopBorrowing() {
  if (registry_) {
    registry_->borrowers_.erase(this);
    registry_.reset();
  }
}

} // namespace ffmpeg

#endif // FFMPEG_BORROW_REGISTRY_H
