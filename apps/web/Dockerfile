FROM node:20-slim

WORKDIR /app
COPY . .
RUN npm ci

EXPOSE 3000
CMD ["npm", "run", "dev", "--workspace=web", "--", "--hostname", "0.0.0.0"]