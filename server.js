const amqp = require('amqplib');
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const process = require('process');

// Load configuration
const config = require('./config.json');

// Broken file tracker for reruns
const brokenFilesPath = './broken_files.json';


let server;
let channel;
let sentFiles = new Set();
let brokenFiles = loadBrokenFiles();
const upload = multer({ limits: { fileSize: Number.MAX_SAFE_INTEGER } });

// REST API for file transfer
const app = express();
app.use(cors());
app.use(express.json());

function isAPNG(filePath) {
  const SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

  const buffer = fs.readFileSync(filePath);

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

async function clearQueue(channel) {
    const queueStatus = await channel.checkQueue(config.queueName);
    if (queueStatus.messageCount > 0) {
        await channel.purgeQueue(config.queueName);
        console.log(`Cleared ${queueStatus.messageCount} messages from the queue`);
    }
}

async function getAllFiles(dir, fileList = []) {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            await getAllFiles(fullPath, fileList);
        } else if (/\.(jpg|png|jxl)$/i.test(entry.name)) {
            fileList.push(fullPath);
        }
    }
    return fileList;
}

async function sendJobs(channel) {
    console.log("Reading file lists recursively");
    const allFiles = await getAllFiles(config.imageDir);
    const files = allFiles.map(f => path.relative(config.imageDir, f));

    console.log("Sending jobs");
    let numOfFiles = 0;
    for (const file of files) {
        if (brokenFiles.has(file) || completedFiles.has(file) || sentFiles.has(file)) {
            continue; // Skip if already sent, marked as broken, or completed
        }

        // If file format is PNG and isAPNG returns true, skip it
        if (path.extname(file).toLowerCase() === '.png' && isAPNG(path.join(config.imageDir, file))) {
            console.log(`Skipping animated PNG file: ${file}`);
            markFileAsBroken(file);
            continue;
        }

        const filePath = path.join(config.imageDir, file);
        const job = { source: filePath, fileName: file };
        channel.sendToQueue(config.queueName, Buffer.from(JSON.stringify(job)), { persistent: false });

        sentFiles.add(file); // Mark file as sent
        numOfFiles++;
    }

    console.log(`${numOfFiles} new jobs sent to the queue`);
}

// Download file endpoint (supports subfolder syntax: /file/:folder/:fileName)
app.get('/file/:folder/:fileName', (req, res) => {
    const { folder, fileName } = req.params;
    const safeBase = path.resolve(config.imageDir);
    const requestedPath = path.resolve(config.imageDir, folder, fileName);
    if (!requestedPath.startsWith(safeBase + path.sep)) {
        return res.status(400).json({ error: 'Invalid file path.' });
    }
    if (fs.existsSync(requestedPath)) {
        res.sendFile(requestedPath);
    } else {
        res.status(404).json({ error: `File not found: ${folder}/${fileName}` });
    }
});

// Upload file endpoint
app.post('/upload', upload.single('file'), (req, res) => {
    const { originalname } = req.file;
    const { fileName } = req.body;
    const baseName = path.parse(fileName).name;
    const folderName = Math.floor(baseName / CHUNK_SIZE);
    const convertedFilePath = path.join(config.imageDir, `${baseName}.${config.extension}`);
    const tempFilePath = `${convertedFilePath}.tmp`;
    try {
        fs.mkdirSync(path.dirname(convertedFilePath), { recursive: true });
        fs.writeFileSync(tempFilePath, req.file.buffer);
        console.log(`Received converted file: ${fileName}`);
        fs.renameSync(tempFilePath, convertedFilePath);
        res.json({ success: true });
    } catch (error) {
        console.error(`Failed to upload file ${fileName}: ${error.message}`);
        markFileAsBroken(fileName);
        if (fs.existsSync(tempFilePath)) {
            fs.unlinkSync(tempFilePath);
        }
        res.status(500).json({ error: error.message });
    }
});

const REST_PORT = config.restPort || 3000;
app.listen(REST_PORT, () => {
    console.log(`REST API server listening on port ${REST_PORT}`);
});

function loadBrokenFiles() {
    if (fs.existsSync(brokenFilesPath)) {
        return new Set(JSON.parse(fs.readFileSync(brokenFilesPath, 'utf8')));
    }
    return new Set();
}

function saveBrokenFiles() {
    fs.writeFileSync(brokenFilesPath, JSON.stringify([...brokenFiles]), 'utf8');
}

function markFileAsBroken(fileName) {
    brokenFiles.add(fileName);
    saveBrokenFiles();
}

async function listenForBrokenFiles(channel) {
    await channel.assertQueue(config.brokenFilesQueueName, { durable: false });

    console.log(`Listening for broken file reports on queue: ${config.brokenFilesQueueName}`);

    channel.consume(config.brokenFilesQueueName, (msg) => {
        if (msg !== null) {
            try {
                const { fileName } = JSON.parse(msg.content.toString());
                console.log(`Received broken file report: ${fileName}`);

                markFileAsBroken(fileName); // Persist it to broken_files.json
            } catch (parseError) {
                console.error(`Failed to parse broken file message: ${parseError.message}`);
            }
            channel.ack(msg); // Acknowledge message
        }
    });
}


async function main() {
    const connection = await amqp.connect(config.rabbitmqUrl);
    channel = await connection.createChannel();
    await channel.assertQueue(config.queueName, { durable: false });

    // Clear queue on startup
    await clearQueue(channel);

    // Start listening for broken files
    listenForBrokenFiles(channel).catch(console.error);

    // Send initial job list
    sendJobs(channel).catch(console.error);

    // Graceful shutdown
    process.on('SIGINT', async () => {
        console.log('Shutting down server...');
        if (server) {
            server.tryShutdown(async () => {
                console.log('Server shut down.');
                if (channel) {
                    await channel.close();
                    console.log('AMQP channel closed.');
                }
                process.exit(0);
            });
        } else {
            process.exit(0);
        }
    });
}

main().catch(console.error);
