# ps5-link — headless PS5 Remote Play INPUT client, built on chiaki-ng's libchiaki.
#
#   Mac bridge ──"P lx ly rx ry l2 r2 hat btn" lines on stdin──► ps5-link ──Remote Play──► PS5
#
# Video and audio are disabled (chiaki drops those packets on arrival), so no
# window, no decoding — watch the game on the TV. Only chiaki's core library is
# built: no GUI, CLI, decoders, audio codecs or internet (RUDP) support.
cmake_minimum_required(VERSION 3.20)
project(ps5link C CXX)

set(CMAKE_C_STANDARD 11)

# Everything chiaki-ng can do that we don't need, off.
foreach(opt TESTS CLI GUI BOREALIS SETSU STEAMDECK_NATIVE FFMPEG_DECODER PI_DECODER SPEEX STEAM_SHORTCUT RUDP)
	set(CHIAKI_ENABLE_${opt} OFF CACHE STRING "" FORCE)
endforeach()
set(CHIAKI_LIB_ENABLE_OPUS OFF CACHE BOOL "" FORCE)
# Build json-c and miniupnpc from source instead of needing Homebrew packages.
set(CHIAKI_LIB_JSONC_EXTERNAL_PROJECT ON CACHE BOOL "" FORCE)
set(CHIAKI_LIB_MINIUPNPC_EXTERNAL_PROJECT ON CACHE BOOL "" FORCE)
# nanopb ships a protoc wrapper that runs on Python grpc_tools — no system protoc needed.
set(PROTOC "${CMAKE_CURRENT_SOURCE_DIR}/../third_party/chiaki-ng/third-party/nanopb/generator/protoc" CACHE FILEPATH "" FORCE)
# chiaki's lib uses pkg_search_module for libevent without loading PkgConfig
# when both external-project options are on; load it here first.
find_package(PkgConfig REQUIRED)

add_subdirectory(../third_party/chiaki-ng chiaki-ng EXCLUDE_FROM_ALL)

add_executable(ps5-link src/main.c)
target_link_libraries(ps5-link chiaki-lib)
