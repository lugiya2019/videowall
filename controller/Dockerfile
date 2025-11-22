FROM node:18-alpine
WORKDIR /app
# Install runtime deps (ffmpeg for auto-crop) then prod node modules
RUN apk add --no-cache ffmpeg
COPY package*.json ./
RUN npm install --production
COPY src ./src
COPY public ./public
EXPOSE 8080
CMD ["node","src/server.js"]
