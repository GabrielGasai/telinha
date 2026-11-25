// Salas P2P. O "aperto de mão" inicial entre os PCs usa relays públicos do Nostr
// (via Trystero), então ninguém precisa hospedar servidor. Depois disso, vídeo e
// áudio vão direto de um PC para o outro (WebRTC), criptografados.
import { joinRoom, selfId } from 'trystero/nostr'
import { APP_ID, ICE_SERVERS } from './config.js'

// Código da sala: 4 números (1000 a 9999). O 0000 fica reservado para testes.
export function createCode() {
  return String(Math.floor(1000 + Math.random() * 9000))
}

// Aceita "7342", " 73 42 ", "7342." etc. e devolve "7342".
export function normalizeCode(raw) {
  const digits = String(raw || '').replace(/\D/g, '')
  return /^\d{4}$/.test(digits) ? digits : null
}

// Relays públicos usados só para os PCs se acharem (testados e estáveis).
// Quanto mais, maior a chance de os dois PCs alcançarem pelo menos um em comum.
const RELAYS = [
  'wss://nos.lol',
  'wss://relay.damus.io',
  'wss://relay.primal.net',
  'wss://offchain.pub',
  'wss://nostr.mom',
  'wss://relay.snort.social',
  'wss://nostr.data.haus',
]

export function openRoom(code) {
  const id = code.replace('-', '')
  const room = joinRoom(
    {
      appId: APP_ID,
      password: `telinha:${id}`,
      rtcConfig: { iceServers: ICE_SERVERS },
      relayUrls: RELAYS,
      relayRedundancy: RELAYS.length,
    },
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
