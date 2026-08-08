# Multi-stage: devDependencies (nest CLI, TypeScript) stay out of the runtime image.
FROM node:22-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

# Before `npm run build`: the build imports `@prisma/client`, whose types are
# emitted by `prisma generate` from the schema. Without this the TypeScript
# compile fails on a client that does not exist yet.
COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json nest-cli.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# OpenSSL is a runtime dependency of Prisma's query engine. node:22-alpine does
# not ship it, and its absence surfaces as a connection error at the first query
# rather than at startup.
RUN apk add --no-cache openssl

COPY package*.json ./
# `prisma` (the CLI) is a devDependency but is needed at runtime to apply
# migrations on boot, so it is installed explicitly rather than by dropping
# `--omit=dev` and dragging in the whole toolchain.
RUN npm ci --omit=dev && npm cache clean --force

# The generated client from the builder stage, so the runtime image does not
# need the schema toolchain to produce it a second time.
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma/client ./node_modules/@prisma/client
COPY --from=builder /app/dist ./dist
COPY prisma ./prisma
COPY docker-entrypoint.sh ./

# Non-root: this process reaches a broker, so it gets no more privilege than it needs.
USER node

EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "dist/main.js"]
