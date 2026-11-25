# Option conteneur (le mode de déploiement principal est le bundle natif).

# --- Stage 1 : build du frontend ---
FROM node:20-alpine AS ui-builder
WORKDIR /ui
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build:ui

# --- Stage 2 : runtime ---
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000

COPY package*.json ./
RUN npm ci --omit=dev

COPY src/server ./src/server
COPY prisma ./prisma
COPY --from=ui-builder /ui/dist ./public
RUN npx prisma generate && mkdir -p uploads && chown -R node:node /app

USER node
EXPOSE 3000
# Pas de seed ici : il purge la base à chaque démarrage.
CMD ["sh", "-c", "npx prisma migrate deploy && node src/server/index.js"]
