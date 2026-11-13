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

export NCCS_BIN="${NCCS_BIN:-$HOME/.dotnet/tools/nccs}"
if [[ ! -x "$NCCS_BIN" ]]; then
  echo "Neo compiler not found or not executable: $NCCS_BIN" >&2
  return 1 2>/dev/null || exit 1
fi
