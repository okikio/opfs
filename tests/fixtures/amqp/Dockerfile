# Official Node26 bookworm index used by the other native provider fixtures.
FROM node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68
ENV DEBIAN_FRONTEND=noninteractive
# Only inherited signed Debian sources supply the independent client and compiler.
RUN mkdir -p /oracle/receipts \
    && apt-get update \
    && apt-get install -y --no-install-recommends --download-only gcc libc6-dev librabbitmq-dev util-linux \
    && sha256sum /var/cache/apt/archives/*.deb > /oracle/receipts/debs.sha256 \
    && apt-get install -y --no-install-recommends gcc libc6-dev librabbitmq-dev util-linux \
    && dpkg-query -W > /oracle/receipts/packages.txt \
    && cp /etc/os-release /oracle/receipts/os-release \
    && cp -a /etc/apt/sources.list.d /oracle/receipts/apt-sources \
    && cp /var/lib/apt/lists/*InRelease /oracle/receipts/ \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb
COPY native.c client.ts /oracle/
RUN cc -std=c11 -D_POSIX_C_SOURCE=200809L -O2 -Wall -Wextra /oracle/native.c -lrabbitmq -o /oracle/native \
    && chmod 755 /oracle /oracle/native
USER 65534:65534
CMD ["node", "/oracle/client.ts"]
