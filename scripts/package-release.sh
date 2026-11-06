#!/bin/sh
# Archive tracked sources, without a remote, .git, local config, data or node_modules.
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
revision=${1:-HEAD}
commit=$(git rev-parse --verify "$revision^{commit}")
mkdir -p artifacts
target="artifacts/razem-$commit.tar.gz"
git archive --format=tar.gz --prefix=razem/ "$commit" > "$target.tmp"
mv "$target.tmp" "$target"
sha256sum "$target" > "$target.sha256"
echo "$target"
