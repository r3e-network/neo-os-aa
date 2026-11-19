#!/usr/bin/env bash

# Resolve the runtime root for framework-dependent .NET tools. Homebrew's
# `dotnet` launcher sets DOTNET_ROOT only for the SDK process, so tools invoked
# directly from ~/.dotnet/tools otherwise cannot locate the installed runtime.
if [[ -z "${DOTNET_ROOT:-}" ]]; then
  runtime_path="$(dotnet --list-runtimes 2>/dev/null | awk -F'[][]' 'NR == 1 { print $2 }')"
  if [[ -n "$runtime_path" ]]; then
    # Linux prints /usr/local/share/dotnet/shared/<framework>, Windows prints
    # C:\Program Files\dotnet\shared\<framework>; strip the shared part with either separator.
    runtime_path="${runtime_path%%[/\\]shared[/\\]*}"
    export DOTNET_ROOT="$runtime_path"
  fi
fi

if [[ -z "${DOTNET_ROOT:-}" || ! -d "$DOTNET_ROOT" ]]; then
  echo "Unable to resolve DOTNET_ROOT from the installed dotnet runtime." >&2
  return 1 2>/dev/null || exit 1
fi

if [[ -z "${NCCS_BIN:-}" ]]; then
  # Resolve the pinned compiler the way the platform installs it: the global tool
  # launcher is `nccs` on macOS and Linux and `nccs.exe` on Windows, and it is
  # only on PATH when the tools directory was added to it. An MSYS shell resolves
  # `nccs` to `nccs.exe` for exec and for [ -f ] but reports the extension-less
  # name, and callers hash the launcher bytes, so prefer a name that exists as a
  # file on disk.
  for resolved in "$(command -v nccs 2>/dev/null || true)" "$HOME/.dotnet/tools/nccs"; do
    if [[ -n "$resolved" && -f "$resolved.exe" ]]; then
      NCCS_BIN="$resolved.exe"
      break
    fi
    if [[ -n "$resolved" && -f "$resolved" ]]; then
      NCCS_BIN="$resolved"
      break
    fi
  done
fi
export NCCS_BIN="${NCCS_BIN:-$HOME/.dotnet/tools/nccs}"
if [[ ! -x "$NCCS_BIN" ]]; then
  echo "Neo compiler not found or not executable: $NCCS_BIN" >&2
  return 1 2>/dev/null || exit 1
fi
