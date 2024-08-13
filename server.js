const amqp = require('amqplib');
const fs = require('fs');
const path = require('path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const process = require('process');

// Load configuration
const config = require('./config.json');

const PROTO_PATH = './file_transfer.proto';
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true
});
const fileTransferProto = grpc.loadPackageDefinition(packageDefinition).fileTransfer;

let server;
let channel;

async function clearQueue(channel) {
    const queueStatus = await channel.checkQueue(config.queueName);
    if (queueStatus.messageCount > 0) {
        await channel.purgeQueue(config.queueName);
        console.log(`Cleared ${queueStatus.messageCount} messages from the queue`);
    }
}

async function sendJobs() {
    const connection = await amqp.connect(config.rabbitmqUrl);
    channel = await connection.createChannel();
    await channel.assertQueue(config.queueName, { durable: false });

    await clearQueue(channel);

    console.log("Reading file lists")
    
    const files = fs.readdirSync(config.imageDir).filter(file => /\.(jpg|png)$/i.test(file));
    
    console.log("Sending jobs")
    
    let numOfFiles = 0;
    
    for (const file of files) {
        const filePath = path.join(config.imageDir, file);
        const job = { source: filePath, fileName: file };
        channel.sendToQueue(config.queueName, Buffer.from(JSON.stringify(job)), { persistent: false });
        numOfFiles++;
    }

    console.log(`${numOfFiles} jobs sent to the queue`);
}

function getFile(call, callback) {
    const { fileName } = call.request;
    const filePath = path.join(config.imageDir, fileName);
    if (fs.existsSync(filePath)) {
        const fileContent = fs.readFileSync(filePath);
        callback(null, { fileContent });
    } else {
        callback(new Error(`File not found: ${fileName}`));
    }
}

function uploadFile(call, callback) {
    const { fileName, fileContent } = call.request;
    const filePath = path.join(config.imageDir, fileName);
    const tempFilePath = `${filePath}.tmp`;
    const originalFilePath = filePath.replace('.jxl', '');

    try {
        fs.writeFileSync(tempFilePath, Buffer.from(fileContent));
        console.log(`Received converted file: ${fileName}`);

        // Atomically rename the temp file to the final file
        fs.renameSync(tempFilePath, filePath.replace(/\.[a-zA-Z0-9]{3}(?=\.jxl$)/, ''));

        // Remove the original file if the conversion was successful
        if (fs.existsSync(originalFilePath)) {
            fs.unlinkSync(originalFilePath);
        }
        callback(null, {});
    } catch (error) {
        console.error(`Failed to upload file ${fileName}: ${error.message}`);
        if (fs.existsSync(tempFilePath)) {
            fs.unlinkSync(tempFilePath);
        }
        callback(error);
    }
}

function main() {
    server = new grpc.Server({
        'grpc.max_receive_message_length': config.maxMessageSize,
        'grpc.max_send_message_length': config.maxMessageSize
    });
    server.addService(fileTransferProto.FileTransfer.service, { getFile, uploadFile });
    server.bindAsync(config.grpcPort, grpc.ServerCredentials.createInsecure(), () => {
        server.start();
        console.log(`gRPC server listening on port ${config.grpcPort}`);
    });

    sendJobs().catch(console.error);

    // Graceful shutdown
    process.on('SIGINT', () => {
        console.log('Shutting down server...');
        if (server) {
            server.tryShutdown(() => {
                console.log('gRPC server shut down.');
                if (channel) {
                    channel.close().then(() => {
                        console.log('AMQP channel closed.');
                        process.exit(0);
                    });
                } else {
                    process.exit(0);
                }
            });
        } else {
            process.exit(0);
        }
    });
}

main();