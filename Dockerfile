FROM node:23-alpine

# Set timezone
ENV TZ="Asia/Kolkata"

# Install dependencies
RUN apt-get update && apt-get install -y \
    ca-certificates \
    curl \
    gnupg \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Install Brave browser
RUN curl -fsSL https://brave-browser-apt-release.s3.brave.com/brave-core.asc | gpg --dearmor | tee /usr/share/keyrings/brave-browser-archive-keyring.gpg > /dev/null \
    && echo "deb [signed-by=/usr/share/keyrings/brave-browser-archive-keyring.gpg] https://brave-browser-apt-release.s3.brave.com/ stable main" | tee /etc/apt/sources.list.d/brave-browser-release.list \
    && apt-get update \
    && apt-get install -y brave-browser --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*


# Set working directory
WORKDIR /app


# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy application files
COPY . .

# Expose port
EXPOSE 3000

# Start the application
CMD ["node", "index.js"]
