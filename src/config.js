// Identificador do app: só quem usa o mesmo APP_ID se encontra nas salas.
export const APP_ID = 'telinha-p2p-v1'

// Servidores STUN públicos e gratuitos: ajudam os PCs a se acharem pela internet.
// Nenhum vídeo ou áudio passa por eles.
export const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  // Se algum amigo não conseguir conectar (algumas redes 4G e operadoras bloqueiam
  // conexão direta), dá para adicionar um servidor TURN aqui, por exemplo:
  // { urls: 'turn:SEU-SERVIDOR:3478', username: 'usuario', credential: 'senha' },
]

// Bitrate de vídeo (kbps) por resolução, a 30 fps priorizando nitidez.
// Texto e cores na tela precisam de bastante taxa para não borrar.
export const VIDEO_KBPS = { 720: 3500, 1080: 7000, 1440: 11000 }
export const MAX_KBPS = 14000
export const CAMERA_KBPS = 600
