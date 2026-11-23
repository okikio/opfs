# Reviewed official Node26 Debian Bookworm base; acquisition uses its signed APT repositories.
FROM node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68
ENV DEBIAN_FRONTEND=noninteractive
# Signed inherited Debian repositories, with exact package and repository receipts per build.
RUN printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d && chmod 755 /usr/sbin/policy-rc.d \
    && mkdir -p /oracle/receipts \
    && apt-get update \
    && apt-get install -y --no-install-recommends --download-only gcc libc6-dev libmemcached-dev \
    && sha256sum /var/cache/apt/archives/*.deb > /oracle/receipts/debs.sha256 \
    && apt-get install -y --no-install-recommends gcc libc6-dev libmemcached-dev \
    && dpkg-query -W > /oracle/receipts/packages.txt \
    && cp /etc/os-release /oracle/receipts/os-release \
    && cp -a /etc/apt/sources.list.d /oracle/receipts/apt-sources \
    && cp /var/lib/apt/lists/*InRelease /oracle/receipts/ \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb
COPY oracle.c /oracle/oracle.c
RUN timeout 45 gcc -std=c11 -O2 -Wall -Wextra -Werror /oracle/oracle.c -lmemcached -o /oracle/oracle \
    && sha256sum /oracle/oracle.c /oracle/oracle > /oracle/receipts/artifacts.sha256 \
    && gcc --version > /oracle/receipts/compiler.txt \
    && chmod 777 /oracle
USER 65534:65534
CMD ["sleep", "600"]
