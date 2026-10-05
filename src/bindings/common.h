#ifndef FFMPEG_COMMON_H
#define FFMPEG_COMMON_H

#include <napi.h>
#include <memory>
#include <string>

// Fix for glibc > 2.31 compatibility
// These _finite functions were removed but FFmpeg might still reference them
#ifdef __linux__
#include <math.h>
extern "C" {
  __attribute__((weak)) float __log2f_finite(float x) {
    return log2f(x);
  }
  __attribute__((weak)) double __log2_finite(double x) {
    return log2(x);
  }
  __attribute__((weak)) float __logf_finite(float x) {
    return logf(x);
  }
  __attribute__((weak)) double __log_finite(double x) {
    return log(x);
  }
  __attribute__((weak)) float __expf_finite(float x) {
    return expf(x);
  }
  __attribute__((weak)) double __exp_finite(double x) {
    return exp(x);
  }
  __attribute__((weak)) float __exp2f_finite(float x) {
    return exp2f(x);
  }
  __attribute__((weak)) double __exp2_finite(double x) {
    return exp2(x);
  }
  __attribute__((weak)) float __powf_finite(float x, float y) {
    return powf(x, y);
  }
  __attribute__((weak)) double __pow_finite(double x, double y) {
    return pow(x, y);
  }
}
#endif

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavfilter/avfilter.h>
#include <libavutil/avutil.h>
#include <libavutil/buffer.h>
#include <libavutil/dict.h>
#include <libavutil/error.h>
#include <libavutil/rational.h>
#include <libswscale/swscale.h>
#include <libswresample/swresample.h>
}

namespace ffmpeg {

inline AVRational JSToRational(const Napi::Object& obj) {
  AVRational r;
  r.num = obj.Get("num").As<Napi::Number>().Int32Value();
  r.den = obj.Get("den").As<Napi::Number>().Int32Value();
  return r;
}

// JS function (num, den) => ({ num, den }) of the env that loaded the addon on
// this thread, set by InitRationalFactory() (utilities.cc). Never deleted: the
// env releases its references when it is torn down.
extern thread_local napi_env rational_factory_env;
extern thread_local napi_ref rational_factory;

// Compiles the factory RationalToJS builds its objects with. If that fails,
// RationalToJS keeps creating native objects.
void InitRationalFactory(Napi::Env env);

inline Napi::Object RationalToJS(const Napi::Env& env, const AVRational& r) {
  // A JS object literal is far cheaper than a native object with two named
  // properties: about 100 instead of 260 ns per rational getter.
  if (rational_factory_env == env) {
    napi_value factory;
    napi_value argv[2];
    napi_value result;
    if (napi_get_reference_value(env, rational_factory, &factory) == napi_ok && napi_create_int32(env, r.num, &argv[0]) == napi_ok &&
        napi_create_int32(env, r.den, &argv[1]) == napi_ok && napi_call_function(env, env.Undefined(), factory, 2, argv, &result) == napi_ok) {
      return Napi::Object(env, result);
    }
  }
  Napi::Object obj = Napi::Object::New(env);
  obj.Set("num", Napi::Number::New(env, r.num));
  obj.Set("den", Napi::Number::New(env, r.den));
  return obj;
}

// True while the env can still execute JS. After worker.terminate() the worker's
// loop drains pending async completions, but every JS-entering napi call fails
// and node-addon-api escalates that failure to a process-fatal abort - completion
// handlers (OnOK/OnError) must bail out instead of touching their promises.
// napi_get_named_property carries the can_call_into_js guard; napi_get_global
// does not, so the combination probes the state without side effects.
inline bool CanCallIntoJs(Napi::Env env) {
  napi_value global;
  if (napi_get_global(env, &global) != napi_ok) {
    return false;
  }
  napi_value probe;
  return napi_get_named_property(env, global, "undefined", &probe) == napi_ok;
}

// The caller's output buffer when given (it must hold at least `size` bytes),
// otherwise a new one; throws a TypeError and returns false for an unusable output
inline bool ResolveOutputBuffer(Napi::Env env, const Napi::Value& output, size_t size, Napi::Buffer<uint8_t>& dst) {
  if (output.IsEmpty() || output.IsUndefined() || output.IsNull()) {
    dst = Napi::Buffer<uint8_t>::New(env, size);
    return true;
  }
  // IsBuffer() is true for every ArrayBufferView, a DataView or wider typed array would break Length() and subarray()
  if (!output.IsTypedArray() || output.As<Napi::TypedArray>().TypedArrayType() != napi_uint8_array) {
    Napi::TypeError::New(env, "output must be a Buffer").ThrowAsJavaScriptException();
    return false;
  }
  dst = output.As<Napi::Buffer<uint8_t>>();
  if (dst.Length() < size) {
    Napi::TypeError::New(env, "output holds " + std::to_string(dst.Length()) + " bytes, " + std::to_string(size) + " are needed")
        .ThrowAsJavaScriptException();
    return false;
  }
  return true;
}

// dst itself when it has exactly `size` bytes, otherwise a view of its first `size` bytes
inline Napi::Value ExactBufferView(Napi::Env env, Napi::Buffer<uint8_t> dst, size_t size) {
  if (dst.Length() == size) {
    return dst;
  }
  Napi::Function subarray = dst.Get("subarray").As<Napi::Function>();
  return subarray.Call(dst, {Napi::Number::New(env, 0), Napi::Number::New(env, static_cast<double>(size))});
}

template<typename T>
T* UnwrapNativeObject(const Napi::Env& env, const Napi::Value& value, const char* typeName) {
  if (!value.IsObject()) {
    return nullptr;
  }

  Napi::Object obj = value.As<Napi::Object>();

  // napi_unwrap returns the wrapped pointer for ANY ObjectWrap instance regardless
  // of its class, so an instanceof check is required before reinterpreting it as T.
  // Deliberately does not throw: callers throw their own TypeError on nullptr, and a
  // second ThrowAsJavaScriptException while one is pending is fatal with
  // NAPI_DISABLE_CPP_EXCEPTIONS.
  if (T::constructor.IsEmpty() || !obj.InstanceOf(T::constructor.Value())) {
    return nullptr;
  }

  return Napi::ObjectWrap<T>::Unwrap(obj);
}

} // namespace ffmpeg

#endif // FFMPEG_COMMON_H