FROM node:22-slim

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Create non-root user
RUN useradd -m -u 1001 paperclip

# Copy workspace files
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/ ./packages/
COPY server/ ./server/
COPY agents/ ./agents/
COPY ui/ ./ui/
COPY patches/ ./patches/

# Install dependencies as root (needed for workspace setup)
RUN pnpm install --frozen-lockfile

# Install Claude CLI globally
RUN npm install -g @anthropic-ai/claude-code

# Give paperclip user access
RUN chown -R paperclip:paperclip /app
RUN chown -R paperclip:paperclip /usr/local/lib/node_modules
RUN chown -R paperclip:paperclip /usr/local/bin

# Build plugin-sdk
RUN pnpm --filter @paperclipai/plugin-sdk build

# Switch to non-root user
USER paperclip

EXPOSE 8080

CMD ["pnpm", "--filter", "@paperclipai/server", "exec", "tsx", "src/index.ts"]
