# sharedrive - schlankes Abbild ohne Abhaengigkeiten.
# Es wird nichts kompiliert und nichts installiert: der Server nutzt ausschliesslich
# Module, die in Node enthalten sind (node:http, node:sqlite, node:crypto).
# Node 24 ist LTS und bringt node:sqlite ohne Schalter mit (noetig ab 22.13).
FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATA_DIR=/data

WORKDIR /app

# Nur das, was zur Laufzeit gebraucht wird
COPY package.json ./
COPY server ./server
COPY public ./public

# Datenverzeichnis als Volume, damit Transfers Neustarts ueberleben
RUN mkdir -p /data && chown -R node:node /app /data
VOLUME ["/data"]

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
