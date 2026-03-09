FROM node:18-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:18-alpine
WORKDIR /app
COPY --from=build /app/dist ./dist
RUN npm install -g serve
ENV PORT=3000
EXPOSE 3000
CMD sh -c "serve -s dist -l tcp://0.0.0.0:${PORT:-3000}"
