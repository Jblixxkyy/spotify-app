FROM node:24-bookworm-slim
# yt-dlp standalone Linux binary (self-contained, no Python needed) + ffmpeg
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates  && curl -fL -o /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux  && chmod +x /usr/local/bin/yt-dlp  && yt-dlp --version  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
EXPOSE 8378
CMD ["node", "server.js"]
