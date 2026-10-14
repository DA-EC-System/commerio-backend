# Một image cho cả ba tiến trình. Mặc định chạy api; worker và realtime đổi lệnh:
#   node src/entrypoints/worker.ts   |   node src/entrypoints/realtime.ts
# Build từ thư mục gốc repo: docker build -f deploy/docker/Dockerfile -t commerio-backend .

FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
USER node
EXPOSE 3000
CMD ["node", "src/entrypoints/api.ts"]
