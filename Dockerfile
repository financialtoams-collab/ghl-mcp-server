# syntax=docker/dockerfile:1

# ---- build ----------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# Dev dependencies are needed here: the "prepare" script compiles with tsc.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY test ./test
COPY generated ./generated
RUN npm run build && node --test "dist/test/*.test.js"

# ---- runtime --------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# --ignore-scripts because "prepare" would run tsc, which is a dev dependency
# and deliberately absent from the runtime image.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=build /app/dist ./dist
# The committed catalog is data the server reads at boot, not build output.
COPY generated ./generated

# Never run the CRM proxy as root.
USER node

# Render, Railway and Fly all inject PORT; the server binds 0.0.0.0 inside the
# container because the platform's proxy is the only thing that can reach it.
ENV MCP_BIND_HOST=0.0.0.0
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/src/http.js"]
