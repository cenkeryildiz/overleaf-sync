FROM --platform=linux/arm64 ubuntu@sha256:c92376659a7f14cc1f51615d73c9f4b7d8e18d59f370e02b4ed683ab4485c66c AS builder
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends build-essential pkg-config libsdl2-dev libmupdf-dev libmujs-dev libfreetype6-dev libgumbo-dev libjbig2dec0-dev libjpeg-dev libopenjp2-7-dev libfontconfig1-dev libharfbuzz-dev libgraphite2-dev libicu-dev zlib1g-dev libssl-dev libleptonica-dev libtesseract-dev ca-certificates && rm -rf /var/lib/apt/lists/*
COPY . /src/texpresso
WORKDIR /src/texpresso
RUN make -j2 all
FROM --platform=linux/amd64 overleafcep-local/sharelatex-preamble:20261115
COPY --from=builder /usr/lib/aarch64-linux-gnu/ /usr/lib/aarch64-linux-gnu/
COPY --from=builder /lib/ld-linux-aarch64.so.1 /lib/ld-linux-aarch64.so.1
COPY --from=builder /src/texpresso/build/texpresso /src/texpresso/build/texpresso-xetex /opt/texpresso/bin/
COPY --from=builder /src/texpresso/LICENSE /usr/share/doc/texpresso/LICENSE
