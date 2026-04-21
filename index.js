import makeWASocket, {
    useMultiFileAuthState,
    generateWAMessageFromContent,
    downloadMediaMessage,
    prepareWAMessageMedia,
    fetchLatestBaileysVersion,
    Browsers,
    DisconnectReason
} from "@whiskeysockets/baileys"
import { pino } from 'pino'
import qrcode from 'qrcode-terminal'
import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import archiver from 'archiver'
import { Boom } from '@hapi/boom'

function copyDir(src, dest) {
    fs.mkdirSync(dest, { recursive: true })
    for (const item of fs.readdirSync(src, { withFileTypes: true })) {
        const from = path.join(src, item.name)
        const to = path.join(dest, item.name)
        if (item.isDirectory()) copyDir(from, to)
        else fs.copyFileSync(from, to)
    }
}

function replaceBase64Image(jsonPath, dataUri) {
    const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
    if (!Array.isArray(json.assets)) throw new Error('JSON sin assets.')

    const asset = json.assets.find(a => typeof a?.p === 'string' && a.p.startsWith('data:image/'))
    if (!asset) throw new Error('No se encontró una imagen base64 en el Lottie.')

    asset.p = dataUri
    fs.writeFileSync(jsonPath, JSON.stringify(json))
}

function zipFolderToWas(folder, output) {
    return new Promise((resolve, reject) => {
        if (fs.existsSync(output)) fs.unlinkSync(output)
        const out = fs.createWriteStream(output)
        const archive = archiver('zip', { zlib: { level: 9 } })
        out.on('close', () => resolve(output))
        archive.on('error', reject)
        archive.pipe(out)
        archive.directory(folder, false)
        archive.finalize()
    })
}

async function buildLottieSticker(imageBuffer, mimeType) {
    const baseFolder = path.resolve('./plantilla')
    const output = path.resolve('./output_sticker.was')
    const jsonRelativePath = 'animation/animation_secondary.json'

    if (!fs.existsSync(baseFolder)) throw new Error('baseFolder no encontrado.')
    if (!mimeType) throw new Error('Mime no detectado.')

    const dataUri = `data:${mimeType};base64,${imageBuffer.toString('base64')}`
    const temp = path.join(os.tmpdir(), `lottie-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`)

    try {
        copyDir(baseFolder, temp)
        replaceBase64Image(path.join(temp, jsonRelativePath), dataUri)
        await zipFolderToWas(temp, output)
        return fs.readFileSync(output)
    } finally {
        fs.rmSync(temp, { recursive: true, force: true })
    }
}

async function startBot() {
    console.log('🔄 Iniciando bot...')
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys')
    const { version } = await fetchLatestBaileysVersion()

    const conn = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Desktop')
    })

    conn.ev.on('creds.update', saveCreds)

    conn.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update
        if (qr) {
            console.log('✨ Escanea este QR:')
            qrcode.generate(qr, { small: true })
        }
        if (connection === 'open') console.log('✅ BOT CONECTADO. Envía una imagen AHORA.')
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom)
                ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut
                : true
            if (shouldReconnect) startBot()
        }
    })

    conn.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0]
        if (!m.message) return

        console.log('📩 Mensaje recibido de:', m.key.remoteJid)

        const messageType = Object.keys(m.message)[0]
        const imageMessage = m.message.imageMessage
            || m.message.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage

        if (imageMessage || messageType === 'imageMessage') {
            const img = imageMessage || m.message.imageMessage
            console.log('🖼️ ¡Imagen detectada! Iniciando proceso...')

            try {
                const buffer = await downloadMediaMessage(m, 'buffer', {})
                console.log('📥 Imagen descargada (Tamaño:', buffer.length, 'bytes)')

                const wasBuffer = await buildLottieSticker(buffer, img.mimetype)
                console.log('📦 Archivo .was generado (', wasBuffer.length, 'bytes)')

                const upload = await prepareWAMessageMedia(
                    { sticker: wasBuffer, mimetype: 'application/was' },
                    { upload: conn.waUploadToServer }
                )

                const msg = generateWAMessageFromContent(m.key.remoteJid, {
                    stickerMessage: {
                        url: upload.stickerMessage.url,
                        directPath: upload.stickerMessage.directPath,
                        fileSha256: upload.stickerMessage.fileSha256,
                        fileEncSha256: upload.stickerMessage.fileEncSha256,
                        mediaKey: upload.stickerMessage.mediaKey,
                        fileLength: upload.stickerMessage.fileLength,
                        mimetype: 'application/was',
                        isAnimated: true,
                        isLottie: true,
                        height: 9999,
                        width: 9999
                    }
                }, { userJid: conn.user.id })

                await conn.relayMessage(m.key.remoteJid, msg.message, { messageId: msg.key.id })
                console.log('🚀 STICKER GIGANTE ENVIADO CON ÉXITO')
            } catch (error) {
                console.error('❌ ERROR CRÍTICO:', error)
            }
        } else {
            console.log('ℹ️ Mensaje ignorado (no es imagen). Tipo:', messageType)
        }
    })
}

startBot()
