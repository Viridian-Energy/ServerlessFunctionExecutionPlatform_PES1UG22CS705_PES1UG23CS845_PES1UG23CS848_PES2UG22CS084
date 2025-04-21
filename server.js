// server.js - Main server file
const express = require('express');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const Docker = require('dockerode');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

// Initialize Express
const app = express();
app.use(bodyParser.json());
app.use(express.static('public'));

// Connect to MongoDB
const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/serverless-platform';
mongoose.connect(mongoUri, {
    useNewUrlParser: true,
    useUnifiedTopology: true
});

// Initialize Docker - with Windows compatibility
const dockerOpts = process.platform === 'win32'
    ? { socketPath: '//./pipe/docker_engine' }  // Windows named pipe
    : {}; // Default for Unix/Mac
const docker = new Docker(dockerOpts);

// Function Schema
const functionSchema = new mongoose.Schema({
    name: { type: String, required: true },
    route: { type: String, required: true, unique: true },
    code: { type: String, required: true },
    language: { type: String, enum: ['javascript', 'python'], required: true },
    timeout: { type: Number, default: 30000 }, // Default 30s timeout
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

const Function = mongoose.model('Function', functionSchema);

// Execution Metrics Schema
const metricSchema = new mongoose.Schema({
    functionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Function', required: true },
    duration: { type: Number, required: true }, // Execution time in ms
    status: { type: String, enum: ['success', 'error'], required: true },
    timestamp: { type: Date, default: Date.now },
    error: { type: String }
});

const Metric = mongoose.model('Metric', metricSchema);

// CRUD API for functions
app.get('/api/functions', async (req, res) => {
    try {
        const functions = await Function.find();
        res.json(functions);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/functions/:id', async (req, res) => {
    try {
        const func = await Function.findById(req.params.id);
        if (!func) return res.status(404).json({ error: 'Function not found' });
        res.json(func);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/functions', async (req, res) => {
    try {
        const func = new Function(req.body);
        await func.save();
        res.status(201).json(func);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.put('/api/functions/:id', async (req, res) => {
    try {
        const func = await Function.findByIdAndUpdate(
            req.params.id,
            { ...req.body, updatedAt: Date.now() },
            { new: true }
        );
        if (!func) return res.status(404).json({ error: 'Function not found' });
        res.json(func);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.delete('/api/functions/:id', async (req, res) => {
    try {
        const func = await Function.findByIdAndDelete(req.params.id);
        if (!func) return res.status(404).json({ error: 'Function not found' });
        res.json({ message: 'Function deleted' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Function execution engine
async function executeFunction(func, req) {
    const startTime = Date.now();

    // Create temp directory for function files
    const tempDir = path.join(__dirname, 'temp', uuidv4());
    fs.mkdirSync(tempDir, { recursive: true });

    try {
        let entrypoint, image;

        // Create function file based on language
        if (func.language === 'javascript') {
            fs.writeFileSync(path.join(tempDir, 'index.js'), func.code);
            fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({
                name: "function",
                version: "1.0.0",
                main: "index.js"
            }));

            entrypoint = 'node /app/index.js';
            image = 'node:14-alpine';
        } else if (func.language === 'python') {
            fs.writeFileSync(path.join(tempDir, 'main.py'), func.code);
            entrypoint = 'python /app/main.py';
            image = 'python:3.9-alpine';
        } else {
            throw new Error('Unsupported language');
        }

        // Create input file with request data
        fs.writeFileSync(
            path.join(tempDir, 'input.json'),
            JSON.stringify({
                body: req.body,
                query: req.query,
                params: req.params,
                headers: req.headers
            })
        );

        // Format the path for Docker - Windows compatibility
        const dockerPath = tempDir.replace(/\\/g, '/');

        // Create container
        const container = await docker.createContainer({
            Image: image,
            Cmd: ['sh', '-c', entrypoint],
            HostConfig: {
                Binds: [`${dockerPath}:/app`],
                AutoRemove: true,
                Memory: 128 * 1024 * 1024, // 128MB memory limit
                MemorySwap: 128 * 1024 * 1024, // Disable swap
                CpuPeriod: 100000,
                CpuQuota: 50000, // 0.5 CPU
            }
        });

        // Start container with timeout
        await container.start();

        // Set timeout
        let timedOut = false;
        const timeoutId = setTimeout(async () => {
            timedOut = true;
            try {
                await container.stop();
            } catch (e) {
                console.error('Error stopping container:', e);
            }
        }, func.timeout);

        // Wait for container to finish
        const data = await container.wait();
        clearTimeout(timeoutId);

        if (timedOut) {
            throw new Error('Function execution timed out');
        }

        // Check if the function executed successfully
        if (data.StatusCode !== 0) {
            throw new Error(`Function execution failed with status code ${data.StatusCode}`);
        }

        // Read output
        let output;
        try {
            output = JSON.parse(fs.readFileSync(path.join(tempDir, 'output.json'), 'utf8'));
        } catch (e) {
            output = { error: 'Function did not produce valid output' };
        }

        // Record execution metrics
        const duration = Date.now() - startTime;
        await new Metric({
            functionId: func._id,
            duration,
            status: 'success'
        }).save();

        return { output, duration };
    } catch (error) {
        // Record error metrics
        const duration = Date.now() - startTime;
        await new Metric({
            functionId: func._id,
            duration,
            status: 'error',
            error: error.message
        }).save();

        throw error;
    } finally {
        // Clean up temp directory
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (cleanupError) {
            console.error('Error cleaning up temp directory:', cleanupError);
            // Try alternative cleanup for older Node versions
            const deleteFolderRecursive = function(directoryPath) {
                if (fs.existsSync(directoryPath)) {
                    fs.readdirSync(directoryPath).forEach((file) => {
                        const curPath = path.join(directoryPath, file);
                        if (fs.lstatSync(curPath).isDirectory()) {
                            deleteFolderRecursive(curPath);
                        } else {
                            fs.unlinkSync(curPath);
                        }
                    });
                    fs.rmdirSync(directoryPath);
                }
            };

            try {
                deleteFolderRecursive(tempDir);
            } catch (e) {
                console.error('Final error cleaning up:', e);
            }
        }
    }
}

// Function invocation endpoint
app.all('/invoke/:route', async (req, res) => {
    try {
        const func = await Function.findOne({ route: req.params.route });
        if (!func) return res.status(404).json({ error: 'Function not found' });

        const { output, duration } = await executeFunction(func, req);

        res.json({
            result: output,
            metadata: {
                executionTime: duration,
                functionName: func.name
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});