#!/bin/bash
# ============================================================
# ReadAloud - One-time installation
# Auto-detects extension ID from Chrome, zero manual input
# ============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_NAME="com.readaloud.tts"
NM_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"

# Find python3 that has edge-tts installed
PYTHON_PATH=$(python3 -c "import sys; print(sys.executable)" 2>/dev/null)

echo "=== ReadAloud Setup ==="
echo ""

# ---- 1. Install edge-tts ----

echo "[1/3] Checking edge-tts..."
if python3 -c "import edge_tts" 2>/dev/null; then
  echo "  OK (python: $PYTHON_PATH)"
else
  echo "  Installing..."
  pip3 install edge-tts
  echo "  Done"
fi

# Fix shebang to use the correct python3
sed -i '' "1s|.*|#!$PYTHON_PATH|" "$SCRIPT_DIR/native_host.py"
echo "  Shebang set to: $PYTHON_PATH"

# ---- 2. Find extension ID (auto) ----

echo ""
echo "[2/3] Looking for ReadAloud extension in Chrome..."

DETECT_SCRIPT="
import json, os, glob
chrome = os.path.expanduser('~/Library/Application Support/Google/Chrome')
target = '$SCRIPT_DIR'
for pref_path in glob.glob(f'{chrome}/*/Secure Preferences') + glob.glob(f'{chrome}/*/Preferences'):
    try:
        with open(pref_path) as f:
            data = json.load(f)
        for eid, ed in data.get('extensions',{}).get('settings',{}).items():
            path = ed.get('path','')
            name = ed.get('manifest',{}).get('name','')
            if name == 'ReadAloud' or (path and os.path.exists(path) and os.path.samefile(path, target)):
                print(eid)
                exit()
    except:
        pass
"

while true; do
  EXT_ID=$(python3 -c "$DETECT_SCRIPT" 2>/dev/null)
  if [ -n "$EXT_ID" ]; then
    echo "  Found: $EXT_ID"
    break
  fi
  echo "  Extension not loaded yet."
  echo ""
  echo "  Please do this in Chrome:"
  echo "    1. Open chrome://extensions"
  echo "    2. Turn on Developer Mode (top right)"
  echo "    3. Click 'Load unpacked'"
  echo "    4. Select: $SCRIPT_DIR"
  echo ""
  echo "  Press Enter when done (or Ctrl+C to cancel)..."
  read
done

# ---- 3. Write manifest ----

echo ""
echo "[3/3] Registering native messaging host..."

mkdir -p "$NM_DIR"
cat > "$NM_DIR/${HOST_NAME}.json" << EOF
{
  "name": "$HOST_NAME",
  "description": "ReadAloud Edge TTS Native Host",
  "path": "$SCRIPT_DIR/native_host.py",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF

echo "  Done"
echo ""
echo "=== All set! ==="
echo "Go to chrome://extensions → reload ReadAloud → popup should say 'Edge TTS connected'"
echo "Alt+R = read  |  Alt+S = stop  |  Right-click = Read Aloud"
