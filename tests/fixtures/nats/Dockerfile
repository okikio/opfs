# Test-only official native C SDK; signed Debian package/source identities are retained per build.
FROM node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68
ENV DEBIAN_FRONTEND=noninteractive
RUN printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d && chmod 755 /usr/sbin/policy-rc.d \
    && mkdir -p /oracle/receipts/licenses \
    && dpkg-query -W > /oracle/receipts/packages-before.txt \
    && timeout 120 apt-get -o Acquire::Retries=0 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 update \
    && timeout 120 apt-get -o Acquire::Retries=0 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 install -y --no-install-recommends --download-only g++ libnats-dev \
    && find /var/cache/apt/archives -maxdepth 1 -type f -name '*.deb' -printf '%s\n' | awk '{n++;total+=$1;if($1>67108864)exit 1} END{if(n<1||n>256||total>268435456)exit 1}' \
    && sha256sum /var/cache/apt/archives/*.deb > /oracle/receipts/debs.sha256 \
    && timeout 120 apt-get --no-download install -y --no-install-recommends g++ libnats-dev \
    && dpkg-query -W '-f=${binary:Package}\t${Version}\t${source:Package}\t${source:Version}\t${Architecture}\n' > /oracle/receipts/packages.txt \
    && cp /etc/os-release /oracle/receipts/os-release \
    && cp -a /etc/apt/sources.list.d /oracle/receipts/apt-sources \
    && cp /var/lib/apt/lists/*InRelease /oracle/receipts/ \
    && for p in /usr/share/doc/*/copyright; do cp "$p" "/oracle/receipts/licenses/$(basename "$(dirname "$p")").copyright"; done \
    && cp -a /usr/share/common-licenses /oracle/receipts/licenses/common \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb
COPY oracle.cpp /oracle/oracle.cpp
RUN timeout 45 g++ -std=c++17 -O2 -Wall -Wextra -Werror /oracle/oracle.cpp -lnats -o /oracle/oracle \
    && sha256sum /oracle/oracle.cpp /oracle/oracle /usr/include/nats/nats.h > /oracle/receipts/artifacts.sha256 \
    && g++ --version > /oracle/receipts/compiler.txt \
    && chmod 777 /oracle
USER 65534:65534
CMD ["sleep", "600"]
