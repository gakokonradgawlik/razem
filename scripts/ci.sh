#!/bin/sh
set -eu
# Browser binaries/dependencies: npx playwright install --with-deps chromium webkit
npm ci
npm run ci
