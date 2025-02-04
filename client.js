const amqp = require('amqplib');
const { exec } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const process = require('process');

const config = require('./config.json');
const NUM_CORES = os.cpus().length;

const PROTO_PATH = './file_transfer.proto';
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
});
const fileTransferProto = grpc.loadPackageDefinition(packageDefinition).fileTransfer;
const client = new fileTransferProto.FileTransfer(config.grpcServerUrl, grpc.credentials.createInsecure(), {
    'grpc.max_receive_message_length': config.maxMessageSize,
    'grpc.max_send_message_length': config.maxMessageSize,
});

let channel;

async function getFileFromServer(fileName) {
    return new Promise((resolve, reject) => {
        client.getFile({ fileName }, (err, response) => {
            if (err) return reject(err);
            resolve(response.fileContent);
        });
    });
}

async function uploadFileToServer(fileName, fileContent) {
    return new Promise((resolve, reject) => {
        client.uploadFile({ fileName, fileContent }, (err) => {
            if (err) return reject(err);
            resolve();
        });
    });
}

async function executeCommand(command) {
    return new Promise((resolve, reject) => {
        exec(command, (error) => {
            if (error) return reject(error);
            resolve();
        });
    });
}

async function cleanUpFiles(...files) {
    for (const file of files) {
        try {
            await fs.unlink(file);
        } catch (err) {
            console.error(`Failed to clean up file ${file}: ${err.message}`);
        }
    }
}

async function reportBrokenFile(fileName) {
    await channel.assertQueue(config.brokenFilesQueueName, { durable: false });
    await channel.sendToQueue(config.brokenFilesQueueName, Buffer.from(JSON.stringify({ fileName })), { persistent: false });
}

async function processJob(job, msg) {
    const { fileName } = job;
    const localSource = path.join(config.ramdiskDir, fileName);
    const localDest = path.join(config.ramdiskDir, `${fileName}.${config.extension}`);

    try {
        // Retrieve file
        const fileContent = await getFileFromServer(fileName);
        await fs.writeFile(localSource, Buffer.from(fileContent));

        // Validate file
        const stats = await fs.stat(localSource);
        if (stats.size === 0) throw new Error('Corrupted image file (size is 0)');

        // Process file
        await executeCommand(`"${config.cjxlPath}" --quiet --num_threads=0 --lossless_jpeg=1 -d 0 "${localSource}" "${localDest}"`);

        // Read processed file
        const processedFileContent = await fs.readFile(localDest);

        // Upload file asynchronously
        uploadFileToServer(fileName, processedFileContent)
            .then(() => console.log(`Successfully uploaded ${fileName}`))
            .catch(err => console.error(`Failed to upload ${fileName}: ${err.message}`));

    } catch (error) {
        console.error(`Failed to process ${fileName}: ${error.message}`);
        await reportBrokenFile(fileName);
    } finally {
        await cleanUpFiles(localSource, localDest);
        channel.ack(msg); // Acknowledge message immediately
    }
}

async function main() {
    const connection = await amqp.connect(config.rabbitmqUrl);
    channel = await connection.createChannel();
    await channel.assertQueue(config.queueName, { durable: false });
    channel.prefetch(NUM_CORES);

    channel.consume(config.queueName, async (msg) => {
        if (msg) {
            const job = JSON.parse(msg.content.toString());
            await processJob(job, msg);
        }
    }, { noAck: false });

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
