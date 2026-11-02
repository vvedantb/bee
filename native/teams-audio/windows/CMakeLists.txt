# Bee Teams audio helper for Windows (WASAPI process loopback). Built by scripts/build-teams-audio-windows.ps1 with the
# Visual Studio toolchain on windows-latest. No third-party code.
cmake_minimum_required(VERSION 3.20)
project(teams_audio_helper LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
# Static CRT: no Visual C++ redistributable needed on the user's machine.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

add_executable(teams-audio-helper teams-audio-helper.cpp)
target_compile_definitions(teams-audio-helper PRIVATE UNICODE _UNICODE _WIN32_WINNT=0x0A00 WIN32_LEAN_AND_MEAN NOMINMAX)
target_link_libraries(teams-audio-helper PRIVATE ole32)
if(MSVC)
  target_compile_options(teams-audio-helper PRIVATE /W4 /permissive- /utf-8)
  # A console program with wmain.
  set_target_properties(teams-audio-helper PROPERTIES LINK_FLAGS "/SUBSYSTEM:CONSOLE")
else()
  # MinGW, for a smoke build off Windows: g++ needs -municode for wmain.
  target_compile_options(teams-audio-helper PRIVATE -Wall -Wextra)
  target_link_options(teams-audio-helper PRIVATE -municode -static)
endif()
