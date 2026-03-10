FROM node:18-alpine
WORKDIR /app
COPY server/package*.json ./
RUN npm install --production
COPY server/ .
ENV PORT=4000
EXPOSE 4000
CMD ["node", "index.js"]
