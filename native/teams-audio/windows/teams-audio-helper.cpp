// Bee call audio helper for Windows. Hears everything this computer plays (all system audio, as Cluely does), and writes it
// to stdout as raw 16 kHz mono signed 16-bit little-endian PCM. Protocol: native/teams-audio/README.md.
//
// How: WASAPI loopback on the default playback device (IMMDeviceEnumerator::GetDefaultAudioEndpoint(eRender, eConsole),
// AUDCLNT_STREAMFLAGS_LOOPBACK): the mix the speakers or headphones play, whichever app plays it. Windows converts the mix to
// 16 kHz mono (AUTOCONVERTPCM), or to 48 kHz stereo that this helper downmixes. When the default device changes (headphones
// plugged in) or goes away, the helper opens the new default one and carries on. Loopback gives no data while nothing plays,
// so the helper writes silence for that time: Bee's speech-to-text keeps its clock.
//
// Floor: Windows 10. Permission: none.
//
// stderr carries status codes only (`status=<code>`, maybe ` hr=0x…`): never audio, names or titles. Exit codes: 0 clean stop,
// 2 usage, 3 unsupported, 4 denied, 6 failed (5, "no-teams", is not used since protocol 3: there is no target app).

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif

#include <windows.h>
#include <objbase.h>
#include <audioclient.h>
#include <mmdeviceapi.h>

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <cwchar>
#include <string>
#include <vector>

namespace {

constexpr int kProtocol = 3;
constexpr int kExitOk = 0;
constexpr int kExitUsage = 2;
constexpr int kExitUnsupported = 3;
constexpr int kExitDenied = 4;
constexpr int kExitNoTeams = 5;
constexpr int kExitFailed = 6;

constexpr DWORD kMinBuild = 10240;
constexpr DWORD kSampleRate = 16000;
// The fallback format if Windows will not convert to 16 kHz mono itself: 48 kHz stereo, downmixed and decimated here.
constexpr DWORD kFallbackRate = 48000;
constexpr WORD kFallbackChannels = 2;
// 200 ms of buffer in 100 ns units; the helper reads every 10 ms.
constexpr REFERENCE_TIME kBufferDuration = 2000000;
constexpr DWORD kPollMs = 10;
// How often the helper checks that the default playback device is still the one it hears.
constexpr ULONGLONG kDeviceCheckMs = 2000;
// Silence is written only once the stream is this far behind the clock (nothing played), so real audio is never padded.
constexpr ULONGLONG kSilenceLagMs = 200;
// Device lost or changed: how many times in a row the helper tries to open the default device before it gives up.
constexpr int kReopenTries = 10;

using RtlGetVersionFn = LONG(WINAPI*)(PRTL_OSVERSIONINFOW);

HANDLE g_stop = nullptr;

void Status(const char* code, HRESULT hr = S_OK, const char* extra = nullptr) {
  char line[96];
  int length;
  if (hr != S_OK) {
    length = std::snprintf(line, sizeof line, "status=%s hr=0x%08lX\n", code, static_cast<unsigned long>(hr));
  } else if (extra) {
    length = std::snprintf(line, sizeof line, "status=%s %s\n", code, extra);
  } else {
    length = std::snprintf(line, sizeof line, "status=%s\n", code);
  }
  if (length <= 0) return;
  DWORD written = 0;
  WriteFile(GetStdHandle(STD_ERROR_HANDLE), line, static_cast<DWORD>(length), &written, nullptr);
}

void Print(const char* text) {
  DWORD written = 0;
  WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), text, static_cast<DWORD>(std::strlen(text)), &written, nullptr);
}

bool WriteAll(HANDLE out, const void* data, size_t size) {
  const char* bytes = static_cast<const char*>(data);
  while (size > 0) {
    DWORD chunk = size > 0x10000000 ? 0x10000000 : static_cast<DWORD>(size);
    DWORD written = 0;
    if (!WriteFile(out, bytes, chunk, &written, nullptr) || written == 0) return false;
    bytes += written;
    size -= written;
  }
  return true;
}

template <typename Fn>
Fn LoadProc(HMODULE module, const char* name) {
  if (!module) return nullptr;
  return reinterpret_cast<Fn>(reinterpret_cast<void*>(GetProcAddress(module, name)));
}

// The real build number (GetVersionEx reports the manifest's version, not the OS's).
DWORD WindowsBuild() {
  auto rtlGetVersion = LoadProc<RtlGetVersionFn>(GetModuleHandleW(L"ntdll.dll"), "RtlGetVersion");
  RTL_OSVERSIONINFOW info{};
  info.dwOSVersionInfoSize = sizeof info;
  if (!rtlGetVersion || rtlGetVersion(&info) != 0) return 0;
  if (info.dwMajorVersion > 10) return MAXDWORD;
  return info.dwMajorVersion == 10 ? info.dwBuildNumber : 0;
}

WAVEFORMATEX Format(DWORD rate, WORD channels) {
  WAVEFORMATEX format{};
  format.wFormatTag = WAVE_FORMAT_PCM;
  format.nChannels = channels;
  format.nSamplesPerSec = rate;
  format.wBitsPerSample = 16;
  format.nBlockAlign = static_cast<WORD>(channels * 2);
  format.nAvgBytesPerSec = rate * format.nBlockAlign;
  format.cbSize = 0;
  return format;
}

// ---- Conversion to 16 kHz mono s16le ----

// Passes 16 kHz mono through. 48 kHz stereo: downmix, low-pass (windowed sinc, flat to about 6 kHz) and keep every third.
class Converter {
 public:
  Converter(DWORD rate, WORD channels) : channels_(channels), passthrough_(rate == kSampleRate && channels == 1) {
    if (passthrough_) return;
    factor_ = rate / kSampleRate;
    const int taps = 96;
    const double cutoff = 0.9 * 8000.0 / rate;  // as a share of the input rate
    taps_.resize(taps);
    double total = 0;
    for (int tap = 0; tap < taps; ++tap) {
      const double x = tap - (taps - 1) / 2.0;
      const double sinc = x == 0 ? 2 * cutoff : std::sin(2 * 3.14159265358979323846 * cutoff * x) / (3.14159265358979323846 * x);
      const double window = 0.5 - 0.5 * std::cos(2 * 3.14159265358979323846 * tap / (taps - 1));
      taps_[tap] = sinc * window;
      total += taps_[tap];
    }
    for (double& weight : taps_) weight /= total;
    history_.assign(taps, 0.0f);
  }

  // samples: frames × channels interleaved s16, or null for silence.
  void Push(const int16_t* samples, UINT32 frames, std::vector<int16_t>& out) {
    if (passthrough_) {
      if (samples) {
        out.insert(out.end(), samples, samples + frames);
      } else {
        out.insert(out.end(), frames, 0);
      }
      return;
    }
    for (UINT32 frame = 0; frame < frames; ++frame) {
      float mono = 0;
      if (samples) {
        for (WORD channel = 0; channel < channels_; ++channel) mono += samples[frame * channels_ + channel];
        mono /= channels_;
      }
      history_[position_] = mono;
      position_ = (position_ + 1) % history_.size();
      if (++phase_ < factor_) continue;
      phase_ = 0;
      double sum = 0;
      for (size_t tap = 0; tap < taps_.size(); ++tap) sum += taps_[tap] * history_[(position_ + tap) % history_.size()];
      const double clamped = sum > 32767 ? 32767 : (sum < -32768 ? -32768 : sum);
      out.push_back(static_cast<int16_t>(std::lround(clamped)));
    }
  }

 private:
  WORD channels_;
  bool passthrough_;
  DWORD factor_ = 1;
  DWORD phase_ = 0;
  size_t position_ = 0;
  std::vector<double> taps_;
  std::vector<float> history_;
};

// ---- Lifetime ----

BOOL WINAPI OnConsoleEvent(DWORD) {
  if (g_stop) SetEvent(g_stop);
  return TRUE;
}

// Bee closes stdin to stop the helper; if Bee dies, the pipe breaks the same way. Watched only when stdin is a pipe.
DWORD WINAPI WatchStdin(LPVOID) {
  HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  char buffer[256];
  DWORD read = 0;
  while (ReadFile(input, buffer, sizeof buffer, &read, nullptr) && read > 0) {
  }
  SetEvent(g_stop);
  return 0;
}

// ---- The default playback device ----

// The default render (playback) endpoint and its id, or a failure. The caller releases the device and frees the id.
HRESULT DefaultDevice(IMMDevice** device, LPWSTR* id) {
  *device = nullptr;
  *id = nullptr;
  IMMDeviceEnumerator* enumerator = nullptr;
  HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, __uuidof(IMMDeviceEnumerator), reinterpret_cast<void**>(&enumerator));
  if (FAILED(hr)) return hr;
  hr = enumerator->GetDefaultAudioEndpoint(eRender, eConsole, device);
  enumerator->Release();
  if (FAILED(hr)) return hr;
  hr = (*device)->GetId(id);
  if (FAILED(hr)) {
    (*device)->Release();
    *device = nullptr;
  }
  return hr;
}

// Whether the default playback device is still this one (a failed read counts as the same: the stream's own errors decide).
bool SameDefaultDevice(const std::wstring& id) {
  IMMDevice* device = nullptr;
  LPWSTR now = nullptr;
  if (FAILED(DefaultDevice(&device, &now))) return true;
  const bool same = id == now;
  CoTaskMemFree(now);
  device->Release();
  return same;
}

// A loopback capture client on device in format. Windows converts the device's mix to it (AUTOCONVERTPCM).
HRESULT OpenClient(IMMDevice* device, const WAVEFORMATEX& format, IAudioClient** client) {
  HRESULT hr = device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(client));
  if (FAILED(hr)) return hr;
  const DWORD flags = AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
  hr = (*client)->Initialize(AUDCLNT_SHAREMODE_SHARED, flags, kBufferDuration, 0, &format, nullptr);
  if (FAILED(hr)) {
    (*client)->Release();
    *client = nullptr;
  }
  return hr;
}

bool IsUnsupported(HRESULT hr) {
  return hr == E_NOTIMPL || hr == E_NOINTERFACE || hr == REGDB_E_CLASSNOTREG || hr == HRESULT_FROM_WIN32(ERROR_NOT_SUPPORTED) ||
         hr == AUDCLNT_E_UNSUPPORTED_FORMAT;
}

// The device went away or changed under the stream: open the default one again.
bool IsDeviceGone(HRESULT hr) {
  return hr == AUDCLNT_E_DEVICE_INVALIDATED || hr == AUDCLNT_E_SERVICE_NOT_RUNNING || hr == AUDCLNT_E_ENDPOINT_CREATE_FAILED ||
         hr == E_NOTFOUND || hr == HRESULT_FROM_WIN32(ERROR_NOT_FOUND);
}

int ExitFor(HRESULT hr) {
  if (hr == E_ACCESSDENIED) {
    Status("denied", hr);
    return kExitDenied;
  }
  if (IsUnsupported(hr)) {
    Status("unsupported", hr);
    return kExitUnsupported;
  }
  Status("failed", hr);
  return kExitFailed;
}

void Usage(bool error) {
  const char* text =
      "Usage: teams-audio-helper [--request-permission] [--protocol] [--version] [--help]\n"
      "Writes everything this computer plays (all system audio, from the default playback device) to stdout as raw 16 kHz mono\n"
      "s16le PCM. Status codes go to stderr.\n";
  if (error) {
    DWORD written = 0;
    WriteFile(GetStdHandle(STD_ERROR_HANDLE), text, static_cast<DWORD>(std::strlen(text)), &written, nullptr);
  } else {
    Print(text);
  }
}

// --protocol: the protocol constants as one JSON object, so CI can compare them with core/teams-audio-protocol.ts.
// Never opens audio.
void PrintProtocol() {
  char line[512];
  std::snprintf(line, sizeof line,
                "{\"protocol\":%d,\"sampleRate\":%lu,"
                "\"exit\":{\"ok\":%d,\"usage\":%d,\"unsupported\":%d,\"denied\":%d,\"noTeams\":%d,\"failed\":%d},"
                "\"capture\":{\"source\":\"system\",\"device\":\"default-render-loopback\"}}\n",
                kProtocol, static_cast<unsigned long>(kSampleRate), kExitOk, kExitUsage, kExitUnsupported, kExitDenied,
                kExitNoTeams, kExitFailed);
  Print(line);
}

// ---- Capture ----

enum class Ended { Stopped, Closed, DeviceChanged, Failed };

// One stream on the default device until Bee stops it, the device changes or goes away, or it fails. hr: the failure.
Ended CaptureDevice(IMMDevice* device, const std::wstring& id, bool& announced, HRESULT& hr) {
  IAudioClient* client = nullptr;
  WAVEFORMATEX format = Format(kSampleRate, 1);
  hr = OpenClient(device, format, &client);
  if (hr == AUDCLNT_E_UNSUPPORTED_FORMAT || hr == E_INVALIDARG) {
    format = Format(kFallbackRate, kFallbackChannels);
    hr = OpenClient(device, format, &client);
  }
  if (FAILED(hr)) return IsDeviceGone(hr) ? Ended::DeviceChanged : Ended::Failed;

  IAudioCaptureClient* capture = nullptr;
  hr = client->GetService(__uuidof(IAudioCaptureClient), reinterpret_cast<void**>(&capture));
  if (SUCCEEDED(hr)) hr = client->Start();
  if (FAILED(hr)) {
    if (capture) capture->Release();
    client->Release();
    return IsDeviceGone(hr) ? Ended::DeviceChanged : Ended::Failed;
  }
  if (!announced) {
    Status("ready");
    announced = true;
  }

  HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
  Converter converter(format.nSamplesPerSec, format.nChannels);
  std::vector<int16_t> pcm;
  const ULONGLONG started = GetTickCount64();
  ULONGLONG lastDeviceCheck = started;
  // Samples written since this stream started, against the clock, to fill silence while nothing plays.
  unsigned long long written = 0;
  Ended ended = Ended::Stopped;

  for (;;) {
    if (WaitForSingleObject(g_stop, kPollMs) == WAIT_OBJECT_0) {
      Status("stopped");
      ended = Ended::Stopped;
      break;
    }
    UINT32 packet = 0;
    bool closed = false;
    while (SUCCEEDED(hr = capture->GetNextPacketSize(&packet)) && packet > 0) {
      BYTE* data = nullptr;
      UINT32 frames = 0;
      DWORD flags = 0;
      hr = capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
      if (FAILED(hr)) break;
      const bool silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0;
      converter.Push(silent ? nullptr : reinterpret_cast<const int16_t*>(data), frames, pcm);
      capture->ReleaseBuffer(frames);
    }
    if (FAILED(hr)) {
      ended = IsDeviceGone(hr) ? Ended::DeviceChanged : Ended::Failed;
      break;
    }
    // Nothing played for a while: silence up to the clock, so the stream keeps time.
    const ULONGLONG now = GetTickCount64();
    const unsigned long long due = (now - started) * kSampleRate / 1000;
    const unsigned long long lag = kSilenceLagMs * kSampleRate / 1000;
    if (pcm.empty() && due > written + lag) pcm.insert(pcm.end(), static_cast<size_t>(due - written - lag / 2), 0);
    if (!pcm.empty()) {
      closed = !WriteAll(output, pcm.data(), pcm.size() * sizeof(int16_t));
      written += pcm.size();
      pcm.clear();
    }
    if (closed) {
      // Bee stopped reading: a clean stop.
      ended = Ended::Closed;
      break;
    }
    if (now - lastDeviceCheck >= kDeviceCheckMs) {
      lastDeviceCheck = now;
      if (!SameDefaultDevice(id)) {
        Status("device-changed");
        ended = Ended::DeviceChanged;
        break;
      }
    }
  }

  client->Stop();
  capture->Release();
  client->Release();
  return ended;
}

int Capture() {
  bool announced = false;
  int tries = 0;
  for (;;) {
    IMMDevice* device = nullptr;
    LPWSTR raw = nullptr;
    HRESULT hr = DefaultDevice(&device, &raw);
    if (FAILED(hr)) {
      // No playback device right now (unplugged): wait and look again, then give up.
      if (++tries > kReopenTries) return ExitFor(hr);
      if (WaitForSingleObject(g_stop, 1000) == WAIT_OBJECT_0) {
        Status("stopped");
        return kExitOk;
      }
      continue;
    }
    const std::wstring id = raw;
    CoTaskMemFree(raw);
    const Ended ended = CaptureDevice(device, id, announced, hr);
    device->Release();
    if (ended == Ended::Stopped || ended == Ended::Closed) return kExitOk;
    if (ended == Ended::Failed) return ExitFor(hr);
    // The device changed or went away: open the default one again.
    if (++tries > kReopenTries) return ExitFor(hr);
    if (WaitForSingleObject(g_stop, 300) == WAIT_OBJECT_0) {
      Status("stopped");
      return kExitOk;
    }
    if (ended == Ended::DeviceChanged) tries = announced ? 0 : tries;
  }
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  for (int index = 1; index < argc; ++index) {
    const wchar_t* arg = argv[index];
    if (std::wcscmp(arg, L"--version") == 0) {
      char line[64];
      std::snprintf(line, sizeof line, "teams-audio-helper protocol=%d\n", kProtocol);
      Print(line);
      return kExitOk;
    }
    if (std::wcscmp(arg, L"--protocol") == 0) {
      PrintProtocol();
      return kExitOk;
    }
    if (std::wcscmp(arg, L"--help") == 0) {
      Usage(false);
      return kExitOk;
    }
    if (std::wcscmp(arg, L"--request-permission") == 0) {
      // Windows asks for no permission to hear its own playback.
      Status("granted");
      return kExitOk;
    }
    Usage(true);
    return kExitUsage;
  }

  if (WindowsBuild() < kMinBuild) {
    Status("unsupported");
    return kExitUnsupported;
  }

  g_stop = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (!g_stop) {
    Status("failed", HRESULT_FROM_WIN32(GetLastError()));
    return kExitFailed;
  }
  SetConsoleCtrlHandler(OnConsoleEvent, TRUE);
  if (GetFileType(GetStdHandle(STD_INPUT_HANDLE)) == FILE_TYPE_PIPE) {
    HANDLE watcher = CreateThread(nullptr, 0, WatchStdin, nullptr, 0, nullptr);
    if (watcher) CloseHandle(watcher);
  }

  const HRESULT com = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(com)) {
    Status("failed", com);
    return kExitFailed;
  }
  const int code = Capture();
  CoUninitialize();
  return code;
}
