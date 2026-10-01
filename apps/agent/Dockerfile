FROM node:22-slim

COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .
RUN npm ci && npm exec -- turbo run build --filter=agent... --ui=stream

EXPOSE 3001
CMD ["npm", "run", "start", "--workspace=agent"]