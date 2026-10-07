FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json tsconfig.examples.json ./
COPY src ./src
COPY examples ./examples
RUN npm run build && npm run build:examples

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/build ./build
COPY --from=build /app/package.json ./package.json
COPY examples/rabbitmq-demo ./examples/rabbitmq-demo
CMD ["node", "examples/rabbitmq-demo/demo.mjs"]
