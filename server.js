const express  = require('express');
const multer   = require('multer');
const cors     = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 }   = require('uuid');
const path     = require('path');
const fs       = require('fs');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Supabase ──
const SUPABASE_URL  = process.env.SUPABASE_URL  || 'https://gvyjxpwtmhwkvspmxylo.supabase.co';
const SUPABASE_KEY  = process.env.SUPABASE_KEY  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd2eWp4cHd0bWh3a3ZzcG14eWxvIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MTIxMDA2NywiZXhwIjoyMDk2Nzg2MDY3fQ.fC5Tuv0sFvR4kD5giYduITEwOxhAgp_zfa_ct3m41zU';
const BUCKET       = 'beamit-files';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

app.use(cors());
app.use(express.json());

// ── Multer: temp disk storage ──
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename:    (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// ── Code generator (no O,0,I,1,L) ──
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function generateCode() {
  let c = '';
  for (let i = 0; i < 5; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return c;
}
async function uniqueCode() {
  let code, exists = true;
  while (exists) {
    code = generateCode();
    const { data } = await supabase.from('transfers').select('code').eq('code', code).single();
    exists = !!data;
  }
  return code;
}

// ── Cleanup temp file ──
function cleanTemp(filePath) {
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
}

// ═══════════════════════
//  ROUTES
// ═══════════════════════

// Health
app.get('/api/health', async (req, res) => {
  const { count } = await supabase.from('transfers').select('*', { count: 'exact', head: true });
  res.json({ status: 'ok', transfers: count || 0 });
});

// ── UPLOAD ──
app.post('/api/upload', upload.array('files', 20), async (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: 'No files uploaded.' });

  const totalSize = req.files.reduce((s, f) => s + f.size, 0);
  if (totalSize > 50 * 1024 * 1024) {
    req.files.forEach(f => cleanTemp(f.path));
    return res.status(413).json({ error: 'Total size exceeds 100 MB.' });
  }

  try {
    const code    = await uniqueCode();
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const fileRows = [];

    // Upload each file to Supabase Storage
    for (const f of req.files) {
      const fileId     = uuidv4();
      const storagePath = `${code}/${fileId}${path.extname(f.originalname)}`;
      const fileBuffer  = fs.readFileSync(f.path);

      const { error: upErr } = await supabase.storage
        .from(BUCKET)
        .upload(storagePath, fileBuffer, { contentType: f.mimetype, upsert: false });

      cleanTemp(f.path);
      if (upErr) throw new Error(`Storage upload failed: ${upErr.message}`);

      fileRows.push({
        id:           fileId,
        original_name: f.originalname,
        size:         f.size,
        mimetype:     f.mimetype,
        storage_path: storagePath
      });
    }

    // Save transfer record
    const { error: dbErr } = await supabase.from('transfers').insert({
      code,
      expires_at: expires,
      files: fileRows
    });
    if (dbErr) throw new Error(`DB insert failed: ${dbErr.message}`);

    console.log(`✓ Transfer ${code} — ${req.files.length} file(s)`);

    res.json({
      code,
      expires: new Date(expires).getTime(),
      files: fileRows.map(({ id, original_name, size, mimetype }) => ({
        id, originalName: original_name, size, mimetype
      }))
    });

  } catch (err) {
    req.files?.forEach(f => cleanTemp(f.path));
    console.error('Upload error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── LOOKUP ──
app.get('/api/transfer/:code', async (req, res) => {
  const code = req.params.code.toUpperCase().trim();

  const { data, error } = await supabase
    .from('transfers')
    .select('*')
    .eq('code', code)
    .single();

  if (error || !data) return res.status(404).json({ error: 'Code not found or expired.' });
  if (new Date(data.expires_at) < new Date()) {
    // Delete storage files
    const paths = data.files.map(f => f.storage_path);
    await supabase.storage.from(BUCKET).remove(paths);
    await supabase.from('transfers').delete().eq('code', code);
    return res.status(404).json({ error: 'Transfer expired.' });
  }

  res.json({
    code,
    expires: new Date(data.expires_at).getTime(),
    files: data.files.map(f => ({
      id: f.id,
      originalName: f.original_name,
      size: f.size,
      mimetype: f.mimetype
    }))
  });
});

// ── DOWNLOAD ──
app.get('/api/download/:code/:fileId', async (req, res) => {
  const code   = req.params.code.toUpperCase().trim();
  const fileId = req.params.fileId;

  const { data, error } = await supabase
    .from('transfers')
    .select('*')
    .eq('code', code)
    .single();

  if (error || !data) return res.status(404).json({ error: 'Not found.' });
  if (new Date(data.expires_at) < new Date()) return res.status(404).json({ error: 'Expired.' });

  const file = data.files.find(f => f.id === fileId);
  if (!file) return res.status(404).json({ error: 'File not found.' });

  // Stream file directly from Supabase storage
  const { data: fileData, error: downErr } = await supabase.storage
    .from(BUCKET)
    .download(file.storage_path);

  if (downErr || !fileData) {
    console.error('Download error:', downErr?.message);
    return res.status(500).json({ error: 'Could not retrieve file from storage.' });
  }

  const buffer = Buffer.from(await fileData.arrayBuffer());
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.original_name)}"`);
  res.setHeader('Content-Type', file.mimetype || 'application/octet-stream');
  res.setHeader('Content-Length', buffer.length);
  res.send(buffer);
});

app.listen(PORT, () => console.log(`BeamIt v2 running on port ${PORT}`));
