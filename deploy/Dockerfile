# Ronchi Connect server image: signaling, team features, website and downloads.
# Build from the repository root:  docker build -f deploy/Dockerfile -t ronchi-connect-server .
FROM node:22-alpine
WORKDIR /app
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev
COPY server/src ./server/src
COPY website ./website
COPY brand ./brand
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data DOWNLOADS_DIR=/downloads TRUST_PROXY=1
VOLUME ["/data", "/downloads"]
EXPOSE 8080
USER node
CMD ["node", "server/src/index.js"]
