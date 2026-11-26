FROM node:24.22.3-bookworm-slim

ARG MIHOMO_GZ_SHA256=0c07340a01408d033dda4088ea2a4c1e4d82aeed7b2f84f7c046e93b6ff3290c

COPY bin/mihomo-linux-amd64-v1-v1.19.34.gz /tmp/mihomo.gz

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && echo "$MIHOMO_GZ_SHA256  /tmp/mihomo.gz" | sha256sum -c - \
    && gunzip /tmp/mihomo.gz \
    && install -m 0755 /tmp/mihomo /usr/local/bin/mihomo \
    && rm -f /tmp/mihomo

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY config ./config

RUN mkdir -p /app/data

ENV NODE_ENV=production \
    GNS_HOST=0.0.0.0 \
    GNS_PORT=8089 \
    MIHOMO_BIN=/usr/local/bin/mihomo

EXPOSE 8089

CMD ["node", "src/main.mjs"]
