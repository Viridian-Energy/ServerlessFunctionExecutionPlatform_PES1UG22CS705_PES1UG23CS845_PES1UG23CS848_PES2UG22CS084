# Dockerfile for the serverless platform
FROM node:14-alpine

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
COPY package*.json ./
RUN npm install

# Copy app source
COPY . .

# Create temp directory for function execution
RUN mkdir -p temp

# Install Docker CLI for container management
# Note: This Docker installation is used to communicate with the host Docker daemon
RUN apk add --no-cache docker-cli

# Expose port
EXPOSE 3000

# Start command
CMD ["node", "server.js"]
