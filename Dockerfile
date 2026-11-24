FROM node:24.22.3-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0 AS tools
RUN apt-get update && apt-get install -y --no-install-recommends libjxl-tools imagemagick tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM tools AS build
RUN npm install --global pnpm@11.25.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src/ src/
COPY web/ web/
COPY scripts/build.ts scripts/build.ts
COPY test/ test/
RUN pnpm check && pnpm build

FROM build AS test
USER node
CMD ["node", "--test", "test/*.test.ts"]

FROM build AS production-dependencies
RUN pnpm prune --prod

FROM tools AS runtime
ARG REVISION=development
LABEL org.opencontainers.image.title="CBZXL" \
      org.opencontainers.image.description="A compact TypeScript comic archive optimizer" \
      org.opencontainers.image.source="https://github.com/AngelaDMerkel/CBZXL" \
      org.opencontainers.image.revision="${REVISION}"
COPY --from=production-dependencies /app/node_modules/ node_modules/
COPY package.json ./
COPY src/ src/
COPY --from=build /app/dist/ dist/
ENV HOST=0.0.0.0 PORT=5000 SOURCE_DIR=/library/source DB_PATH=/config/cbzxl.sqlite3 SCRATCH_DIR=/work
USER node
EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/cli.ts", "run"]
