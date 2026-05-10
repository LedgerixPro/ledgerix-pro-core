FROM node:22-bookworm-slim

WORKDIR /app

# Install system deps
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

# Install pnpm
RUN npm install -g pnpm@9

# Create non-root user
RUN useradd -m -u 1001 paperclip

# Copy workspace files
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY tsconfig.base.json tsconfig.json ./
COPY patches/ ./patches/
COPY packages/ ./packages/
COPY server/ ./server/
COPY agents/ ./agents/
COPY ui/ ./ui/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Install Claude CLI
RUN npm install -g @anthropic-ai/claude-code

# Build plugin-sdk only (tsx handles server at runtime — no tsc needed)
RUN pnpm --filter @paperclipai/plugin-sdk build

# Build UI for production — server serves dist when SERVE_UI=true
RUN pnpm --filter @paperclipai/ui build

# Fix ownership
RUN chown -R paperclip:paperclip /app /usr/local/lib/node_modules /usr/local/bin

# Switch to non-root user
USER paperclip

EXPOSE 8080

# Run server as non-root user with exec for proper signal handling
CMD ["/bin/sh", "-c", "exec /app/server/node_modules/.bin/tsx /app/server/src/index.ts"]
