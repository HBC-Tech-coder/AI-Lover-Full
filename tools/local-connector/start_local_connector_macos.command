#!/bin/zsh
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/../.."

if [ -z "$AI_LOVER_PAIRING_CODE" ]; then
  printf "Enter pairing code from web page: "
  read AI_LOVER_PAIRING_CODE
fi

if [ -z "$AI_LOVER_DEVICE_BRIDGE_URL" ]; then
  AI_LOVER_DEVICE_BRIDGE_URL="wss://ai.vituralmodel.com/device-bridge"
fi

if [ -z "$AI_LOVER_DEVICE_NAME" ]; then
  AI_LOVER_DEVICE_NAME="$(hostname) Local Connector"
fi

NODE_EXE="node"
if [ -x "runtime/nodejs/bin/node" ]; then
  NODE_EXE="runtime/nodejs/bin/node"
fi

echo "AI-Lover Local Connector"
echo "Pairing code: $AI_LOVER_PAIRING_CODE"
echo "Cloud bridge: $AI_LOVER_DEVICE_BRIDGE_URL"
echo "Node: $NODE_EXE"
echo

"$NODE_EXE" tools/local-connector/ai-lover-local-connector.js \
  --bridge "$AI_LOVER_DEVICE_BRIDGE_URL" \
  --code "$AI_LOVER_PAIRING_CODE" \
  --name "$AI_LOVER_DEVICE_NAME"
