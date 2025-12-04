const amqp = require('amqplib');
const { exec } = require('child_process');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const FormData = require('form-data');
const process = require('process');
const https = require('https');
const sharp = require('sharp');

const agent = new https.Agent({ keepAlive: true, maxSockets: 20 });

const config = require('./config.json');
const NUM_CORES = os.cpus().length;
const MAX_CACHE = NUM_CORES * 4;
const processorType = (config.imageProcessor || 'sharp').toLowerCase();

const REST_SERVER_URL = config.restServerUrl;
const UPLOAD_REST_SERVER_URL = config.uploadRestServerUrl;

let channel;
const localQueue = []; // Local queue for pre-downloaded files

async function getFileFromServer(fileName) {
    try {
        // Use fileName as-is, including subfolders
        const response = await axios.get(`${REST_SERVER_URL}/file/${fileName}`, {
            httpsAgent: agent,
            responseType: 'arraybuffer',
        });
        return response.data;
    } catch (err) {
        throw new Error(`Failed to download file: ${fileName} (${err.message})`);
    }
}

async function uploadFileToServer(fileName, fileContent) {
    try {
        // Only keep the base file name (remove subfolders)
        const baseName = path.basename(fileName);
        const form = new FormData();
        form.append('file', fileContent, baseName);
        form.append('fileName', baseName);
        await axios.post(`${UPLOAD_REST_SERVER_URL}/upload`, form, {
            headers: form.getHeaders()
        });
    } catch (err) {
        throw new Error(`Failed to upload file: ${fileName} (${err.message})`);
    }
}

async function executeCommand(command) {
    let lowPriorityCommand = command;

    if (process.platform === 'win32') {
        // Windows: Use 'start /B /LOW' and capture the exit code
        const wrappedCommand = `cmd /c "${command} & exit /b %ERRORLEVEL%"`;
        lowPriorityCommand = `start /B /LOW cmd /c "${wrappedCommand}"`;
    } else {
        // Linux/macOS: Use 'nice -n 19'
        lowPriorityCommand = `nice -n 19 ${command}`;
    }

    return new Promise((resolve, reject) => {
        exec(lowPriorityCommand, (error, stdout, stderr) => {
            if (error) return reject(error);
            // Optionally, check stderr for error messages
            resolve();
        });
    });
}

async function cleanUpFiles(...files) {
    for (const file of files) {
        try {
            await fs.unlink(file);
        } catch (err) { }
    }
}

async function reportBrokenFile(fileName) {
    await channel.assertQueue(config.brokenFilesQueueName, { durable: false });
    await channel.sendToQueue(config.brokenFilesQueueName, Buffer.from(JSON.stringify({ fileName })), { persistent: false });
}

/**
 * Downloader: Fetches images in advance and stores them locally
 */
async function downloader(msg) {
    // Wait if cache is full
    while (localQueue.length >= MAX_CACHE) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    const job = JSON.parse(msg.content.toString());
    const { fileName } = job;
    const localPath = path.join(config.ramdiskDir, fileName);

    try {
        // Ensure all folders in path exist
        await fs.mkdir(path.dirname(localPath), { recursive: true });

        // Retrieve file
        const fileContent = await getFileFromServer(fileName);
        await fs.writeFile(localPath, Buffer.from(fileContent));

        // Validate file
        const stats = await fs.stat(localPath);
        if (stats.size === 0) throw new Error('Corrupted image file (size is 0)');

        // Add to processing queue
        localQueue.push({ job, msg });

    } catch (error) {
        console.error(`Failed to download ${fileName}: ${error.message}`);
        channel.ack(msg);
    }
}

async function downloaderLoop() {
    while (true) {
        // Wait if cache is full
        if (localQueue.length >= MAX_CACHE) {
            await new Promise(resolve => setTimeout(resolve, 100));
            continue;
        }

        const msg = await channel.get(config.queueName, { noAck: false });
        if (!msg) {
            await new Promise(resolve => setTimeout(resolve, 100));
            continue;
        }
        await downloader(msg, );
    }
}

function isAPNG(filePath) {
  const SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

  const buffer = fsSync.readFileSync(filePath);

  // Check PNG signature
  if (!buffer.slice(0, 8).equals(SIGNATURE)) {
    return false; // Not a PNG file
  }

  let offset = 8;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.slice(offset + 4, offset + 8).toString('ascii');

    if (type === 'acTL') {
      return true; // Found animation control chunk
    }

    if (type === 'IEND') {
      break;
    }

    offset += 12 + length; // 4 bytes length + 4 bytes type + data + 4 bytes CRC
  }

  return false;
}

/**
 * Processor: Constantly processes images from the preloaded queue
 */
async function processor() {
    while (true) {
        if (localQueue.length === 0) {
            await new Promise((resolve) => setTimeout(resolve, 100)); // Short delay to avoid busy-waiting
            continue;
        }

        const { job, msg } = localQueue.shift();
        const { fileName } = job;
        const localSource = path.join(config.ramdiskDir, fileName);
        const localDest = path.join(config.ramdiskDir, `${fileName}.${config.extension}`);
        let processingSuccess = false;

        try {
            if (!isAPNG(localSource)) {
                // Select processor based on config.imageProcessor ("sharp" or "cjxl")
                if (processorType === 'cjxl') {
                    if (!config.cjxlPath) throw new Error('config.cjxlPath is required when imageProcessor is "cjxl"');
                    await executeCommand(`"${config.cjxlPath}" --quiet --num_threads=0 --lossless_jpeg=0 -d 1 "${localSource}" "${localDest}"`);
                } else if (processorType === 'sharp') {
                    // using sharp library and libvips
                    await sharp(localSource)
                        .jxl({ distance: 1 })
                        .toFile(localDest);
                } else {
                    throw new Error(`Unknown imageProcessor: ${processorType}`);
                }

                console.log(`Processed ${fileName} successfully.`);
                processingSuccess = true;

                const processedFileContent = await fs.readFile(localDest);

                // Upload file asynchronously
                uploadFileToServer(fileName, processedFileContent)
                    .then(() => console.log(`Successfully uploaded ${fileName}`))
                    .catch(err => console.error(`Upload failed for ${fileName}: ${err.message}`));
            }
            else {
                console.log(`Skipping APNG ${fileName}`);
            }

        } catch (error) {
            console.error(`Failed to process ${fileName}: ${error.message}`);

            if (!processingSuccess) {
                await reportBrokenFile(fileName);
            }
        } finally {
            await cleanUpFiles(localSource, localDest);
            channel.ack(msg);
        }
    }
}

/**
 * Main: Manages RabbitMQ connection and starts workers
 */
async function main() {
    const connection = await amqp.connect(config.rabbitmqUrl);
    channel = await connection.createChannel();
    await channel.assertQueue(config.queueName, { durable: false });
    channel.prefetch(MAX_CACHE);

    // Start processor workers
    for (let i = 0; i < NUM_CORES; i++) {
        processor(i);
    }

    // Start downloader workers
    for (let i = 0; i < NUM_CORES; i++) {
        downloaderLoop(i);
    }

    process.on('SIGINT', async () => {
        console.log('Shutting down client...');
        if (channel) {
            await channel.close();
            console.log('AMQP channel closed.');
        }
        process.exit(0);
    });
}

main().catch(console.error);
