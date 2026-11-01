#!/bin/sh
set -e
cd "$(dirname "$0")/src"
rm -f ../mic-drop.xpi
zip -q -r -X ../mic-drop.xpi . -x '*.map' -x '.*'
echo "Built $(cd .. && pwd)/mic-drop.xpi"
