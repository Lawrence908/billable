FROM nginx:alpine

ARG BUILD_TIME=unknown
# Cloudflare rewrites Cache-Control on .css/.js to a 4 h browser TTL, so every
# asset URL carries a per-build version or a redeploy is invisible to open
# phones. That includes the imports between modules, rewritten below.
ARG BUILD_ID=0
# Encrypted sync is off unless a build asks for it. Off means the sync code,
# its UI and the /api/ route are removed from the image, and the page's
# Content Security Policy forbids all connections.
ARG ENABLE_SYNC=false

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY src/ /usr/share/nginx/html/

RUN set -eu; \
    html=/usr/share/nginx/html; conf=/etc/nginx/conf.d/default.conf; \
    if [ "$ENABLE_SYNC" = "true" ]; then \
      keep=sync; drop=nosync; connect="'self'"; \
      sed -i 's/SYNC_ENABLED = false/SYNC_ENABLED = true/' "$html/js/config.js"; \
    else \
      keep=nosync; drop=sync; connect="'none'"; \
      rm -f "$html/js/sync-ui.js" "$html/js/sync.js" "$html/js/crypto.js" "$html/js/words.js"; \
      sed -i '/sync-only/d' "$html/sw.js"; \
    fi; \
    sed -i -e "/<!-- $drop:start -->/,/<!-- $drop:end -->/d" -e "/<!-- $keep:\(start\|end\) -->/d" "$html/index.html"; \
    sed -i -e "/# $drop:start/,/# $drop:end/d" -e "/# $keep:\(start\|end\)/d" -e "s/__CONNECT_SRC__/$connect/" "$conf"; \
    sed -i -e "s/__CONNECT_SRC__/$connect/" -e "s|__BUILD_TIME__|${BUILD_TIME}|g" -e "s|__BUILD_ID__|${BUILD_ID}|g" "$html/index.html"; \
    sed -i "s|__BUILD_ID__|${BUILD_ID}|g" "$html/sw.js"; \
    sed -i -E "s#(from \"\./[a-z-]+\.js)\"#\1?v=${BUILD_ID}\"#g" "$html"/js/*.js; \
    nginx -t
