ARG BASE_RUNTIME=naklios-native-base:20261006
FROM ${BASE_RUNTIME}
USER root
RUN apt-get update && apt-get install -y --no-install-recommends libnss3-tools && rm -rf /var/lib/apt/lists/*
COPY entry.mjs /opt/naklios-runtime/entry.mjs
USER 65532:65532
ENV CHROME_BIN=/usr/bin/chromium HOME=/tmp/home TMPDIR=/tmp
ENTRYPOINT ["/usr/local/bin/node", "/opt/naklios-runtime/entry.mjs"]
