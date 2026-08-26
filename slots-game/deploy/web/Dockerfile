# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

ARG NODE_IMAGE=node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.30.4-alpine3.24-slim@sha256:bcf91d2c73ab64fa1c4ac7fbac5ac523057c8af7d553ab9251c7aef38c260979

# 上游 Nginx 镜像尚未包含 Alpine 对 CVE-2026-14456 的 OpenSSL 修复。补丁 APK 来自
# Alpine v3.24 官方稳定仓库，按架构分别绑定内容摘要；最终层仅通过只读 mount 安装，
# 不把下载包留在运行镜像中，也不允许 apk 在构建时访问网络。
FROM scratch AS openssl-patches
ADD --checksum=sha256:161223a16f042b8e469e9441291e071464fd91d4f4bbe6f496ee8d0abd4e0701 https://dl-cdn.alpinelinux.org/alpine/v3.24/main/x86_64/libcrypto3-3.5.8-r0.apk /x86_64/libcrypto3.apk
ADD --checksum=sha256:aca521e5ae4a321322a9d47ed64a1775f5ab1ffd215d1e9fc0433c58f7bfd037 https://dl-cdn.alpinelinux.org/alpine/v3.24/main/x86_64/libssl3-3.5.8-r0.apk /x86_64/libssl3.apk
ADD --checksum=sha256:35b892813c23664a3592e4fc8c12a03538a22c579057655361c7043305272a9a https://dl-cdn.alpinelinux.org/alpine/v3.24/main/aarch64/libcrypto3-3.5.8-r0.apk /aarch64/libcrypto3.apk
ADD --checksum=sha256:d6ec970cc10e01539e41626f720c4e0ac69016eaa2079a10ef776ffd3243db5b https://dl-cdn.alpinelinux.org/alpine/v3.24/main/aarch64/libssl3-3.5.8-r0.apk /aarch64/libssl3.apk

FROM ${NODE_IMAGE} AS dependencies
WORKDIR /src/web

COPY web/package.json web/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts

FROM dependencies AS static-conformance-build
COPY web/ ./
RUN --network=none npm run build
RUN --network=none \
    test -s /src/web/dist/THIRD_PARTY_NOTICES.txt && \
    cmp /src/web/public/THIRD_PARTY_NOTICES.txt /src/web/dist/THIRD_PARTY_NOTICES.txt

FROM dependencies AS release-config-build
ARG VITE_RGS_BASE_URL
ARG VITE_RGS_BET_OPTIONS_MINOR
ARG VITE_RGS_DEFAULT_BET_MINOR
ARG VITE_RGS_HOST_ORIGIN
ARG WEB_RELEASE_VERSION
ARG WEB_RELEASE_REVISION
COPY web/ ./
# 生产响应头与 Vite 必须消费同一组公开 origin；不得另设默认值或把 launch code 传入 ARG。
COPY deploy/web/nginx.conf deploy/web/content-security-policy.mjs deploy/web/render-release-nginx.mjs /src/release-web/
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
    test -s /src/web/dist/release-manifest.json && \
    test -s /src/web/dist/THIRD_PARTY_NOTICES.txt && \
    cmp /src/web/public/THIRD_PARTY_NOTICES.txt /src/web/dist/THIRD_PARTY_NOTICES.txt

FROM release-config-build AS release-build
# 真实 runtime 只能在同一构建产物通过外部精确素材授权后继续；CI 配置门禁不得进入本层。
RUN --network=none \
    --mount=type=secret,id=release_asset_approval,required=true,target=/run/secrets/release_asset_approval \
    RELEASE_ASSET_APPROVAL_FILE=/run/secrets/release_asset_approval \
      node ./scripts/verify-release-asset-approval.mjs

FROM ${NGINX_IMAGE} AS config-conformance-nginx
USER 0:0
RUN --network=none \
    --mount=type=bind,from=openssl-patches,source=/,target=/patches,readonly \
    openssl_patch_arch=$(apk --print-arch) && \
    case "$openssl_patch_arch" in x86_64|aarch64) ;; *) exit 1 ;; esac && \
    apk add --no-network --no-cache --repositories-file /dev/null "/patches/$openssl_patch_arch/libcrypto3.apk" "/patches/$openssl_patch_arch/libssl3.apk" && \
    apk info -e 'libcrypto3=3.5.8-r0' >/dev/null && \
    apk info -e 'libssl3=3.5.8-r0' >/dev/null
USER 101:101
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
USER 0:0
RUN --network=none \
    --mount=type=bind,from=openssl-patches,source=/,target=/patches,readonly \
    openssl_patch_arch=$(apk --print-arch) && \
    case "$openssl_patch_arch" in x86_64|aarch64) ;; *) exit 1 ;; esac && \
    apk add --no-network --no-cache --repositories-file /dev/null "/patches/$openssl_patch_arch/libcrypto3.apk" "/patches/$openssl_patch_arch/libssl3.apk" && \
    apk info -e 'libcrypto3=3.5.8-r0' >/dev/null && \
    apk info -e 'libssl3=3.5.8-r0' >/dev/null
USER 101:101
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
USER 0:0
RUN --network=none \
    --mount=type=bind,from=openssl-patches,source=/,target=/patches,readonly \
    openssl_patch_arch=$(apk --print-arch) && \
    case "$openssl_patch_arch" in x86_64|aarch64) ;; *) exit 1 ;; esac && \
    apk add --no-network --no-cache --repositories-file /dev/null "/patches/$openssl_patch_arch/libcrypto3.apk" "/patches/$openssl_patch_arch/libssl3.apk" && \
    apk info -e 'libcrypto3=3.5.8-r0' >/dev/null && \
    apk info -e 'libssl3=3.5.8-r0' >/dev/null
USER 101:101
ARG WEB_RELEASE_VERSION
ARG WEB_RELEASE_REVISION
# 生产目标只复制 release-build 生成的精确策略；CI 静态镜像不得作为发布替代品。
COPY --from=release-build --chown=0:0 /src/web/release-nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=release-build --chown=0:0 /src/web/dist/ /usr/share/nginx/html/
COPY --from=release-build --chown=0:0 /src/web/dist/THIRD_PARTY_NOTICES.txt /THIRD_PARTY_NOTICES.txt

USER 0:0
RUN --network=none \
    chown 0:0 /etc/nginx/conf.d /usr/share/nginx/html && \
    chmod -R a-w /etc/nginx/conf.d /usr/share/nginx/html && \
    chmod a-w /THIRD_PARTY_NOTICES.txt
RUN --network=none \
    test -s /THIRD_PARTY_NOTICES.txt && \
    cmp /THIRD_PARTY_NOTICES.txt /usr/share/nginx/html/THIRD_PARTY_NOTICES.txt
USER 101:101
RUN --network=none nginx -t

# 标签只暴露已通过发布清单严格校验的公开版本与完整提交摘要，不写入构建时间或宿主信息。
LABEL org.opencontainers.image.title="iron-colossus-web" \
      org.opencontainers.image.version="${WEB_RELEASE_VERSION}" \
      org.opencontainers.image.revision="${WEB_RELEASE_REVISION}"

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD ["wget", "-q", "-T", "2", "-O", "/dev/null", "http://127.0.0.1:8080/readyz"]
