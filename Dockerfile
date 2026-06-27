# Settle — production container
FROM node:22-slim

WORKDIR /app

# install deps first for layer caching (@resvg/resvg-js ships prebuilt binaries)
COPY package*.json ./
RUN npm install --omit=dev

# app source (server, cards, fonts, public/, *.svg templates)
COPY . .

ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
