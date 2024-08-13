const amqp = require('amqplib');
const { exec } = require('child_process');
const fs = require('fs');
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
    oneofs: true
});
const fileTransferProto = grpc.loadPackageDefinition(packageDefinition).fileTransfer;
const client = new fileTransferProto.FileTransfer(config.grpcServerUrl, grpc.credentials.createInsecure(), {
    'grpc.max_receive_message_length': config.maxMessageSize,
    'grpc.max_send_message_length': config.maxMessageSize
});

let channel;

async function processJob(job, channel, msg) {
    const { source, fileName } = job;
    const localSource = path.join(config.ramdiskDir, fileName);
    const localDest = path.join(config.ramdiskDir, `${fileName}.jxl`);

    try {
        // Request the source file from the main server
        const fileResponse = await new Promise((resolve, reject) => {
            client.getFile({ fileName }, (err, response) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(response);
                }
            });
        });

        fs.writeFileSync(localSource, Buffer.from(fileResponse.fileContent));

        // Check if the file is corrupted (simple check: file size > 0)
        const stats = fs.statSync(localSource);
        if (stats.size === 0) {
            throw new Error('Corrupted image file (size is 0)');
        }

        // Convert the file using cjxl
        exec(`"${config.cjxlPath}" --quiet --num_threads=0 --lossless_jpeg=1 -d 0 "${localSource}" "${localDest}"`, (err) => {
            if (err) {
                console.error(`Error converting file: ${err}`);
                // Clean up local files
                try {
                    if (fs.existsSync(localSource)) {
                        fs.unlinkSync(localSource);
                    }
                    if (fs.existsSync(localDest)) {
                        fs.unlinkSync(localDest);
                    }
                } catch (cleanupError) {
                    console.error(`Failed to clean up files for ${fileName}: ${cleanupError.message}`);
                }
                // Acknowledge the message to avoid requeueing
                channel.ack(msg);
                return;
            }

            try {
                // Read the converted file and send it back to the main server
                const fileContent = fs.readFileSync(localDest);
                client.uploadFile({ fileName: `${fileName}.jxl`, fileContent }, (err) => {
                    if (err) {
                        console.error(`Failed to upload file ${fileName}: ${err.message}`);
                    } else {
                        console.log(`Successfully processed ${fileName}`);
                    }
                });
            } catch (fileError) {
                console.error(`Failed to process file ${fileName}: ${fileError.message}`);
            } finally {
                // Clean up local files
                try {
                    if (fs.existsSync(localSource)) {
                        fs.unlinkSync(localSource);
                    }
                    if (fs.existsSync(localDest)) {
                        fs.unlinkSync(localDest);
                    }
                } catch (cleanupError) {
                    console.error(`Failed to clean up files for ${fileName}: ${cleanupError.message}`);
                }

                // Acknowledge the message
                channel.ack(msg);
            }
        });
    } catch (error) {
        console.error(`Failed to process job for ${fileName}: ${error.message}`);
        // Clean up local files
        try {
            if (fs.existsSync(localSource)) {
                fs.unlinkSync(localSource);
            }
            if (fs.existsSync(localDest)) {
                fs.unlinkSync(localDest);
            }
        } catch (cleanupError) {
            console.error(`Failed to clean up files for ${fileName}: ${cleanupError.message}`);
        }
        // Acknowledge the message to avoid requeueing
        channel.ack(msg);
    }
}

async function startWorker() {
    const connection = await amqp.connect(config.rabbitmqUrl);
    channel = await connection.createChannel();
    await channel.assertQueue(config.queueName, { durable: false });
    channel.prefetch(NUM_CORES);

    channel.consume(config.queueName, async (msg) => {
        if (msg !== null) {
            const job = JSON.parse(msg.content.toString());
            await processJob(job, channel, msg);
        }
    }, { noAck: false });

    // Graceful shutdown
    process.on('SIGINT', () => {
        console.log('Shutting down client...');
        if (channel) {
            channel.close().then(() => {
                console.log('AMQP channel closed.');
                process.exit(0);
            });
        } else {
            process.exit(0);
        }
    });
}

startWorker().catch(console.error);