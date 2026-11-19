#!/bin/sh
set -eu
exec "$CLOUDFLARED" tunnel --no-autoupdate run --token-file "$TUNNEL_TOKEN_FILE"
