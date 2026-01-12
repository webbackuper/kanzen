# --- Stage 1: Build Frontend ---
FROM node:20-alpine AS ui-builder
WORKDIR /ui
COPY package*.json ./
RUN npm install
COPY . .
# On suppose que le script "build:ui" lance vite build dans src/client
RUN npm run build:ui

# --- Stage 2: Runtime Backend ---
FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache sqlite

COPY package*.json ./
RUN npm install --production

# Copier le backend
COPY src/server ./src/server
COPY prisma ./prisma

# Copier le build frontend du stage 1 vers le dossier public du backend
COPY --from=ui-builder /ui/dist ./public

# Générer le client Prisma
RUN npx prisma generate

EXPOSE 3000
CMD ["sh", "-c", "npx prisma migrate deploy && npx prisma db seed && node src/server/index.js"]