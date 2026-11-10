// Bee Teams audio helper for Windows. Hears the Microsoft Teams desktop app alone, never all system audio, and writes it to
// stdout as raw 16 kHz mono signed 16-bit little-endian PCM. Protocol: native/teams-audio/README.md.
//
// How: WASAPI process loopback (ActivateAudioInterfaceAsync on VAD\Process_Loopback with
// AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK and PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE) on the top Teams process
// (ms-teams.exe or Teams.exe). Only that process and its children are heard. The helper refuses to start, and stops, if the
// Teams process tree holds a program that is not Teams (a browser Teams launched, say), because it would be heard too.
//
// Floor: Windows 10 build 19041 (version 2004). Microsoft documents process loopback from build 20348; it is used from 19041
// elsewhere, and below a build that supports it activation fails and the helper reports "unsupported".
//
// stderr carries status codes only (`status=<code>`, maybe ` hr=0x…`): never audio, names or titles. Exit codes: 0 clean stop,
// 2 usage, 3 unsupported, 4 denied, 5 no Teams, 6 failed.

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
#include <propidl.h>
#include <audioclient.h>
#include <mmdeviceapi.h>
#include <tlhelp32.h>

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <cwchar>
#include <string>
#include <vector>

namespace {

constexpr int kProtocol = 1;
constexpr int kExitOk = 0;
constexpr int kExitUsage = 2;
constexpr int kExitUnsupported = 3;
constexpr int kExitDenied = 4;
constexpr int kExitNoTeams = 5;
constexpr int kExitFailed = 6;

constexpr DWORD kMinBuild = 19041;
constexpr DWORD kSampleRate = 16000;
// The fallback format if Windows will not convert to 16 kHz mono itself: 48 kHz stereo, downmixed and decimated here.
constexpr DWORD kFallbackRate = 48000;
constexpr WORD kFallbackChannels = 2;
// 100 ms of buffer in 100 ns units.
constexpr REFERENCE_TIME kBufferDuration = 1000000;
constexpr DWORD kActivateTimeoutMs = 10000;
constexpr ULONGLONG kTreeCheckMs = 2000;

// Teams desktop apps by image name. Their process trees are what Bee hears.
const wchar_t* const kTeamsImages[] = {L"ms-teams.exe", L"teams.exe"};
// Programs that may run inside a Teams process tree: Teams' own (ms-teams*, teams*), its WebView2 runtime and crash or
// console helpers. Anything else in the tree (a browser Teams started, a media player) stops the capture.
const wchar_t* const kTreePrefixes[] = {L"ms-teams", L"teams"};
const wchar_t* const kTreeImages[] = {L"msedgewebview2.exe", L"crashpad_handler.exe", L"conhost.exe", L"werfault.exe"};

// AUDIOCLIENT_ACTIVATION_PARAMS and AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS (audioclientactivationparams.h), declared here so
// the file builds with older SDKs and MinGW. Enums are 32-bit, so the layout matches.
constexpr DWORD kActivationTypeProcessLoopback = 1;   // AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK
constexpr DWORD kLoopbackIncludeTargetProcessTree = 0;  // PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE
struct LoopbackParams {
  DWORD TargetProcessId;
  DWORD ProcessLoopbackMode;
};
struct ActivationParams {
  DWORD ActivationType;
  LoopbackParams ProcessLoopbackParams;
};
static_assert(sizeof(ActivationParams) == 12, "AUDIOCLIENT_ACTIVATION_PARAMS layout");
const wchar_t* const kProcessLoopbackDevice = L"VAD\\Process_Loopback";  // VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK

// IAgileObject: ActivateAudioInterfaceAsync needs an agile completion handler.
const IID kIIDAgileObject = {0x94ea2b94, 0xe9cc, 0x49e0, {0xc0, 0xff, 0xee, 0x64, 0xca, 0x8f, 0x5b, 0x90}};

using ActivateAudioInterfaceAsyncFn = HRESULT(WINAPI*)(LPCWSTR, REFIID, PROPVARIANT*, IActivateAudioInterfaceCompletionHandler*,
                                                       IActivateAudioInterfaceAsyncOperation**);
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

// ---- Finding Teams ----

struct Process {
  DWORD pid;
  DWORD parent;
  std::wstring image;
};

std::vector<Process> Processes() {
  std::vector<Process> list;
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE) return list;
  PROCESSENTRY32W entry{};
  entry.dwSize = sizeof entry;
  for (BOOL more = Process32FirstW(snapshot, &entry); more; more = Process32NextW(snapshot, &entry)) {
    list.push_back({entry.th32ProcessID, entry.th32ParentProcessID, entry.szExeFile});
  }
  CloseHandle(snapshot);
  return list;
}

bool SameImage(const std::wstring& image, const wchar_t* name) { return _wcsicmp(image.c_str(), name) == 0; }

int TeamsRank(const std::wstring& image) {
  for (int rank = 0; rank < static_cast<int>(sizeof kTeamsImages / sizeof kTeamsImages[0]); ++rank) {
    if (SameImage(image, kTeamsImages[rank])) return rank;
  }
  return -1;
}

bool IsTeamsPid(const std::vector<Process>& list, DWORD pid) {
  for (const auto& process : list) {
    if (process.pid == pid) return TeamsRank(process.image) >= 0;
  }
  return false;
}

// The top of a Teams process tree: a Teams process whose parent is not Teams. New Teams (ms-teams.exe) before classic.
DWORD FindTeamsRoot(const std::vector<Process>& list) {
  DWORD best = 0;
  int bestRank = 1000;
  for (const auto& process : list) {
    const int rank = TeamsRank(process.image);
    if (rank < 0 || process.pid == 0) continue;
    if (IsTeamsPid(list, process.parent)) continue;
    if (rank < bestRank) {
      best = process.pid;
      bestRank = rank;
    }
  }
  return best;
}

bool AllowedInTree(const std::wstring& image) {
  for (const wchar_t* prefix : kTreePrefixes) {
    if (_wcsnicmp(image.c_str(), prefix, std::wcslen(prefix)) == 0) return true;
  }
  for (const wchar_t* name : kTreeImages) {
    if (SameImage(image, name)) return true;
  }
  return false;
}

ULONGLONG CreationTime(DWORD pid) {
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!process) return 0;
  FILETIME created{}, exited{}, kernel{}, user{};
  ULONGLONG value = 0;
  if (GetProcessTimes(process, &created, &exited, &kernel, &user)) {
    value = (static_cast<ULONGLONG>(created.dwHighDateTime) << 32) | created.dwLowDateTime;
  }
  CloseHandle(process);
  return value;
}

// Whether every process in root's tree is Teams or one of its helpers. A child must start after its parent, so a reused
// parent id does not pull an unrelated process in. A process whose start time cannot be read counts as a child.
bool TreeIsTeamsOnly(const std::vector<Process>& list, DWORD root) {
  std::vector<DWORD> tree{root};
  for (size_t index = 0; index < tree.size(); ++index) {
    const DWORD parent = tree[index];
    const ULONGLONG parentCreated = CreationTime(parent);
    for (const auto& process : list) {
      if (process.parent != parent || process.pid == parent || process.pid == 0) continue;
      bool seen = false;
      for (DWORD pid : tree) seen = seen || pid == process.pid;
      if (seen) continue;
      const ULONGLONG created = CreationTime(process.pid);
      if (parentCreated != 0 && created != 0 && created < parentCreated) continue;
      if (!AllowedInTree(process.image)) return false;
      tree.push_back(process.pid);
    }
  }
  return true;
}

// ---- Activation ----

class ActivationHandler final : public IActivateAudioInterfaceCompletionHandler {
 public:
  ActivationHandler() : done_(CreateEventW(nullptr, TRUE, FALSE, nullptr)) {}
  ActivationHandler(const ActivationHandler&) = delete;
  ActivationHandler& operator=(const ActivationHandler&) = delete;

  STDMETHODIMP QueryInterface(REFIID riid, void** out) override {
    if (!out) return E_POINTER;
    if (IsEqualIID(riid, __uuidof(IUnknown)) || IsEqualIID(riid, __uuidof(IActivateAudioInterfaceCompletionHandler)) ||
        IsEqualIID(riid, kIIDAgileObject)) {
      *out = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
      AddRef();
      return S_OK;
    }
    *out = nullptr;
    return E_NOINTERFACE;
  }
  STDMETHODIMP_(ULONG) AddRef() override { return static_cast<ULONG>(InterlockedIncrement(&refs_)); }
  STDMETHODIMP_(ULONG) Release() override {
    const LONG count = InterlockedDecrement(&refs_);
    if (count == 0) delete this;
    return static_cast<ULONG>(count);
  }

  STDMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation* operation) override {
    HRESULT activated = E_FAIL;
    IUnknown* unknown = nullptr;
    HRESULT hr = operation->GetActivateResult(&activated, &unknown);
    if (SUCCEEDED(hr)) hr = activated;
    if (SUCCEEDED(hr) && unknown) hr = unknown->QueryInterface(__uuidof(IAudioClient), reinterpret_cast<void**>(&client_));
    if (SUCCEEDED(hr) && !client_) hr = E_NOINTERFACE;
    if (unknown) unknown->Release();
    result_ = hr;
    SetEvent(done_);
    return S_OK;
  }

  HANDLE done() const { return done_; }
  HRESULT result() const { return result_; }
  IAudioClient* TakeClient() {
    IAudioClient* client = client_;
    client_ = nullptr;
    return client;
  }

 private:
  ~ActivationHandler() {
    if (client_) client_->Release();
    if (done_) CloseHandle(done_);
  }
  LONG refs_ = 1;
  HANDLE done_;
  HRESULT result_ = E_PENDING;
  IAudioClient* client_ = nullptr;
};

HRESULT ActivateProcessLoopback(DWORD pid, IAudioClient** client) {
  *client = nullptr;
  HMODULE mmdevapi = LoadLibraryExW(L"Mmdevapi.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
  auto activate = LoadProc<ActivateAudioInterfaceAsyncFn>(mmdevapi, "ActivateAudioInterfaceAsync");
  if (!activate) return E_NOTIMPL;

  ActivationParams params{};
  params.ActivationType = kActivationTypeProcessLoopback;
  params.ProcessLoopbackParams.TargetProcessId = pid;
  params.ProcessLoopbackParams.ProcessLoopbackMode = kLoopbackIncludeTargetProcessTree;
  PROPVARIANT activation;
  std::memset(&activation, 0, sizeof activation);
  activation.vt = VT_BLOB;
  activation.blob.cbSize = sizeof params;
  activation.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

  auto* handler = new ActivationHandler();
  IActivateAudioInterfaceAsyncOperation* operation = nullptr;
  HRESULT hr = activate(kProcessLoopbackDevice, __uuidof(IAudioClient), &activation, handler, &operation);
  if (SUCCEEDED(hr)) {
    if (WaitForSingleObject(handler->done(), kActivateTimeoutMs) != WAIT_OBJECT_0) {
      hr = HRESULT_FROM_WIN32(ERROR_TIMEOUT);
    } else {
      hr = handler->result();
      if (SUCCEEDED(hr)) *client = handler->TakeClient();
    }
  }
  if (operation) operation->Release();
  handler->Release();
  return hr;
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

// Activates and initialises a capture client in format. Windows converts the Teams mix to it (AUTOCONVERTPCM).
HRESULT OpenClient(DWORD pid, const WAVEFORMATEX& format, IAudioClient** client) {
  HRESULT hr = ActivateProcessLoopback(pid, client);
  if (FAILED(hr)) return hr;
  const DWORD flags = AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
                      AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
  hr = (*client)->Initialize(AUDCLNT_SHAREMODE_SHARED, flags, kBufferDuration, 0, &format, nullptr);
  if (FAILED(hr)) {
    (*client)->Release();
    *client = nullptr;
  }
  return hr;
}

// Errors that mean this Windows has no process loopback: the API or the VAD\Process_Loopback device is missing.
bool IsUnsupported(HRESULT hr) {
  return hr == E_NOTIMPL || hr == E_INVALIDARG || hr == E_NOINTERFACE || hr == REGDB_E_CLASSNOTREG ||
         hr == HRESULT_FROM_WIN32(ERROR_NOT_SUPPORTED) || hr == HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND) ||
         hr == AUDCLNT_E_UNSUPPORTED_FORMAT;
}

int ExitForActivation(HRESULT hr) {
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

void Usage(bool error) {
  const char* text =
      "Usage: teams-audio-helper [--pid <teams process id>] [--request-permission] [--protocol] [--version] [--help]\n"
      "Writes the Microsoft Teams app's audio alone to stdout as raw 16 kHz mono s16le PCM. Status codes go to stderr.\n";
  if (error) {
    DWORD written = 0;
    WriteFile(GetStdHandle(STD_ERROR_HANDLE), text, static_cast<DWORD>(std::strlen(text)), &written, nullptr);
  } else {
    Print(text);
  }
}

// Appends an ASCII wide string as a JSON string (escaping backslash and quote). Image names and the device name are ASCII.
void AppendJsonString(std::string& out, const wchar_t* text) {
  out += '"';
  for (; *text; ++text) {
    if (*text == L'\\' || *text == L'"') out += '\\';
    out += static_cast<char>(*text);
  }
  out += '"';
}

// --protocol: the protocol constants as one JSON object, so CI can compare them with core/teams-audio-protocol.ts.
// Never opens audio.
void PrintProtocol() {
  char head[512];
  std::snprintf(head, sizeof head,
                "{\"protocol\":%d,\"sampleRate\":%lu,"
                "\"exit\":{\"ok\":%d,\"usage\":%d,\"unsupported\":%d,\"denied\":%d,\"noTeams\":%d,\"failed\":%d},"
                "\"capture\":{\"activationTypeProcessLoopback\":%lu,\"loopbackIncludeTargetProcessTree\":%lu,"
                "\"processLoopbackDevice\":",
                kProtocol, static_cast<unsigned long>(kSampleRate), kExitOk, kExitUsage, kExitUnsupported, kExitDenied,
                kExitNoTeams, kExitFailed, static_cast<unsigned long>(kActivationTypeProcessLoopback),
                static_cast<unsigned long>(kLoopbackIncludeTargetProcessTree));
  std::string out = head;
  AppendJsonString(out, kProcessLoopbackDevice);
  out += "},\"teamsImages\":[";
  const int count = static_cast<int>(sizeof kTeamsImages / sizeof kTeamsImages[0]);
  for (int rank = 0; rank < count; ++rank) {
    if (rank > 0) out += ',';
    AppendJsonString(out, kTeamsImages[rank]);
  }
  out += "]}\n";
  Print(out.c_str());
}

int Capture(DWORD pid) {
  IAudioClient* client = nullptr;
  WAVEFORMATEX format = Format(kSampleRate, 1);
  HRESULT hr = OpenClient(pid, format, &client);
  if (hr == AUDCLNT_E_UNSUPPORTED_FORMAT || hr == E_INVALIDARG) {
    format = Format(kFallbackRate, kFallbackChannels);
    hr = OpenClient(pid, format, &client);
  }
  if (FAILED(hr)) return ExitForActivation(hr);

  HANDLE audio = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  IAudioCaptureClient* capture = nullptr;
  hr = client->SetEventHandle(audio);
  if (SUCCEEDED(hr)) hr = client->GetService(__uuidof(IAudioCaptureClient), reinterpret_cast<void**>(&capture));
  if (SUCCEEDED(hr)) hr = client->Start();
  if (FAILED(hr)) {
    if (capture) capture->Release();
    client->Release();
    CloseHandle(audio);
    Status("failed", hr);
    return kExitFailed;
  }

  Status("ready");
  HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
  HANDLE target = OpenProcess(SYNCHRONIZE, FALSE, pid);
  HANDLE waits[3] = {g_stop, audio, target};
  const DWORD waitCount = target ? 3 : 2;
  Converter converter(format.nSamplesPerSec, format.nChannels);
  std::vector<int16_t> pcm;
  ULONGLONG lastTreeCheck = GetTickCount64();
  int exitCode = kExitOk;

  for (;;) {
    const DWORD signalled = WaitForMultipleObjects(waitCount, waits, FALSE, 200);
    if (signalled == WAIT_OBJECT_0) {
      Status("stopped");
      break;
    }
    if (target && signalled == WAIT_OBJECT_0 + 2) {
      Status("no-teams");
      exitCode = kExitNoTeams;
      break;
    }
    bool closed = false;
    UINT32 packet = 0;
    while (SUCCEEDED(hr = capture->GetNextPacketSize(&packet)) && packet > 0) {
      BYTE* data = nullptr;
      UINT32 frames = 0;
      DWORD flags = 0;
      hr = capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
      if (FAILED(hr)) break;
      const bool silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0;
      converter.Push(silent ? nullptr : reinterpret_cast<const int16_t*>(data), frames, pcm);
      capture->ReleaseBuffer(frames);
      if (!pcm.empty()) {
        closed = !WriteAll(output, pcm.data(), pcm.size() * sizeof(int16_t));
        pcm.clear();
        if (closed) break;
      }
    }
    if (closed) {
      // Bee stopped reading: a clean stop.
      break;
    }
    if (FAILED(hr)) {
      Status("failed", hr);
      exitCode = kExitFailed;
      break;
    }
    if (GetTickCount64() - lastTreeCheck >= kTreeCheckMs) {
      lastTreeCheck = GetTickCount64();
      if (!TreeIsTeamsOnly(Processes(), pid)) {
        Status("failed", S_OK, "tree=not-teams");
        exitCode = kExitFailed;
        break;
      }
    }
  }

  client->Stop();
  capture->Release();
  client->Release();
  CloseHandle(audio);
  if (target) CloseHandle(target);
  return exitCode;
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  DWORD requested = 0;
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
      // Windows asks for no permission to hear one app.
      Status("granted");
      return kExitOk;
    }
    if (std::wcscmp(arg, L"--pid") == 0 && index + 1 < argc) {
      requested = static_cast<DWORD>(std::wcstoul(argv[++index], nullptr, 10));
      continue;
    }
    Usage(true);
    return kExitUsage;
  }

  if (WindowsBuild() < kMinBuild) {
    Status("unsupported");
    return kExitUnsupported;
  }

  const std::vector<Process> list = Processes();
  // An id from Bee must still be Teams: the helper never hears anything else.
  const DWORD pid = requested != 0 ? (IsTeamsPid(list, requested) ? requested : 0) : FindTeamsRoot(list);
  if (pid == 0) {
    Status("no-teams");
    return kExitNoTeams;
  }
  if (!TreeIsTeamsOnly(list, pid)) {
    Status("failed", S_OK, "tree=not-teams");
    return kExitFailed;
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
  const int code = Capture(pid);
  CoUninitialize();
  return code;
}
