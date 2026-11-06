// Downloads SFace (OpenCV model zoo, Apache 2.0), the face recognition model the passport face match
// uses, to vendor/face/, and checks it's the expected file. Run once per install: npm run models:download
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const URL = 'https://huggingface.co/opencv/face_recognition_sface/resolve/main/face_recognition_sface_2021dec.onnx';
const SHA256 = '0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79';
const target = process.env.FACE_MODEL_PATH || path.join(__dirname, '..', 'vendor', 'face', 'face_recognition_sface_2021dec.onnx');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

(async () => {
    if (fs.existsSync(target) && sha256(fs.readFileSync(target)) === SHA256) {
        console.log(`Already there: ${target}`);
        return;
    }
    console.log(`Downloading ${URL}`);
    const res = await fetch(URL, {redirect: 'follow'});
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (sha256(buf) !== SHA256) throw new Error('the download is not the expected file (SHA-256 differs)');
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, buf);
    console.log(`Saved ${target} (${(buf.length / 1e6).toFixed(1)} MB)`);
})().catch((err) => {
    console.error('Face model download failed:', err.message);
    process.exit(1);
});
