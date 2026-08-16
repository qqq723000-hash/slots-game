# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

ARG NODE_IMAGE=node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.30.4-alpine3.24-slim@sha256:e88d990b349df8cf4aa82f16642d7a23375016638c9ace4e5c6ca25028e62e65

FROM ${NODE_IMAGE} AS dependencies
WORKDIR /src/web

COPY web/package.json web/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts

FROM dependencies AS static-conformance-build
COPY web/ ./
RUN --network=none npm run build

FROM dependencies AS release-config-build
ARG VITE_RGS_BASE_URL
ARG VITE_RGS_BET_OPTIONS_MINOR
ARG VITE_RGS_DEFAULT_BET_MINOR
ARG VITE_RGS_HOST_ORIGIN
ARG WEB_RELEASE_VERSION
ARG WEB_RELEASE_REVISION
COPY web/ ./
# 生产响应头与 Vite 必须消费同一组公开 origin；不得另设默认值或把 launch code 传入 ARG。
COPY deploy/web/nginx.conf deploy/web/render-release-nginx.mjs /src/release-web/
RUN --network=none \
    node ./src/validateReleaseRgsBuildConfig.mjs && \
    node /src/release-web/render-release-nginx.mjs \
      --input /src/release-web/nginx.conf \
      --output /src/web/release-nginx.conf \
      --rgs-base-url "$VITE_RGS_BASE_URL" \
      --host-origin "$VITE_RGS_HOST_ORIGIN" && \
    WEB_RELEASE_REQUIRE_IDENTITY=1 \
    WEB_RELEASE_VERSION="$WEB_RELEASE_VERSION" \
    WEB_RELEASE_REVISION="$WEB_RELEASE_REVISION" \
      npm run build && \
    test -s /src/web/dist/index.html && \
    test -s /src/web/dist/release-manifest.json

FROM release-config-build AS release-build
# 真实 runtime 只能在同一构建产物通过外部精确素材授权后继续；CI 配置门禁不得进入本层。
RUN --network=none \
    --mount=type=secret,id=release_asset_approval,required=true,target=/run/secrets/release_asset_approval \
    RELEASE_ASSET_APPROVAL_FILE=/run/secrets/release_asset_approval \
      node ./scripts/verify-release-asset-approval.mjs

FROM ${NGINX_IMAGE} AS config-conformance-nginx
# 只解析与 release 同源生成的 Nginx 配置；禁止复制 dist，避免该层成为可发布网页镜像。
COPY --from=release-config-build --chown=101:101 /src/web/release-nginx.conf /etc/nginx/conf.d/default.conf
RUN --network=none nginx -t

FROM scratch AS config-conformance
LABEL org.opencontainers.image.title="CI_ONLY_NOT_RELEASE_EVIDENCE" \
      org.opencontainers.image.description="CI-only RGS build and Nginx configuration conformance; contains no web release"
# 最终目标只有已通过 nginx -t 的配置文本，不含 Nginx、dist、素材或授权文件，不能部署运行。
COPY --from=config-conformance-nginx /etc/nginx/conf.d/default.conf /ci-only-not-release-evidence/release-nginx.conf
USER 65534:65534
CMD ["/ci-only-not-release-evidence/release-nginx.conf"]

FROM ${NGINX_IMAGE} AS static-conformance
LABEL org.opencontainers.image.title="CI_ONLY_STATIC_CONFORMANCE" \
      org.opencontainers.image.description="CI-only unprivileged static image; not an approved release"
COPY --chown=0:0 deploy/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=static-conformance-build --chown=0:0 /src/web/dist/ /usr/share/nginx/html/

# 最终进程不能替换 CSP 配置或网页字节；集群只读根文件系统是独立的第二层保护。
USER 0:0
RUN --network=none \
    chown 0:0 /etc/nginx/conf.d /usr/share/nginx/html && \
    chmod -R a-w /etc/nginx/conf.d /usr/share/nginx/html

EXPOSE 8080
USER 101:101

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD ["wget", "-q", "-T", "2", "-O", "/dev/null", "http://127.0.0.1:8080/readyz"]

FROM ${NGINX_IMAGE} AS runtime
ARG WEB_RELEASE_VERSION
ARG WEB_RELEASE_REVISION
# 生产目标只复制 release-build 生成的精确策略；CI 静态镜像不得作为发布替代品。
COPY --from=release-build --chown=0:0 /src/web/release-nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=release-build --chown=0:0 /src/web/dist/ /usr/share/nginx/html/

USER 0:0
RUN --network=none \
    chown 0:0 /etc/nginx/conf.d /usr/share/nginx/html && \
    chmod -R a-w /etc/nginx/conf.d /usr/share/nginx/html
USER 101:101
RUN --network=none nginx -t

# 标签只暴露已通过发布清单严格校验的公开版本与完整提交摘要，不写入构建时间或宿主信息。
LABEL org.opencontainers.image.title="iron-colossus-web" \
      org.opencontainers.image.version="${WEB_RELEASE_VERSION}" \
      org.opencontainers.image.revision="${WEB_RELEASE_REVISION}"

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD ["wget", "-q", "-T", "2", "-O", "/dev/null", "http://127.0.0.1:8080/readyz"]
