const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
app.use(cors());

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2 GB
  fileFilter: (req, file, cb) => {
    const isMp4 =
      file.mimetype === 'video/mp4' ||
      path.extname(file.originalname).toLowerCase() === '.mp4';
    if (!isMp4) {
      return cb(new Error('Only MP4 files are allowed.'));
    }
    cb(null, true);
  }
});

app.use(express.static(path.join(__dirname)));

function safeUnlink(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    // ignore cleanup errors
  }
}

const jobs = new Map();
const JOB_TTL_MS = 60 * 60 * 1000;

function clampPercent(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function parseDurationToSeconds(duration) {
  if (!duration || typeof duration !== 'string') return null;
  const parts = duration.split(':');
  if (parts.length !== 3) return null;
  const [hours, minutes, seconds] = parts.map(Number);
  if (![hours, minutes, seconds].every(Number.isFinite)) return null;
  return (hours * 3600) + (minutes * 60) + seconds;
}

function parseTimemarkToSeconds(timemark) {
  if (!timemark || typeof timemark !== 'string') return null;
  const parts = timemark.split(':');
  if (parts.length !== 3) return null;
  const [hours, minutes, secStr] = parts;
  const h = Number(hours);
  const m = Number(minutes);
  const s = Number(secStr);
  if (![h, m, s].every(Number.isFinite)) return null;
  return (h * 3600) + (m * 60) + s;
}

function formatError(err, ffmpegStderr) {
  const tail = ffmpegStderr.join('\n').trim();
  if (tail) return `Conversion failed:\n${tail}`;
  return err && err.message ? err.message : 'Conversion failed';
}

function cleanupJobFiles(job) {
  if (!job) return;
  safeUnlink(job.inputPath);
  if (job.status !== 'completed') {
    safeUnlink(job.outputPath);
  }
}

function updateJob(jobId, patch) {
  const existing = jobs.get(jobId);
  if (!existing) return;
  jobs.set(jobId, { ...existing, ...patch, updatedAt: Date.now() });
}

app.post('/convert/start', upload.single('video'), (req, res) => {
  if (!req.file) {
    return res.status(400).send('No file uploaded.');
  }

  const jobId = crypto.randomUUID();
  const inputPath = req.file.path;
  const outputPath = `${inputPath}.amv`;
  const ffmpegStderr = [];
  let durationSeconds = null;

  jobs.set(jobId, {
    id: jobId,
    status: 'queued',
    progress: 0,
    message: 'Queued for conversion.',
    inputPath,
    outputPath,
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now()
  });

  res.status(202).json({ jobId });

  ffmpeg(inputPath)
    .videoCodec('amv')
    .audioCodec('adpcm_ima_amv')
    .outputOptions([
      '-vf', 'scale=160:128:force_original_aspect_ratio=decrease,pad=160:128:(ow-iw)/2:(oh-ih)/2:black,setsar=1',
      '-r', '15',
      '-ac', '1',
      '-ar', '22050',
      '-b:a', '64k',
      '-b:v', '128k',
      '-block_size', '1470',
      '-pix_fmt', 'yuvj420p'
    ])
    .format('amv')
    .on('start', (commandLine) => {
      console.log('FFmpeg command:', commandLine);
      updateJob(jobId, {
        status: 'processing',
        progress: 1,
        message: 'Conversion started.'
      });
    })
    .on('codecData', (data) => {
      durationSeconds = parseDurationToSeconds(data.duration);
    })
    .on('progress', (progress) => {
      let percent = Number(progress.percent);
      if (!Number.isFinite(percent) && durationSeconds) {
        const currentSeconds = parseTimemarkToSeconds(progress.timemark);
        if (currentSeconds !== null && durationSeconds > 0) {
          percent = (currentSeconds / durationSeconds) * 100;
        }
      }

      if (Number.isFinite(percent)) {
        updateJob(jobId, {
          status: 'processing',
          progress: Math.min(99, clampPercent(percent)),
          message: 'Converting video...'
        });
      }
    })
    .on('stderr', (line) => {
      ffmpegStderr.push(line);
      if (ffmpegStderr.length > 30) {
        ffmpegStderr.shift();
      }
    })
    .on('end', () => {
      updateJob(jobId, {
        status: 'completed',
        progress: 100,
        message: 'Conversion complete.'
      });
    })
    .on('error', (err) => {
      console.error(err);
      updateJob(jobId, {
        status: 'error',
        progress: 0,
        message: 'Conversion failed.',
        error: formatError(err, ffmpegStderr)
      });
      cleanupJobFiles(jobs.get(jobId));
    })
    .save(outputPath);
});

app.get('/convert/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found.' });
  }

  return res.json({
    id: job.id,
    status: job.status,
    progress: job.progress,
    message: job.message,
    error: job.error,
    downloadUrl: job.status === 'completed' ? `/convert/download/${job.id}` : null
  });
});

app.get('/convert/download/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).send('Job not found.');
  }
  if (job.status !== 'completed') {
    return res.status(409).send('Conversion is not complete yet.');
  }
  if (!fs.existsSync(job.outputPath)) {
    return res.status(410).send('Converted file is no longer available.');
  }

  res.download(job.outputPath, 'converted.amv', (err) => {
    if (err) {
      console.error(err);
      return;
    }
    cleanupJobFiles(job);
    jobs.delete(job.id);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [jobId, job] of jobs.entries()) {
    if ((now - job.updatedAt) > JOB_TTL_MS) {
      cleanupJobFiles(job);
      jobs.delete(jobId);
    }
  }
}, 5 * 60 * 1000).unref();

app.use((err, req, res, next) => {
  if (err && err.message) {
    return res.status(400).send(err.message);
  }
  next(err);
});

app.listen(3000, () => console.log('Server running on port 3000'));
