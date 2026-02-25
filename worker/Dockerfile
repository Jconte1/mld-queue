FROM node:20-alpine AS base
WORKDIR /app

FROM base AS deps
COPY worker/package.json worker/package-lock.json* ./
RUN npm ci

FROM deps AS build
COPY worker/tsconfig.json ./tsconfig.json
COPY worker/src ./src
COPY prisma ./prisma
RUN npx prisma generate --schema ./prisma/schema.prisma
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY worker/package.json ./package.json

EXPOSE 8080
CMD ["node", "dist/index.js"]
