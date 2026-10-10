FROM dxflrs/garage:v2.4.1@sha256:9c96caa2612d3411acc5b0e6701fb238dbfba33e533a6d7d3d811a4b12d0d020

# Build with deploy/novart/storage as the context. This file contains no secrets;
# the independent RPC/admin tokens are supplied only at container runtime.
COPY garage.toml /etc/garage.toml
ARG COMMIT_SHA
LABEL org.opencontainers.image.revision="${COMMIT_SHA}"
HEALTHCHECK --interval=5s --timeout=5s --start-period=20s --retries=12 CMD ["/garage", "-c", "/etc/garage.toml", "health", "--quiet"]
EXPOSE 3900
CMD ["/garage", "-c", "/etc/garage.toml", "server", "--single-node"]
