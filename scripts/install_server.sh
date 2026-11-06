#!/bin/sh
set -eu
command -v python3 >/dev/null 2>&1 || { echo 'Razem: wymagany python3 (Ubuntu).' >&2; exit 1; }
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec python3 "$script_dir/install_server.py" "$@"
