#!/usr/bin/env bash
# Stop the YT Live Chat server
"$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/start.sh" stop
