import { Boom } from '@hapi/boom'
import Baileys, {
  DisconnectReason,
  delay,
  useMultiFileAuthState
} from '@whiskeysockets/baileys'
import cors from 'cors'
import express from 'express'
import fs from 'fs'
import PastebinAPI from 'pastebin-js'
import path, { dirname } from 'path'
import pino from 'pino'
import { fileURLToPath } from 'url'

const pastebin = new PastebinAPI('EMWTMkQAVfJa9kM-MRUrxd5Oku1U7pgL')
const app = express()

app.use(cors())
app.use(express.json())

const PORT = process.env.PORT || 8000
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

let sessionFolder = './auth/session'

async function deleteSessionFolder() {
  if (fs.existsSync(sessionFolder)) {
    fs.rmSync(sessionFolder, { recursive: true, force: true })
    console.log('✅ Session folder deleted.')
  }
}

let sock = null
async function startBaileys(phone = null) {
  if (!fs.existsSync(sessionFolder)) fs.mkdirSync(sessionFolder, { recursive: true })

  const { state, saveCreds } = await useMultiFileAuthState(sessionFolder)

  sock = Baileys.makeWASocket({
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
      console.log('Pastebin Session URL:', pasteUrl)
    }

    if (connection === 'close') {
      let reason = new Boom(lastDisconnect?.error)?.output.statusCode
      console.log(`❌ Connection Closed, reason: ${reason}`)

      switch (reason) {
        case DisconnectReason.connectionClosed:
        case DisconnectReason.connectionLost:
        case DisconnectReason.connectionReplaced:
        case DisconnectReason.timedOut:
        case DisconnectReason.badSession:
        case DisconnectReason.restartRequired:
          console.log('🔄 Attempting Reconnection...')
          await delay(3000)
          startBaileys()
          break
        case DisconnectReason.loggedOut:
          console.log('⚠️ Logged out from WhatsApp, deleting session folder...')
          await deleteSessionFolder()
          break
        default:
          console.log('❌ Unknown Disconnect Reason, retrying...')
          await delay(5000)
          startBaileys()
      }
    }
  })

  if (!sock.authState.creds.registered && phone) {
    try {
      const code = await sock.requestPairingCode(phone)
      console.log(`📲 Pairing Code: ${code}`)
      return code
    } catch (error) {
      throw new Error(`❌ Failed requesting pairing code: ${error.message}`)
    }
  }
}

// Load existing session on startup
if (fs.existsSync(sessionFolder)) startBaileys()

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'))
})

app.get('/pair', async (req, res) => {
  const phone = req.query.phone?.replace(/\D/g, '')
  if (!phone || phone.length < 11) {
    return res.status(400).json({ error: 'Invalid phone number' })
  }

  try {
    const code = await startBaileys(phone)
    if (code) {
      res.json({ code })
    } else {
      res.json({ message: 'Already paired & active.' })
    }
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`)
})
