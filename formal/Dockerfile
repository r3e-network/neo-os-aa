# Pinned, self-contained environment for the AA formal gate (formal/verify.py).
#
# Ubuntu 24.04 is the same base the CI runner uses, so a reviewer and CI see the
# same Coq 8.18, Z3 4.8 and OpenJDK 21 packages. The TLA+ tools jar is fetched from
# the tlaplus release page and verified against a pinned SHA-256: the "v1.8.0"
# asset is republished over time, so the hash, not the URL, is the pin. A hash
# mismatch fails the build; nothing in this image substitutes a simulated result
# for a missing or altered tool.
#
# Build and run through formal/verify-in-docker.sh, or directly:
#   docker build -f formal/Dockerfile -t neo-os-aa-formal formal
#   docker run --rm -v "$PWD:/work" -w /work -e HOME=/tmp neo-os-aa-formal
FROM ubuntu:24.04

ARG TLA_JAR_URL=https://github.com/tlaplus/tlaplus/releases/download/v1.8.0/tla2tools.jar
ARG TLA_JAR_SHA256=9d36716ffb5e49d1ba8fae4651eba59f3189887e12eb90e204a42d2e6e993fef

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl coq z3 default-jre-headless python3 \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL -o /opt/tla2tools.jar "$TLA_JAR_URL" \
    && echo "$TLA_JAR_SHA256  /opt/tla2tools.jar" | sha256sum -c -

ENV TLA_JAR=/opt/tla2tools.jar \
    COQC=coqc \
    Z3=z3 \
    JAVA_BIN=/usr/bin/java

WORKDIR /work
ENTRYPOINT ["python3", "formal/verify.py"]
