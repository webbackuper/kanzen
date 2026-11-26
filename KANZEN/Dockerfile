# Option conteneur (le mode principal est le bundle natif, cf. étape 3).
FROM node:24-alpine AS build
WORKDIR /src
COPY package*.json prisma.config.js ./
COPY prisma ./prisma
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
RUN apk add --no-cache postgresql16-client tini
WORKDIR /opt/kanzen
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 STATIC_DIR=/opt/kanzen/public UPLOAD_DIR=/var/lib/kanzen/uploads
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/package.json /src/prisma.config.js ./
COPY --from=build /src/prisma ./prisma
COPY --from=build /src/src/server ./src/server
COPY --from=build /src/scripts ./scripts
COPY --from=build /src/dist ./public
RUN mkdir -p /var/lib/kanzen/uploads && chown -R node:node /var/lib/kanzen
USER node
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "npx prisma migrate deploy && exec node src/server/index.js"]
