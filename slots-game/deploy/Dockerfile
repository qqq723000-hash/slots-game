# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

# 生产构建只能使用发布流水线审核并按摘要固定的镜像。
# English: artifactsion builds can only use images that have been reviewed by the release pipeline and pinned by
# digest.
ARG GO_IMAGE=golang:1.26.6-bookworm@sha256:116d58cbd88c1297624acc6e967a060012422bacf9930927e23fb719189c6f36
ARG RUNTIME_IMAGE=gcr.io/distroless/static-debian12:nonroot@sha256:1b7b9f0f0e0a1d2155f531db587cc48ec26aaf97ab64364225f5bf18a054e66a

FROM ${GO_IMAGE} AS build
WORKDIR /src/server

COPY server/go.mod server/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go mod download

COPY server/ ./
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    --network=none \
    go run ./scripts/third-party-notices --check && \
    CGO_ENABLED=0 GOOS=linux go build -trimpath -buildvcs=false -ldflags='-s -w' \
      -o /out/rgs-server ./cmd/rgs-server && \
    CGO_ENABLED=0 GOOS=linux go build -trimpath -buildvcs=false -ldflags='-s -w' \
      -o /out/rgs-migrator ./cmd/rgs-migrator

FROM ${RUNTIME_IMAGE} AS migrator
WORKDIR /
COPY --from=build --chown=nonroot:nonroot /out/rgs-migrator /rgs-migrator
COPY --from=build --chown=nonroot:nonroot /src/server/THIRD_PARTY_NOTICES.txt /THIRD_PARTY_NOTICES.txt

USER nonroot:nonroot
ENTRYPOINT ["/rgs-migrator"]

FROM ${RUNTIME_IMAGE} AS runtime
WORKDIR /
COPY --from=build --chown=nonroot:nonroot /out/rgs-server /rgs-server
COPY --from=build --chown=nonroot:nonroot /src/server/THIRD_PARTY_NOTICES.txt /THIRD_PARTY_NOTICES.txt

# 此处仅声明 OCI 元数据：8081 是私有运维监听端口，严禁通过公网入口或服务负载均衡器发布。
# English: Only OCI metadata is declared here: 8081 is a private operations listening port, and it is strictly
# prohibited to publish it through the public entrance or service load balancer.
EXPOSE 8080 8081
USER nonroot:nonroot
ENTRYPOINT ["/rgs-server"]
