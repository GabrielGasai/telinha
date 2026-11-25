// Identificador do app: só quem usa o mesmo APP_ID se encontra nas salas.
export const APP_ID = 'telinha-p2p-v1'

// Servidores STUN públicos e gratuitos: ajudam os PCs a se acharem pela internet.
// Nenhum vídeo ou áudio passa por eles.
export const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
]

// Servidor de retransmissão (TURN), usado SÓ quando a conexão direta entre os PCs
// é bloqueada (CGNAT de operadora, 4G, redes de empresa). Usa o Open Relay da
// Metered. Cole aqui o link de credenciais do painel da Metered — ele termina
// com "?apiKey=...". Vazio = sem retransmissão.
export const TURN_CREDENTIALS_URL = ''

// Bitrate de vídeo (kbps) por resolução, a 30 fps priorizando nitidez.
// Texto e cores na tela precisam de bastante taxa para não borrar.
export const VIDEO_KBPS = { 720: 3500, 1080: 7000, 1440: 11000 }
export const MAX_KBPS = 14000
export const CAMERA_KBPS = 600
