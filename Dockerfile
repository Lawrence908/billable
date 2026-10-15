FROM nginx:alpine

ARG BUILD_TIME=unknown
# Cloudflare rewrites Cache-Control on .css/.js to a 4h browser TTL, so asset
# URLs carry a per-build version or a redeploy is invisible to open phones.
ARG BUILD_ID=0

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY src/ /usr/share/nginx/html/

RUN sed -i -e "s|__BUILD_TIME__|${BUILD_TIME}|g" -e "s|__BUILD_ID__|${BUILD_ID}|g" \
      /usr/share/nginx/html/index.html
