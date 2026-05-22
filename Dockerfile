# Stage 1: Build the Rust Server
FROM docker.io/library/rust:alpine AS builder
WORKDIR /app

# Install apk build dependencies (musl-dev required for compiling native C libraries if any)
RUN apk add --no-cache musl-dev

# Copy the Rust project
COPY server/ ./server/
WORKDIR /app/server

# Compile the highly-optimized release binary
RUN cargo build --release

# Stage 2: Create the minimal runtime container
FROM docker.io/library/alpine:latest
WORKDIR /app

# Copy the compiled static frontend
COPY webroot/ ./webroot/

# Copy the compiled Rust binary from the builder stage
COPY --from=builder /app/server/target/release/sendspin-relay ./sendspin-relay

# Use environment variables so Pterodactyl can dynamically mount ports
ENV SERVER_IP="0.0.0.0"
ENV SERVER_PORT="8000"
ENV WEBROOT_PATH="./webroot"
EXPOSE 8000

# Execute the native proxy
CMD ["./sendspin-relay"]
