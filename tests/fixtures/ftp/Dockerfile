# Official Node26 index already reviewed for the repository's provider fixtures.
FROM node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68
ENV DEBIAN_FRONTEND=noninteractive
# Only inherited signed Debian sources acquire the native protocol/TLS/client tools.
# Keep exact downloaded package digests and installed versions for each actual build.
RUN printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d && chmod 755 /usr/sbin/policy-rc.d \
    && mkdir -p /fixture/receipts \
    && apt-get update \
    && apt-get install -y --no-install-recommends --download-only proftpd-core proftpd-mod-crypto openssl curl \
    && sha256sum /var/cache/apt/archives/*.deb > /fixture/receipts/debs.sha256 \
    && apt-get install -y --no-install-recommends proftpd-core proftpd-mod-crypto openssl curl \
    && dpkg-query -W > /fixture/receipts/packages.txt \
    && cp /etc/os-release /fixture/receipts/os-release \
    && cp -a /etc/apt/sources.list.d /fixture/receipts/apt-sources \
    && cp /var/lib/apt/lists/*InRelease /fixture/receipts/ \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb
COPY server.ts client.ts /fixture/
USER 65534:65534
EXPOSE 2121 30000
CMD ["node", "/fixture/server.ts"]
