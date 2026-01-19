# Distributed JXL Image Converter

This repository contains a proof-of-concept solution that I wrote to convert a few million images to JPEG-XL with work distributed across multiple computers using RabbitMQ and axios.

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Configuration](#configuration)
- [Usage](#usage)
- [Contributing](#contributing)
- [License](#license)

## Overview

This project demonstrates a distributed system for converting images to JXL format. It uses RabbitMQ for job queuing and axios for file transfer between the server and clients. As of writing this, there aren't any JPEG-XL encoders for NodeJS that support writing metadata, which is something that I wanted to fix with this project. This was done by calling `cjxl` via child_process with one instance per machine core, although since it doesn't support pipes in all versions, we also use a temp folder or a RAM disk on each worker.

Both client and server are simple to read and modify to use any other command that you'd like, for example if you want to use AVIF instead of JPEG-XL.

## Architecture

- **Server**: Reads image files from a specified directory, sends conversion jobs to RabbitMQ, and provides axios services for file transfer.
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

- rabbitmqUrl (string) — required (client & server)  
  Example: "amqp://user:pass@host"  
  Full AMQP connection URL used by clients/servers to connect to RabbitMQ.

- queueName (string) — required (both)  
  Example: "image_conversion_jobs"  
  Name of the RabbitMQ queue used to send conversion jobs.

- brokenFilesQueueName (string) — required (both)  
  Example: "broken_files"  
  Name of the queue where clients report files that failed processing.

- imageDir (string) — required (server)  
  Example: "/path/to/source/folder"  
  Directory on the server containing original images. Originals are deleted on successful conversion.

- restServerUrl (string) — required (client)  
  Example: "http://server.local:3000"  
  Base URL used by clients to GET original files (server provides /file/:name endpoint).

- uploadRestServerUrl (string) — required (client)  
  Example: "http://server.local:3000"  
  Base URL used by clients to POST converted files to the server (/upload endpoint).

- ramdiskDir (string) — required (client)  
  Example: "/mnt/RAMDisk"  
  Local temp folder (ideally a RAM disk) used by clients for intermediate files.

- cjxlPath (string) — optional (client)  
  Example: "cjxl" or "/usr/local/bin/cjxl"  
  Path to the cjxl binary. Required only when imageProcessor is set to "cjxl".

- djxlPath (string) — optional (server)  
  Example: "djxl"  
  Path to the djxl binary (used by server-side utilities if present).

- extension (string) — required (both)  
  Example: "jxl"  
  Target file extension for converted images.

- imageProcessor (string) — optional (client) — default "sharp"  
  Allowed values: "sharp" or "cjxl"  
  Selects the encoder used by clients:
  - "sharp": use the sharp Node.js binding (libvips) to write JXL. Does not support writing JXL metadata.
  - "cjxl": call the external cjxl binary (requires cjxlPath). Use this to preserve metadata / use native encoder.

### Notes

- When using "cjxl", ensure cjxlPath points to a working cjxl binary and that system resources (temp/RAM disk) are available, since cjxl uses files rather than pipes.  
- ramdiskDir should be writable and fast to avoid disk wear and to maximize throughput.  
- Keep rabbitmqUrl and network URLs reachable from clients.  
- Sync any new config fields from config.json.dist to your config.json when upgrading.  

### Example `config.json`

```json
{
  "rabbitmqUrl": "amqp://myuser:mypassword@server.local",
  "queueName": "image_conversion_jobs",
  "brokenFilesQueueName": "broken_files",
  "imageDir": "/path/to/source/folder",
  "restServerUrl": "http://server.local:3000",
  "uploadRestServerUrl": "http://server.local:3000",
  "ramdiskDir": "/mnt/RAMDisk",
  "cjxlPath": "cjxl",
  "djxlPath": "djxl",
  "extension": "jxl",
  "imageProcessor": "sharp"
}
```

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
