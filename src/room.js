// Salas P2P. O "aperto de mão" inicial entre os PCs usa relays públicos do Nostr
// (via Trystero), então ninguém precisa hospedar servidor. Depois disso, vídeo e
// áudio vão direto de um PC para o outro (WebRTC), criptografados.
import { joinRoom, selfId, getRelaySockets } from 'trystero/nostr'
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

// Relays públicos usados só para os PCs se acharem. Testados: aceitam as mensagens
// do app sem cadastro e sem limite agressivo por endereço de internet.
// Quanto mais, maior a chance de os dois PCs alcançarem pelo menos um em comum.
export const RELAYS = [
  'wss://relay.primal.net',
  'wss://relay.snort.social',
  'wss://nostr.bitcoiner.social',
  'wss://relay.nostr.net',
  'wss://relay.nostrcheck.me',
  'wss://relay.illuminodes.com',
  'wss://nostr.data.haus',
  'wss://nostr.oxtr.dev',
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

// Quantos servidores de encontro estão conectados agora (para mostrar na tela).
export function relayStatus() {
  const socks = Object.values(getRelaySockets?.() || {})
  return { open: socks.filter((w) => w.readyState === 1).length, total: RELAYS.length }
}
