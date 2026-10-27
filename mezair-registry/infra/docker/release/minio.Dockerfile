# syntax=docker/dockerfile:1
# Official Community sources are archived; build the final security release
# instead of depending on the removed Docker Hub / Quay images.
# Native target-platform stages support both linux/amd64 and linux/arm64.
FROM golang:1.26.10-alpine3.23@sha256:34414731924cf2263160f0021f5cf6e1807382d85248f7cb419d4187b96d5e43 AS server-build
ENV CGO_ENABLED=0 GOTOOLCHAIN=local GOBIN=/out
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    go install -trimpath -ldflags="-s -w -X github.com/minio/minio/cmd.CopyrightYear=2025 -X github.com/minio/minio/cmd.Version=2025-10-15T17:29:55Z -X github.com/minio/minio/cmd.ReleaseTag=RELEASE.2025-10-15T17-29-55Z -X github.com/minio/minio/cmd.CommitID=9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a" \
      github.com/minio/minio@9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a \
    && module_dir="$(go list -m -f '{{.Dir}}' github.com/minio/minio@9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a)" \
    && cp "$module_dir/LICENSE" "$module_dir/CREDITS" /out/ \
    && go version -m /out/minio

FROM golang:1.26.10-alpine3.23@sha256:34414731924cf2263160f0021f5cf6e1807382d85248f7cb419d4187b96d5e43 AS client-build
ENV CGO_ENABLED=0 GOTOOLCHAIN=local GOBIN=/out
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    go install -trimpath -ldflags="-s -w -X github.com/minio/mc/cmd.CopyrightYear=2025 -X github.com/minio/mc/cmd.Version=2025-08-13T08:35:41Z -X github.com/minio/mc/cmd.ReleaseTag=RELEASE.2025-08-13T08-35-41Z -X github.com/minio/mc/cmd.CommitID=7394ce0dd2a80935aded936b09fa12cbb3cb8096" \
      github.com/minio/mc@7394ce0dd2a80935aded936b09fa12cbb3cb8096 \
    && module_dir="$(go list -m -f '{{.Dir}}' github.com/minio/mc@7394ce0dd2a80935aded936b09fa12cbb3cb8096)" \
    && cp "$module_dir/LICENSE" "$module_dir/CREDITS" /out/ \
    && go version -m /out/mc

FROM alpine:3.23.4@sha256:5b10f432ef3da1b8d4c7eb6c487f2f5a8f096bc91145e68878dd4a5019afde11 AS runtime
RUN apk add --no-cache ca-certificates curl

FROM runtime AS minio
LABEL org.opencontainers.image.source="https://github.com/minio/minio" \
      org.opencontainers.image.revision="9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
COPY --from=server-build /out/minio /usr/local/bin/minio
COPY --from=server-build /out/LICENSE /out/CREDITS /usr/share/licenses/minio/
EXPOSE 9000 9001
ENTRYPOINT ["minio"]
CMD ["server", "/data", "--console-address", ":9001"]

FROM runtime AS mc
LABEL org.opencontainers.image.source="https://github.com/minio/mc" \
      org.opencontainers.image.revision="7394ce0dd2a80935aded936b09fa12cbb3cb8096" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
COPY --from=client-build /out/mc /usr/local/bin/mc
COPY --from=client-build /out/LICENSE /out/CREDITS /usr/share/licenses/mc/
ENTRYPOINT ["mc"]
