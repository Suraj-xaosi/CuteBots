FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends docker.io \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .
RUN npm ci

EXPOSE 3000
CMD ["npm", "run", "dev", "--", "--filter=web", "--", "--hostname", "0.0.0.0"]