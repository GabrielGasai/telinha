// Salas P2P. O "aperto de mão" inicial entre os PCs usa relays públicos do Nostr
// (via Trystero), então ninguém precisa hospedar servidor. Depois disso, vídeo e
// áudio vão direto de um PC para o outro (WebRTC), criptografados.
import { joinRoom, selfId } from 'trystero/nostr'
import { APP_ID, ICE_SERVERS } from './config.js'

const WORDS = [
  'LOBO', 'ONCA', 'TATU', 'SAPO', 'GATO', 'URSO', 'PATO', 'BODE', 'GALO', 'PUMA',
  'FOCA', 'ORCA', 'LULA', 'MICO', 'BOTO', 'ZEBU', 'ARARA', 'COBRA', 'TUCANO', 'CORUJA',
]

export function createCode() {
  const word = WORDS[Math.floor(Math.random() * WORDS.length)]
  const num = String(Math.floor(1000 + Math.random() * 9000))
  return `${word}-${num}`
}

// Aceita "lobo 7342", "LOBO-7342", "lobo7342"... e devolve "LOBO-7342".
export function normalizeCode(raw) {
  const clean = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  const m = clean.match(/^([A-Z]{3,8})(\d{4})$/)
  return m ? `${m[1]}-${m[2]}` : null
}

export function openRoom(code) {
  const id = code.replace('-', '')
  const room = joinRoom(
    { appId: APP_ID, password: `telinha:${id}`, rtcConfig: { iceServers: ICE_SERVERS } },
    id,
  )
  // Cada pessoa avisa as outras: nome, se está compartilhando e se a câmera está ligada.
  const [sendState, onState] = room.makeAction('state')
  // Mensagens do chat da sala.
  const [sendChat, onChat] = room.makeAction('chat')
  // Imagens do chat (enviadas como bytes, direto entre os PCs).
  const [sendImg, onImg] = room.makeAction('img')
  return { room, selfId, sendState, onState, sendChat, onChat, sendImg, onImg }
}
