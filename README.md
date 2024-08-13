# Distributed JXL Image Converter

This repository contains a proof-of-concept solution that I wrote to convert a few million images to JPEG-XL with work distributed across multiple computers using RabbitMQ and gRPC.

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Configuration](#configuration)
- [Usage](#usage)
- [Contributing](#contributing)
- [License](#license)

## Overview

This project demonstrates a distributed system for converting images to JXL format. It uses RabbitMQ for job queuing and gRPC for file transfer between the server and clients. As of writing this, there aren't any JPEG-XL encoders for NodeJS that support writing metadata, which is something that I wanted to fix with this project. This was done by calling `cjxl` via child_process with one instance per machine core, although since it doesn't support pipes the solution has to use a temp folder or a RAM disk on each worker.

Both client and server are simple to read and modify to use any other command that you'd like, for example if you want to use AVIF instead of JPEG-XL.

## Architecture

- **Server**: Reads image files from a specified directory, sends conversion jobs to RabbitMQ, and provides gRPC services for file transfer.
- **Client**: Consumes jobs from RabbitMQ, requests the original image from the server, converts it to JXL format, and uploads the converted image back to the server.

## Prerequisites

- Node.js (>= 14.x)
- RabbitMQ
- `cjxl` (JPEG XL encoder)

To setup RabbitMQ, follow instructions on the [official RabbitMQ page here](https://www.rabbitmq.com/docs/download), for example on macOS the commands would be:

```sh
brew install rabbitmq
rabbitmqctl enable_feature_flag all
```

You'll also need to create a user for your clients using these commands:

```sh
rabbitmqctl add_user myuser mypassword
rabbitmqctl set_permissions -p / myuser ".*" ".*" ".*"
```

## Configuration

Rename the included `config.json.dist` to `config.json` and adjust the following settings:

- [server] `imageDir`: This folder should contain the originals and will also be the destination, **originals are deleted automatically** on success.
- [client] `ramdiskDir`: path to a temp folder, or ideally a RAM disk to avoid wear on disk
- [client] `rabbitmqUrl`: Change to use the correct credentials and server address for clients
- [server] `grpcPort`: gRPC will listen on this port on the server
- [client] `grpcServerUrl`: change to use correct server IP and port for clients
- [client] `cjxlPath`: change if `cjxl` is not in your `$PATH`

## Usage

### Server

1. Install dependencies:

   ```bash
   npm install
   ```

2. Start the server:

   ```bash
   node server.js
   ```

### Client

1. Install dependencies:

   ```bash
   npm install
   ```

2. Start the client:

   ```bash
   node client.js
   ```


## Contributing

Contributions are welcome! Please open an issue or submit a pull request for any improvements or bug fixes.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
