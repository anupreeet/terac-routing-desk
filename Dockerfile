# Terac Routing Desk — one Node process, SQLite on a persistent volume.
FROM node:26-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:26-slim
WORKDIR /app
ENV NODE_ENV=production
ENV DESK_DB=/data/desk.sqlite
ENV PORT=3001
COPY package.json package-lock.json ./
RUN npm ci --omit=optional
COPY --from=build /app/src ./src
COPY --from=build /app/dist ./dist
COPY --from=build /app/tsconfig.json ./
RUN mkdir -p /data
VOLUME /data
EXPOSE 3001
CMD ["npx", "tsx", "src/server/main.ts"]
