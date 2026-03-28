#!/usr/bin/env bash
# Restart the YT Live Chat server
"$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/start.sh" restart
