import { Boom } from '@hapi/boom'
import Baileys, {
  DisconnectReason,
  useMultiFileAuthState,
  delay
} from '@whiskeysockets/baileys'
import cors from 'cors'
import express from 'express'
import fs from 'fs'
import PastebinAPI from 'pastebin-js'
import path, { dirname } from 'path'
import pino from 'pino'
import { fileURLToPath } from 'url'
import multer from 'multer'

const pastebin = new PastebinAPI('EMWTMkQAVfJa9kM-MRUrxd5Oku1U7pgL')
const app = express()

app.use(cors())
app.use(express.static('public'))

const PORT = process.env.PORT || 8000
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const storage = multer.diskStorage({
  destination: 'public/uploads/',
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname)
  }
})
const upload = multer({ storage })

const sessionFolder = './auth/session'

async function startBaileys(phone) {
  if (!fs.existsSync(sessionFolder)) {
    fs.mkdirSync(sessionFolder, { recursive: true })
  }

  const { state, saveCreds } = await useMultiFileAuthState(sessionFolder)

  const sock = Baileys.makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: ['Ubuntu', 'Chrome', '20.0.04']
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      console.log('✅ WhatsApp Connected!')
      const pasteUrl = await pastebin.createPasteFromFile(
        `${sessionFolder}/creds.json`,
        'Guru Session',
        null,
        1,
        'N'
      )
      console.log('Pastebin Session:', pasteUrl)
    }

    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output.statusCode
      console.log('Connection closed:', reason)
      if (reason === DisconnectReason.loggedOut) {
        fs.rmSync(sessionFolder, { recursive: true })
        console.log('Logged out. Session deleted.')
      } else {
        await delay(5000)
        startBaileys(phone)
      }
    }
  })

  return sock
}

// Initial load session (if exists)
let sock
if (fs.existsSync(sessionFolder)) {
  sock = await startBaileys()
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'))
})

// Request pairing code
app.get('/pair', async (req, res) => {
  const phone = req.query.phone?.replace(/\D/g, '')

  if (!phone || phone.length < 11) {
    return res.status(400).json({ error: 'Invalid phone number' })
  }

  if (!sock || !sock.authState.creds.registered) {
    sock = await startBaileys(phone)
    try {
      const code = await sock.requestPairingCode(phone)
      res.json({ code })
    } catch (e) {
      res.status(500).json({ error: 'Failed to generate code' })
    }
  } else {
    res.status(200).json({ message: 'Already paired' })
  }
})

// 📥 Send Message from TXT upload
app.post('/send', upload.single('file'), async (req, res) => {
  if (!sock) {
    return res.status(400).send('WhatsApp is not connected yet.')
  }

  const fileContent = fs.readFileSync(req.file.path, 'utf-8').trim()
  const lines = fileContent.split('\n')

  const results = []
  for (let line of lines) {
    const [num, msg] = line.split('|')
    if (num && msg) {
      try {
        await sock.sendMessage(`${num}@s.whatsapp.net`, { text: msg })
        results.push({ num, status: '✅ Sent' })
      } catch (e) {
        results.push({ num, status: '❌ Failed', error: e.message })
      }
      await delay(1500)
    } else {
      results.push({ line, status: '❌ Invalid format' })
    }
  }

  fs.unlinkSync(req.file.path)
  res.json(results)
})

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`)
})
