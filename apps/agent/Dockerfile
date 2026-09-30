FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .
RUN npm ci

EXPOSE 3001
CMD ["npm", "run", "dev", "--workspace=agent"]