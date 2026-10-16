FROM node:20-alpine

# Tạo user không phải root để bảo mật
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Copy package files trước để tận dụng Docker layer cache
COPY package*.json ./

# Cài production dependencies
RUN npm ci --only=production

# Copy source code
COPY src/ ./src/

# Copy public assets (admin UI, overlay)
COPY public/ ./public/

# Đổi ownership sang non-root user
RUN chown -R appuser:appgroup /app

USER appuser

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

CMD ["node", "src/server.js"]
