#!/usr/bin/env bash
# Rebuild doc/figure-styles.html (a self-contained page: the preview
# script from src/avatar/preview.js is bundled into it).
set -euo pipefail
cd "$(dirname "$0")/.."
JS=$(npx esbuild src/avatar/preview.js --bundle --format=iife --minify)
python3 - "$JS" <<'PY'
import sys
tpl = open('doc/figure-styles.tpl.html').read()
open('doc/figure-styles.html', 'w').write(tpl.replace('/*PREVIEW_JS*/', sys.argv[1]))
PY
echo "wrote doc/figure-styles.html"
