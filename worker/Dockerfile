FROM node:20-alpine AS base
WORKDIR /app

FROM base AS deps
WORKDIR /app/worker
COPY worker/package.json worker/package-lock.json* ./
RUN npm ci

FROM deps AS build
COPY worker/tsconfig.json ./tsconfig.json
COPY worker/src ./src
COPY prisma /app/prisma
RUN npx prisma generate --schema /app/prisma/schema.prisma
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app/worker
ENV NODE_ENV=production

COPY --from=build /app/worker/node_modules ./node_modules
COPY --from=build /app/worker/dist ./dist
COPY worker/package.json ./package.json
COPY --from=build /app/prisma/generated/client /app/prisma/generated/client

EXPOSE 8080
CMD ["node", "dist/index.js"]
